import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const enabled = process.env.BEAUTICODE_BROWSER_TESTS === '1';
const token = 'a'.repeat(32);

function pkg(scene) {
  const magic = Buffer.from('PKGV0012'), name = Buffer.from('scene.json');
  const data = Buffer.from(JSON.stringify(scene));
  const output = Buffer.alloc(4 + magic.length + 4 + 4 + name.length + 8 + data.length);
  let offset = 0;
  const u32 = value => { output.writeUInt32LE(value, offset); offset += 4; };
  u32(magic.length); magic.copy(output, offset); offset += magic.length;
  u32(1); u32(name.length); name.copy(output, offset); offset += name.length;
  u32(0); u32(data.length); data.copy(output, offset);
  return output;
}

async function fixture(t, scene) {
  const require = createRequire(import.meta.url);
  let playwright;
  try { playwright = require('playwright'); }
  catch { playwright = require(path.join(process.env.USERPROFILE || process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  let bundle = await readFile(new URL('../dist/scene-frame.js', import.meta.url));
  if (process.env.BEAUTICODE_BROWSER_DEBUG) {
    const esbuild = await import('esbuild');
    const debug = await esbuild.build({
      entryPoints: [new URL('../frame.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
      bundle: true, format: 'iife', platform: 'browser', write: false,
      plugins: [{ name: 'fixture-diagnostics', setup(builder) {
        builder.onLoad({ filter: /[\\/]scene-renderer[\\/]runtime\.js$/ }, async ({ path: source }) => {
          let contents = await readFile(source, 'utf8');
          contents = contents.replace("onDiagnostic: (_message, level) => { if (level === 'error') fatal('SCENE_RENDER_FAILED'); },", "onDiagnostic: (message, level) => { console.log('ENGINE', level, message); if (level === 'error') fatal('SCENE_RENDER_FAILED'); },");
          contents = contents.replace("onError: () => fatal('SCENE_RENDER_FAILED'),", "onError: error => { console.error('ENGINE ERROR', error); fatal('SCENE_RENDER_FAILED'); },");
          contents = contents.replace("}).catch(() => fatal('SCENE_MOUNT_FAILED'));", "}).catch(error => { console.error('MOUNT ERROR', error); fatal('SCENE_MOUNT_FAILED'); });");
          return { contents, loader: 'js' };
        });
      } }],
    });
    bundle = debug.outputFiles[0].contents;
  }
  const player = await readFile(new URL('../player.js', import.meta.url));
  const bytes = pkg(scene), requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<div id="slot" style="width:128px;height:128px"><span id="previous">previous</span></div><script src="/player.js"></script>'); }
    else if (req.url === '/player.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(player); }
    else if (req.url === `/scene/${token}/scene-frame.js?t=${token}`) { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); }
    else if (req.url === `/scene/${token}/scene.pkg?t=${token}`) { res.setHeader('Content-Type', 'application/octet-stream'); res.end(bytes); }
    else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await playwright.chromium.launch({
    executablePath: process.env.BEAUTICODE_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
    headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ deviceScaleFactor: 1.5 });
  if (process.env.BEAUTICODE_BROWSER_DEBUG) {
    page.on('console', message => console.log(message.type(), message.text()));
    page.on('pageerror', error => console.log(error.message));
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  if (process.env.BEAUTICODE_BROWSER_DEBUG) await page.evaluate(() => {
    const Channel = MessageChannel;
    globalThis.MessageChannel = class extends Channel {
      constructor() { super(); this.port1.addEventListener('message', event => console.log('FRAME', JSON.stringify(event.data))); }
    };
  });
  return { page, requests, config: {
    pkgUrl: `${origin}/scene/${token}/scene.pkg?t=${token}`,
    bundleUrl: `${origin}/scene/${token}/scene-frame.js?t=${token}`,
    project: { type: 'scene', file: 'scene.json' },
  } };
}

const basicScene = () => ({ general: { orthogonalprojection: { width: 128, height: 128 }, clearcolor: '0.1 0.2 0.3' }, objects: [] });

test('real WebWallGL produces an isolated first frame at native scale', { skip: !enabled, timeout: 30_000 }, async t => {
  const { page, config, requests } = await fixture(t, basicScene());
  await page.evaluate(async value => { globalThis.controller = await BeauticodeScenePlayer.mount(document.querySelector('#slot'), value, { timeoutMs: 15_000 }); }, config);
  const frame = page.frames().find(item => item.parentFrame());
  assert.ok(frame);
  const size = await frame.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return { width: canvas.width, height: canvas.height };
  });
  assert.deepEqual(size, { width: 192, height: 192 });
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await page.locator('#previous').count(), 1);
  assert.equal(requests.filter(url => url.includes('/scene/')).length, 2);
  await page.evaluate(() => controller.dispose());
  assert.equal(await page.locator('iframe').count(), 0);
});

test('a real scene containing SceneScript fails without executing it or deleting the old background', { skip: !enabled, timeout: 30_000 }, async t => {
  const scene = basicScene();
  scene.general.clearcolor = { value: '0.1 0.2 0.3', script: 'export function init(value) { globalThis.__shouldNotRun = true; return value; }' };
  const { page, config } = await fixture(t, scene);
  const result = await page.evaluate(async value => {
    try { await BeauticodeScenePlayer.mount(document.querySelector('#slot'), value, { timeoutMs: 15_000 }); return { outcome: 'unexpected ready' }; }
    catch (error) { return { outcome: error.message, frames: document.querySelectorAll('iframe').length, previous: !!document.querySelector('#previous') }; }
  }, config);
  assert.match(result.outcome, /scripts/i);
  assert.equal(result.frames, 0);
  assert.equal(result.previous, true);
});

test('real WebGL context loss marks the player failed and releases its frame', { skip: !enabled, timeout: 30_000 }, async t => {
  const { page, config } = await fixture(t, basicScene());
  await page.evaluate(async value => { globalThis.controller = await BeauticodeScenePlayer.mount(document.querySelector('#slot'), value, { timeoutMs: 15_000 }); }, config);
  const frame = page.frames().find(item => item.parentFrame());
  await frame.evaluate(() => setTimeout(() => document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost')), 50));
  await page.waitForFunction(() => controller.disposed && controller.error);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('#previous').count(), 1);
});

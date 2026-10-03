/** Browser regression for issues #78/#79. Uses an existing Playwright runtime. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const repo = path.resolve(import.meta.dirname, '..');
// Optional package directory also verifies the actual npm release candidate.
const pluginDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(repo, 'integrations/deepseek-harness');
const client = await fs.readFile(path.join(pluginDir, 'client.js'), 'utf8');
const atmosphere = await fs.readFile(path.join(pluginDir, 'atmosphere.js'), 'utf8');
const css = /style.textContent = `([\s\S]*?)`;/;
const clientCss = client.match(css)[1].replaceAll('${CROSSFADE_MS}', '180');
const galleryCss = atmosphere.match(css)[1];
const readablePath = path.join(pluginDir, 'readability.js');
const readable = await fs.readFile(readablePath, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // These contracts are from the shipped DSH 0.2.0-rc.2 settings and InputBar:
  // the settings portal reads bg-layer-2; the sticky card reads input-major.
  // Deliberately place body text behind both so translucency cannot hide in an
  // empty page. No real user conversation or media enters this fixture.
  await page.setContent(`<!doctype html><html data-bc-active="true"><head><style>
    body { --dsw-static-neutral-bluish-900:#171b23; --dsw-static-neutral-bluish-800:#232833;
      --dsw-static-neutral-bluish-50:#f8fafc; --dsw-static-neutral-bluish-00:#fff;
      --dsw-alias-bg-layer-2:#252935; --dsw-alias-bg-layer-3:#252935; --dsw-specific-input-major:#171b23;
      font:16px sans-serif; margin:0; }
    #wallpaper {position:fixed;inset:0;background:repeating-linear-gradient(45deg,#476,#476 30px,#ddc 30px,#ddc 60px)}
    #root {height:800px;color:#ddd} .transcript {padding:100px 200px;line-height:36px}
    [role=dialog] {position:fixed;z-index:1000;inset:100px 240px 200px;padding:36px;border-radius:20px;background:var(--dsw-alias-bg-layer-2)}
    [role=menu] {position:fixed;z-index:1001;right:10px;top:20px;padding:20px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3))}
    [data-composer-card] {position:fixed;z-index:10;bottom:30px;left:200px;right:200px;padding:24px;border-radius:20px;background:var(--dsw-specific-input-major)}
    ${clientCss}
  </style></head><body><div id=wallpaper></div><div id=root><div id=phase data-phase=hero>
    <div class=transcript>${'<p>Underlying conversation text must stay behind the functional panel.</p>'.repeat(15)}</div>
    <div data-composer-card><div data-composer-input role=textbox contenteditable=true>Draft message</div></div>
  </div></div><div role=dialog aria-modal=true><nav>Settings</nav><div data-slot="settings.section">General settings</div></div>
  <div role=menu>Menu item</div></body></html>`);
  if (readable) await page.addScriptTag({ content: readable });
  // Gallery installs a later stylesheet. Local surface rules must still win.
  await page.addStyleTag({ content: galleryCss });
  const results = [];
  for (const tone of ['dark', 'light']) {
    for (const phase of ['hero', 'active', 'settling', 'none']) {
      for (const dim of [false, true]) {
        for (const gallery of [false, true]) {
          await page.evaluate(({ tone, phase, dim, gallery }) => {
            const root = document.documentElement;
            root.dataset.bcResolvedTone = tone;
            root.dataset.bcDimUser = String(dim);
            root.dataset.bcGallery = String(gallery);
            document.querySelector('#phase').setAttribute('data-phase', phase);
          }, { tone, phase, dim, gallery });
          const surfaces = await page.evaluate(() => {
            const ctx = document.createElement('canvas').getContext('2d');
            return ['[role=dialog]', '[role=menu]', '[data-composer-card]'].map(selector => {
              const color = getComputedStyle(document.querySelector(selector)).backgroundColor;
              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, 1, 1);
              return { selector, color, alpha: ctx.getImageData(0, 0, 1, 1).data[3] };
            });
          });
          for (const surface of surfaces) assert.equal(surface.alpha, 255,
            `${JSON.stringify({ tone, phase, dim, gallery })} ${surface.selector} must hide text behind it: ${surface.color}`);
          results.push({ tone, phase, dim, gallery });
        }
      }
    }
  }
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.set(false));
  const optOut = await page.locator('[data-composer-card]').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.match(optOut, /(?:0\.36|36%)/, 'opt-out restores the original translucent composer');
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.set(true));
  await page.evaluate(() => {
    document.documentElement.dataset.bcActive = 'false';
    document.documentElement.dataset.bcGallery = 'false';
  });
  const inactive = await page.evaluate(() => ({
    dialog: getComputedStyle(document.querySelector('[role=dialog]')).backgroundColor,
    composer: getComputedStyle(document.querySelector('[data-composer-card]')).backgroundColor,
  }));
  assert.deepEqual(inactive, { dialog: 'rgb(37, 41, 53)', composer: 'rgb(23, 27, 35)' },
    'clearing the wallpaper restores the original host surfaces');
  await page.evaluate(() => { document.documentElement.dataset.bcActive = 'true'; });
  await fs.mkdir(path.join(repo, 'artifacts/issue-78-79'), { recursive: true });
  await page.screenshot({ path: path.join(repo, 'artifacts/issue-78-79/readability-after.png') });
  console.log(`PASS: ${results.length} tone/phase/shadow/gallery combinations; opt-out and wallpaper clear verified.`);
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function mockCdpPages() {
  let lists = 0;
  let dirty = 0;
  let dim = 49;
  const injected = new Set(['new']);
  const pages = [
    { id: 'old', type: 'page', url: 'doubaowork://doubaowork-chat/chat' },
    { id: 'new', type: 'page', url: 'doubaowork://doubaowork-launcher/chat' },
  ].map(page => ({ ...page, webSocketDebuggerUrl: 'ws://127.0.0.1:9346/devtools/page/' + page.id }));
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname !== '127.0.0.1' || url.port !== '9346') return new Response(null, { status: 404 });
    if (url.pathname === '/json/version') return Response.json({ Browser: 'Doubao Work fixture' });
    if (url.pathname === '/json/list') return Response.json(++lists === 1 ? pages.slice(0, 1) : pages);
    return new Response(null, { status: 404 });
  };
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;

    constructor(url) {
      super();
      this.page = new URL(url).pathname.split('/').at(-1);
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }

    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      let value;
      if (method === 'Runtime.evaluate') {
        const expression = params.expression;
        if (expression.includes('var CFG=')) {
          value = injected.has(this.page) ? 'already-installed' : 'ok';
          injected.add(this.page);
        }
        else if (expression.includes('anchorTextMatches:')) {
          value = { anchor: true, anchorTextMatches: true, entry: true, style: true, stage: true, dirty };
        } else if (expression.includes('document.visibilityState')) {
          // A change arrives in the old window after the tick's original snapshot.
          dirty = 1;
          dim = 87;
          value = this.page === 'old' ? 400 : 900;
        } else if (expression.includes('raw: window.__bcDesktopPersistGet')) value = { dirty, raw: JSON.stringify({ dim }) };
        else if (expression.includes("return 'cleaned'")) {
          injected.delete(this.page);
          value = 'cleaned';
        }
        else if (expression.startsWith('window.__bcDesktopRestoreState(') && this.page === 'new') {
          process.stdout.write(expression + '\n');
          value = true;
        } else throw new Error('Unexpected renderer command');
      }
      queueMicrotask(() => {
        const response = JSON.stringify({ id, result: value === undefined ? {} : { result: { value } } });
        this.dispatchEvent(new MessageEvent('message', { data: response }));
      });
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    }
  };
}

test('Doubao Work switches pages only after saving a change that arrives during measurement', { timeout: 15_000 }, async t => {
  const tmp = await fs.realpath(os.tmpdir());
  const home = await fs.mkdtemp(path.join(tmp, 'bc-page-switch-'));
  const loader = 'data:text/javascript;base64,' + Buffer.from('(' + mockCdpPages.toString() + ')()').toString('base64');
  const runner = fileURLToPath(new URL('../../../scripts/desktop-cdp-runner.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', loader, runner, '--host', 'doubaowork', '--no-repair'], {
    env: { ...process.env, LOCALAPPDATA: home, APPDATA: home },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000,
  });
  const done = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await done;
    assert.match(path.relative(tmp, home), /^bc-page-switch-[^/\\]+$/);
    await fs.rm(home, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const payload = await Promise.race([
    once(child.stdout, 'data').then(([bytes]) => String(bytes).trim()),
    done.then(() => assert.fail(stderr || 'The second page did not receive restored settings.')),
  ]);
  assert.equal(payload, 'window.__bcDesktopRestoreState({"dim":87})');
  const data = process.platform === 'linux' ? 'beautiCode' : 'beauticode';
  const saved = JSON.parse(await fs.readFile(path.join(home, data, 'hosts', 'doubaowork', 'state.json'), 'utf8'));
  assert.equal(saved.dim, 87);
});

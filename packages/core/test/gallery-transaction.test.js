import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import * as core from '../dist/index.js';

for (const family of ['desktop', 'workbuddy']) test(`${family} gallery serializes a failed rollback before the next successful install`, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bc-gallery-queue-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let server, port, downloads = 0, lastPart, rejectFirst, started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const firstGate = new Promise((_resolve, reject) => { rejectFirst = reject; });
  const skin = { id: 'skin-abcdefgh', sourceSkinId: 'skin-abcdefgh', type: 'video', name: 'fixture', source: 'hnnulwh', sourceVersion: '1' };
  const source = fs.readFileSync(new URL(family === 'desktop' ? '../../../scripts/desktop-cdp-runner.mjs' : '../../../scripts/wb-cdp-runner.mjs', import.meta.url), 'utf8');
  const name = family === 'desktop' ? 'startGallery' : 'startGalleryServer';
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(family === 'desktop' ? '\nasync function applyRuntime' : '\n// ── 完整应用序列', start);
  async function apply() { if (downloads === 1) { started(); await firstGate; } }
  const context = vm.createContext({
    URL, Buffer, fs, path, process, galleryServer: null, galleryPort: null, GALLERY_PORT_BASE: 9337,
    galleryToken: 'fixture', GALLERY_TOKEN: 'fixture', dataRoot: root, DATA_DIR: root,
    galleryConn: {}, activeConnection: {}, galleryApplyFn: null, pendingNameDiagnostic: null,
    enqueueGalleryApply: core.createSerialTaskQueue(), skinRegistry: new Map([[skin.id, skin]]), spec: { displayName: 'fixture' }, args: { host: 'cursor' }, log: { warn() {}, info() {} },
    isLoopbackHost: () => true, isAllowedOrigin: () => true, requestToken: req => req.headers['x-beauticode-media-token'],
    deny(res, status, error) { res.writeHead(status).end(JSON.stringify({ ok: false, error })); },
    setFileInput: apply, applyFn: apply, evaluate: async () => null,
    core: { ...core, async downloadApprovedAsset(_skin, part) {
      lastPart = part;
      downloads++;
      const tempDir = await fsp.mkdtemp(path.join(root, 'download-'));
      const filePath = path.join(tempDir, 'asset.png');
      await fsp.writeFile(filePath, `new-${downloads}`);
      return { tempDir, filePath };
    } },
    createServer(handler) {
      server = http.createServer(handler);
      return { once() { return this; }, listen(_port, host, callback) { server.listen(0, host, () => { port = server.address().port; callback(); }); } };
    },
  });
  await vm.runInContext(source.slice(start, end) + `\n${name}(applyFn)`, context);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const preview = await fetch(`http://127.0.0.1:${port}/media?id=${skin.id}`, { headers: { 'x-beauticode-media-token': 'fixture' } });
  await preview.arrayBuffer();
  assert.equal(lastPart, 'image', 'video catalog preview must request only its image');
  downloads = 0;
  const file = path.join(root, 'themes', skin.id + '.png');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'old-good');
  const request = () => fetch(`http://127.0.0.1:${port}/apply`, { method: 'POST', headers: { 'x-beauticode-media-token': 'fixture' }, body: JSON.stringify({ id: skin.id }) }).then(r => r.json());
  const first = request();
  await firstStarted;
  const second = request();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(downloads, 1, 'second transaction must wait for rollback');
  rejectFirst(new Error('fixture render failed'));
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, true);
  assert.equal(await fsp.readFile(file, 'utf8'), 'new-2');
  assert.equal(lastPart, 'video', 'explicit apply still downloads the video');
});

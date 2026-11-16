import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageBytes } from './fixtures/scene-package.js';

const api = await import('../dist/scene-server.js').catch(() => null);
const ORIGIN = 'chrome://doubaowork-chat';

async function fixture(t, bytes = packageBytes()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-scene-server-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  });
  const projectPath = path.join(root, 'project.json');
  const pkgPath = path.join(root, 'scene.pkg');
  await fs.writeFile(projectPath, JSON.stringify({ type: 'scene', file: 'scene.pkg', title: '测试' }));
  await fs.writeFile(pkgPath, bytes);
  return { root, projectPath, pkgPath, bytes };
}

function request(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('scene resource requires exact origin, loopback host, token and route', async (t) => {
  assert.equal(typeof api?.SceneResourceServer, 'function');
  assert.throws(() => new api.SceneResourceServer({ trustedOrigins: ['*'] }));
  assert.throws(() => new api.SceneResourceServer({ trustedOrigins: ['null'] }));
  assert.throws(() => new api.SceneResourceServer({ trustedOrigins: [] }));
  const f = await fixture(t);
  const server = new api.SceneResourceServer({ trustedOrigins: [ORIGIN] });
  t.after(() => server.close());
  const handle = await server.stage(f.projectPath);
  assert.match(handle.srcUrl, /^http:\/\/127\.0\.0\.1:\d+\/scene\/[a-f0-9]{32}\/scene\.pkg\?t=[a-f0-9]{32}$/);
  const ok = await request(handle.srcUrl, { Origin: ORIGIN });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
  assert.deepEqual(ok.body, f.bytes);
  assert.equal((await request(handle.srcUrl, { Origin: ORIGIN }, 'HEAD')).status, 200);
  assert.equal((await request(handle.srcUrl, { Origin: ORIGIN }, 'POST')).status, 405);
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://evil.invalid' }, { Origin: ORIGIN, Host: 'evil.invalid' }]) {
    assert.equal((await request(handle.srcUrl, headers)).status, 403);
  }
  assert.equal((await request(handle.srcUrl.replace(/t=.*/, 't=wrong'), { Origin: ORIGIN })).status, 403);
  assert.equal((await request(handle.srcUrl.replace('scene.pkg', '../project.json'), { Origin: ORIGIN })).status, 404);
  await handle.dispose();
  assert.equal((await request(handle.srcUrl, { Origin: ORIGIN })).status, 404);
});

test('scene staging is bounded and a failed candidate preserves the active resource', async (t) => {
  assert.equal(typeof api?.SceneResourceServer, 'function');
  const first = await fixture(t);
  const second = await fixture(t);
  const server = new api.SceneResourceServer({ trustedOrigins: [ORIGIN] });
  t.after(() => server.close());
  const active = await server.stage(first.projectPath);
  await assert.rejects(() => server.stage(second.projectPath), /staged|candidate/i);
  await server.commit(active);
  await assert.rejects(() => server.stage(path.join(first.root, 'missing.json')));
  assert.equal((await request(active.srcUrl, { Origin: ORIGIN })).status, 200);
  const candidate = await server.stage(second.projectPath);
  await server.commit(candidate);
  assert.equal((await request(active.srcUrl, { Origin: ORIGIN })).status, 404);
  assert.equal((await request(candidate.srcUrl, { Origin: ORIGIN })).status, 200);
  await fs.writeFile(second.pkgPath, packageBytes([{ name: 'scene.json', content: '{"changed":true}' }]));
  assert.equal((await request(candidate.srcUrl, { Origin: ORIGIN })).status, 404);
  await server.commit(null);
  assert.equal((await request(candidate.srcUrl, { Origin: ORIGIN })).status, 404);
});

test('cancelled transfers and server shutdown release resources', async (t) => {
  assert.equal(typeof api?.SceneResourceServer, 'function');
  const bytes = packageBytes([{ name: 'scene.json', content: '{}' }, { name: 'asset.bin', content: Buffer.alloc(8 * 1024 * 1024) }]);
  const f = await fixture(t, bytes);
  const server = new api.SceneResourceServer({ trustedOrigins: [ORIGIN] });
  t.after(() => server.close());
  const handle = await server.stage(f.projectPath);
  await new Promise((resolve, reject) => {
    const req = http.get(handle.srcUrl, { headers: { Origin: ORIGIN } }, (res) => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.on('error', reject);
  });
  await Promise.race([
    server.close(),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('shutdown timed out')), 3000); timer.unref(); }),
  ]);
  await assert.rejects(() => server.stage(f.projectPath));
  await fs.rename(f.pkgPath, `${f.pkgPath}.closed`);
});

test('shutdown waits for an in-progress scene preparation to stop', async (t) => {
  assert.equal(typeof api?.SceneResourceServer, 'function');
  const f = await fixture(t);
  const server = new api.SceneResourceServer({ trustedOrigins: [ORIGIN] });
  let settled = false;
  const staging = server.stage(f.projectPath).then(
    () => { settled = true; return 'ready'; },
    () => { settled = true; return 'stopped'; },
  );
  await server.close();
  assert.equal(settled, true);
  assert.equal(await staging, 'stopped');
  await fs.rename(f.pkgPath, `${f.pkgPath}.closed`);
});

test('transfers the validated bytes when the source changes after its final check', async (t) => {
  const f = await fixture(t);
  const server = new api.SceneResourceServer({ trustedOrigins: [ORIGIN] });
  t.after(() => server.close());
  const handle = await server.stage(f.projectPath);
  const original = fs.open;
  let mutated = false;
  fs.open = async (...args) => {
    const opened = await original(...args);
    const create = opened.createReadStream.bind(opened);
    opened.createReadStream = (...streamArgs) => {
      if (!mutated) { mutated = true; writeFileSync(f.pkgPath, Buffer.alloc(f.bytes.length, 0x78)); }
      return create(...streamArgs);
    };
    return opened;
  };
  try {
    const result = await request(handle.srcUrl, { Origin: ORIGIN });
    assert.equal(mutated, true, 'the source was changed at the start of transfer');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, f.bytes, 'only the verified snapshot can be sent');
  } finally { fs.open = original; }
});

test('disposing cancels and waits for an in-flight package validation', async (t) => {
  const bytes = packageBytes([{ name: 'scene.json', content: '{}' }, { name: 'asset.bin', content: Buffer.alloc(8 * 1024 * 1024) }]);
  const f = await fixture(t, bytes);
  const server = new api.SceneResourceServer({ trustedOrigins: [ORIGIN] });
  t.after(() => server.close());
  const handle = await server.stage(f.projectPath);
  const later = new Date(Date.now() + 10_000);
  await fs.utimes(f.pkgPath, later, later);
  let release, started, reads = 0, settled = false;
  const held = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const original = fs.open;
  fs.open = async (file, ...args) => {
    const opened = await original(file, ...args);
    if (file === f.pkgPath) {
      const read = opened.read.bind(opened);
      opened.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (++reads === 1) { started(); await held; }
        return result;
      };
    }
    return opened;
  };
  const req = http.get(handle.srcUrl, { headers: { Origin: ORIGIN } });
  req.on('error', () => {});
  try {
    await began;
    req.destroy();
    const disposing = handle.dispose().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const returnedEarly = settled;
    release();
    await disposing;
    await server.close();
    assert.equal(returnedEarly, false, 'dispose must wait for validation to release its file');
    assert.equal(reads, 1, 'cancellation must prevent the remaining package reads');
    await fs.rename(f.pkgPath, `${f.pkgPath}.cancelled`);
  } finally { release(); fs.open = original; req.destroy(); }
});

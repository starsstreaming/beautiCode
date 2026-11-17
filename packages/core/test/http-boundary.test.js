import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { guardHttpHandler, parseLocalRequestUrl, streamLocalFile } from '../dist/index.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('malformed targets and asynchronous errors do not stop the local HTTP service', async (t) => {
  const server = createServer(guardHttpHandler(async (req, res) => {
    const url = parseLocalRequestUrl(req, res);
    if (!url) return;
    if (url.pathname === '/fail') throw new Error('fixture');
    res.end('healthy');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  function get(target) {
    return new Promise((resolve, reject) => {
      request({ hostname: '127.0.0.1', port, path: target }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }).on('error', reject).end();
    });
  }
  assert.equal(await get('http://['), 400);
  assert.equal(await get('/\\example.com/fail'), 400);
  assert.equal(await get('/fail'), 500);
  assert.equal(await get('/health'), 200);
});

test('a missing local file leaves the response writable for an HTTP error', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-http-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = createServer(guardHttpHandler(async (_req, res) => {
    try { await streamLocalFile(path.join(root, 'missing.png'), res); }
    catch { res.writeHead(502).end('media unavailable'); }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'media unavailable');
});

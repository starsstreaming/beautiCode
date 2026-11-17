import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { guardHttpHandler, parseLocalRequestUrl } from '../dist/index.js';

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
  assert.equal(await get('/fail'), 500);
  assert.equal(await get('/health'), 200);
});

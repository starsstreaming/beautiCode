import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listApprovedSkins } from '../dist/index.js';

test('catalog redirects are rejected before the redirect target receives a request', async (t) => {
  let targetHits = 0;
  const target = createServer((_q, r) => { targetHits++; r.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const source = createServer((_q, r) => r.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/target` }).end());
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.all([source, target].map(s => new Promise(resolve => s.close(resolve)))); });
  await assert.rejects(listApprovedSkins({ fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${source.address().port}`, options) }));
  assert.equal(targetHits, 0);
});

for (const mode of ['header-limit', 'stream-limit', 'status']) test(`catalog cancels rejected body: ${mode}`, async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(2 * 1024 * 1024)); }, cancel() { cancelled = true; } });
  const response = new Response(stream, { status: mode === 'status' ? 503 : 200, headers: mode === 'header-limit' ? { 'content-length': '999999999' } : {} });
  await assert.rejects(listApprovedSkins({ fetchImpl: async () => response }));
  assert.equal(cancelled, true);
});

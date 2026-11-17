import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHealthRunner } from '../src/health.mjs';

test('desktop status and aggregate health retain renderer media evidence', async () => {
  const source = await fs.readFile(new URL('../../../scripts/desktop-cdp-setup.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function readCdpStatus()');
  const end = source.indexOf("\nif (args.command === 'status')", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end)
    .replace(/const shared = await import\([^\n]+\);/, 'const shared = fixtureShared;')
    .replace(/const adapter = await import\([^\n]+\);/, 'const adapter = fixtureAdapter;');
  const evidence = { selected: true, unverifiable: false, media: true, mediaVisible: true, occluded: false, opaqueSelectors: [] };
  for (const host of ['cursor', 'doubao']) {
    const shared = {
      listDesktopProcesses: async () => [{ createdAtMs: 123 }],
      inspectDesktopUiHealth: async () => ({ cdp: 'connected', port: 9341, state: 'presentation-unverified', anchor: true, anchorTextMatches: true, entry: true, style: true, stage: true, ...evidence }),
    };
    const status = await new Function('fixtureShared', 'fixtureAdapter', 'path', 'REPO', 'args', `${body}\nreturn readCdpStatus();`)(shared, {}, path, '.', { host });
    for (const [key, value] of Object.entries(evidence)) assert.deepEqual(status[key], value, `${host} status ${key}`);
    const runner = createHealthRunner({ hosts: [host], defaultOptions: value => value, getHostStatus: () => ({ installed: true }) });
    const health = await runner.runHostHealth(host, { platform: 'win32', runtimeRoot: '.', spawnSync: () => ({ status: 0, stdout: JSON.stringify({ running: true, cdp: status }) }) });
    for (const [key, value] of Object.entries(evidence)) assert.deepEqual(health[key], value, `${host} aggregate ${key}`);
    assert.equal(health.state, 'presentation-unverified');
  }
});

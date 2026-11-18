import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageDesktopAggregate } from '../../../scripts/pack-desktop-aggregate.mjs';

test('Doubao Work status probes its own host configuration', { skip: process.platform !== 'win32' }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-work-status-'));
  try {
    const dest = path.join(temp, 'package');
    await stageDesktopAggregate(dest, { build: false });
    const runtime = path.join(dest, 'runtime', 'desktop');
    await fs.writeFile(path.join(runtime, 'packages', 'adapter-desktop-cdp', 'dist', 'index.js'), `
      export async function listDesktopProcesses(spec) {
        if (spec?.kind !== 'doubaowork') throw new Error('wrong host');
        return [];
      }
      export async function inspectDesktopUiHealth(spec) {
        if (spec?.kind !== 'doubaowork') throw new Error('wrong host');
        return { cdp: 'disconnected', port: null, state: 'target-not-found', anchor: null,
          anchorTextMatches: null, entry: null, style: null, stage: null };
      }
    `);
    await fs.writeFile(path.join(runtime, 'packages', 'adapter-doubaowork', 'dist', 'index.js'),
      "export const DOUBAOWORK_CDP_SPEC = { kind: 'doubaowork' };\n");
    const result = spawnSync(process.execPath, [path.join(runtime, 'scripts', 'desktop-cdp-setup.mjs'), '--host', 'doubaowork', 'status'], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      env: { ...process.env, APPDATA: path.join(temp, 'roaming'), LOCALAPPDATA: path.join(temp, 'local') },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.cdp.state, 'target-not-found');
    assert.equal(status.cdp.client, 'closed');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

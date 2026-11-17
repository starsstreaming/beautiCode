import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncStableRuntime, activateStableRuntime, pruneStableRuntime } from '../../../scripts/portable-runtime.mjs';
import { workbuddyLinuxPaths, workbuddyLinuxWiring } from '../../../scripts/workbuddy-linux-wiring.mjs';
import { installHostQuickShortcut, removeWindowsQuickShortcut } from '../src/quick-shortcuts.mjs';

test('twenty activations retain current and previous, preserve running and unowned versions', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bc-retention-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');await fsp.mkdir(source);await fsp.writeFile(path.join(source, 'runner.mjs'), '');
  let runtime, pinned;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2));
    runtime = await syncStableRuntime({ sourceRoot: source, stableRoot: root, host: 'cursor', activate: false });
    if (!pinned) pinned = runtime.activeRoot;
    await activateStableRuntime(runtime, { nodePath: process.execPath, runningCommands: () => [pinned + '/runner.mjs'] });
  }
  const versions = path.join(runtime.hostRoot, 'versions');
  assert.equal((await fsp.readdir(versions)).length, 3);
  await fsp.mkdir(path.join(versions, 'foreign'));
  await pruneStableRuntime(runtime, { runningCommands: () => null });
  assert.equal((await fsp.readdir(versions)).length, 4);
  assert.equal(fs.existsSync(pinned), true);
  assert.equal(fs.existsSync(path.join(versions, 'foreign')), true);
});

test('WorkBuddy uses custom XDG directories and preserves foreign startup files', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bc-xdg-wb-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: path.join(root, 'custom config') };
  const paths = workbuddyLinuxPaths(env, root);
  assert.ok(paths.desktop.startsWith(env.XDG_CONFIG_HOME));
  assert.ok(workbuddyLinuxPaths({ XDG_CONFIG_HOME: 'relative' }, root).desktop.startsWith(path.join(root, '.config')));
  const wire = workbuddyLinuxWiring({ env, home: root, launcher: '/tmp/fixture/launcher.sh' });
  wire.install('9335');wire.install('9336');wire.remove();
  assert.equal(fs.existsSync(paths.desktop), false);
  await fsp.writeFile(paths.desktop, 'foreign');
  assert.throws(() => wire.install('9335'), /not owned/);
  assert.throws(() => wire.remove(), /not owned/);
  assert.equal(await fsp.readFile(paths.desktop, 'utf8'), 'foreign');
});

test('Windows shortcut uninstall removes only a matching private-fixture shortcut', { skip: process.platform !== 'win32' }, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bc-shortcut-remove-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'launcher.ps1');await fsp.writeFile(launcher, 'exit 0');
  const options = { launcher, programsDir: path.join(root, 'programs') };
  const created = installHostQuickShortcut('cursor', options);
  assert.throws(() => removeWindowsQuickShortcut('cursor', { ...options, launcher: path.join(root, 'foreign.ps1') }), /ownership/);
  assert.equal(fs.existsSync(created.path), true);
  assert.equal(removeWindowsQuickShortcut('cursor', { ...options, spawnSync(...args) { const r=spawnSync(...args); assert.equal(r.status,0,r.stderr); return r; } }), true);
  assert.equal(fs.existsSync(created.path), false);
});

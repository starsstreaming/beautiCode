import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stageDesktopAggregate } from '../../../scripts/pack-desktop-aggregate.mjs';
import { verifyArtifactManifest } from '../../../scripts/artifact-manifest.mjs';

test('packed tarball keeps readonly CLI and repaired core/status/ownership modules', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-phase1-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  await stageDesktopAggregate(stage, { build: false });
  const npm = process.env.npm_execpath || (process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : null);
  const pack = spawnSync(npm ? process.execPath : 'npm', npm ? [npm, 'pack', '--ignore-scripts', '--json'] : ['pack', '--ignore-scripts', '--json'], { cwd: stage, encoding: 'utf8', windowsHide: true });
  assert.equal(pack.status, 0, pack.stderr);
  const artifact = JSON.parse(pack.stdout)[0];
  const unpack = path.join(root, 'unpacked');
  await fs.mkdir(unpack);
  const extracted = spawnSync('tar', ['-xf', path.join(stage, artifact.filename), '-C', unpack], { encoding: 'utf8', windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr);
  const pkg = path.join(unpack, 'package');
  const receipt = await verifyArtifactManifest(pkg);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(receipt.packageVersion, artifact.version);
  const { runCli } = await import(pathToFileURL(path.join(pkg, 'runtime/dsh/cli.js')).href);
  const empty = path.join(root, 'empty');
  await fs.mkdir(empty);
  for (const flag of ['--help', '--version']) await runCli([flag, '--dsh-home', path.join(empty, 'home'), '--plugin-home', path.join(empty, 'plugin')]);
  await assert.rejects(runCli(['--typo', '--dsh-home', path.join(empty, 'home')]));
  assert.deepEqual(await fs.readdir(empty), []);
  const { getHostStatus } = await import(pathToFileURL(path.join(pkg, 'src/index.mjs')).href);
  assert.equal(getHostStatus('dsh', { home: empty, env: { DSH_HOME: empty } }).installed, false);
  for (const family of ['desktop', 'workbuddy']) {
    const core = await import(pathToFileURL(path.join(pkg, 'runtime', family, 'packages/core/dist/index.js')).href);
    assert.equal(typeof core.guardHttpHandler, 'function');
    await assert.rejects(core.listApprovedSkins({ fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); throw new Error('isolated'); } }));
  }
  const ownership = await import(pathToFileURL(path.join(pkg, 'runtime/workbuddy/scripts/windows-owned-env.mjs')).href);
  assert.equal(typeof ownership.updateOwnedPort, 'function');
  await import(pathToFileURL(path.join(pkg, 'runtime/workbuddy/scripts/workbuddy-linux-wiring.mjs')).href);
  const bundledDesktop = await import(pathToFileURL(path.join(pkg, 'runtime/desktop/packages/adapter-desktop-cdp/dist/runtime.js')).href);
  assert.equal(typeof bundledDesktop.buildDesktopBackgroundInjection, 'function');
  await fs.appendFile(path.join(pkg, 'runtime/dsh/cli.js'), '\n// tampered\n');
  await assert.rejects(verifyArtifactManifest(pkg), /Artifact mismatch/);
  t.diagnostic(`tarball ${artifact.filename}; integrity ${artifact.integrity}; ${artifact.entryCount} files`);
});

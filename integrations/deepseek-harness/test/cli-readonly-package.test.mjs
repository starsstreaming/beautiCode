import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stageDshPlugin } from '../../../scripts/pack-dsh-plugin.mjs';

test('packaged DSH help and version remain read-only after tarball extraction', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-cli-tarball-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  await stageDshPlugin(stage, { build: false });
  const npm = process.env.npm_execpath;
  const useShell = !npm && process.platform === 'win32';
  const pack = spawnSync(npm ? process.execPath : useShell ? 'npm pack --ignore-scripts --json' : 'npm', npm ? [npm, 'pack', '--ignore-scripts', '--json'] : useShell ? [] : ['pack', '--ignore-scripts', '--json'], {
    cwd: stage, encoding: 'utf8', windowsHide: true, shell: useShell,
  });
  assert.equal(pack.status, 0, pack.stderr);
  const artifact = JSON.parse(pack.stdout)[0];
  const unpack = path.join(root, 'unpacked');await fs.mkdir(unpack);
  assert.equal(spawnSync('tar', ['-xf', path.join(stage, artifact.filename), '-C', unpack], { encoding: 'utf8', windowsHide: true }).status, 0);
  const { runCli } = await import(pathToFileURL(path.join(unpack, 'package/cli.js')).href);
  const empty = path.join(root, 'empty');await fs.mkdir(empty);
  for (const flag of ['--help', '--version', '--status']) await runCli([flag, '--dsh-home', path.join(empty, 'home'), '--plugin-home', path.join(empty, 'plugin')]);
  await assert.rejects(runCli(['--typo', '--dsh-home', path.join(empty, 'home')]));
  assert.deepEqual(await fs.readdir(empty), []);
});

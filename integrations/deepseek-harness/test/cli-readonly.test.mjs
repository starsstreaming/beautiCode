import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../cli.js';

test('help/version and rejected arguments cannot create an installation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = ['--dsh-home', path.join(root, 'home'), '--plugin-home', path.join(root, 'plugin')];
  for (const flag of ['--help', '-h', '--version', '-v']) await runCli([flag, ...paths]);
  for (const flags of [['--typo'], ['--remove', '--help'], ['--dsh-home']]) await assert.rejects(runCli(flags.length === 1 && flags[0] === '--typo' ? [...flags, ...paths] : flags));
  assert.deepEqual(fs.readdirSync(root), []);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('quick shortcut survives an npm package move by pointing at the stable runtime', { skip: process.platform !== 'win32' }, async (t) => {
  const { installHostQuickShortcut } = await import('../src/quick-shortcuts.mjs').catch(() => ({}));
  assert.equal(typeof installHostQuickShortcut, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beauticode-quick-shortcut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'runtime', 'cursor', 'launcher.ps1');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, 'exit 0\n');
  const programsDir = path.join(root, 'Programs');
  const first = installHostQuickShortcut('cursor', { launcher, programsDir });
  assert.equal(first.outcome, 'created');
  assert.equal(fs.existsSync(first.path), true);
  assert.equal(installHostQuickShortcut('cursor', { launcher, programsDir }).outcome, 'present');
});

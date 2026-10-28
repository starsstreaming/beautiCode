import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { installHostQuickShortcut } from '../src/quick-shortcuts.mjs';

test('quick shortcut survives an npm package move by pointing at the stable runtime', { skip: process.platform !== 'win32' }, async (t) => {
  const { installHostQuickShortcut } = await import('../src/quick-shortcuts.mjs').catch(() => ({}));
  assert.equal(typeof installHostQuickShortcut, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beauticode-quick-shortcut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'runtime', 'cursor', 'launcher.ps1');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, 'exit 0\n');
  const programsDir = path.join(root, 'Programs');
  const first = installHostQuickShortcut('cursor', { launcher, programsDir,
    spawnSync(...args) {
      const result = spawnSync(...args);
      // Keep native diagnostics in the isolated fixture so CI can distinguish COM failures from process capture failures.
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      return result;
    },
  });
  assert.equal(first.outcome, 'created');
  assert.equal(fs.existsSync(first.path), true);
  assert.equal(installHostQuickShortcut('cursor', { launcher, programsDir }).outcome, 'present');
});

test('shortcut process capture tolerates module progress without losing a successful outcome', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beauticode-shortcut-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'launcher.ps1');
  fs.writeFileSync(launcher, 'exit 0\n');
  let calls = 0;
  const result = installHostQuickShortcut('cursor', {
    launcher, programsDir: path.join(root, 'Programs'),
    spawnSync(_program, _args, options) {
      calls++;
      // Reproduce the size of PowerShell module-loading progress on a fresh hosted runner.
      return spawnSync(process.execPath, ['--eval', "process.stderr.write('x'.repeat(48 * 1024)); process.stdout.write('created');"], options);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'created');
});

test('shortcut process errors report the actual failure code instead of CLIXML progress', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beauticode-shortcut-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'launcher.ps1');
  fs.writeFileSync(launcher, 'exit 0\n');
  assert.throws(() => installHostQuickShortcut('cursor', {
    launcher, programsDir: path.join(root, 'Programs'),
    spawnSync: () => ({ status: null, error: Object.assign(new Error('capture failed'), { code: 'ENOBUFS' }), stderr: '#< CLIXML progress' }),
  }), (error) => error.code === 'ENOBUFS' && error.message.includes('ENOBUFS') && !error.message.includes('CLIXML'));
});

test('shortcut nonzero exits retain bounded diagnostics without local paths or URLs', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beauticode-shortcut-detail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'launcher.ps1');
  fs.writeFileSync(launcher, 'exit 0\n');
  assert.throws(() => installHostQuickShortcut('cursor', {
    launcher, programsDir: path.join(root, 'Programs'),
    spawnSync: () => ({ status: 1, stderr: `COM Save permission denied: '${launcher}' https://example.test/?token=secret ` + 'x'.repeat(4000) }),
  }), (error) => error.message.includes('COM Save permission denied') && error.message.length < 600 &&
    !error.message.includes(root) && !error.message.includes('token=secret'));
});

test('shortcut publication preserves its Unicode name when native COM accepts only ASCII filenames', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beauticode-shortcut-unicode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'launcher.ps1');
  fs.writeFileSync(launcher, 'exit 0\n');
  const programsDir = path.join(root, 'Programs');
  const nativeFixture = `
function New-Object {
  param([string]$ComObject)
  if ($ComObject -ne 'WScript.Shell') { throw 'unexpected COM fixture' }
  $shell = [pscustomobject]@{}
  $shell | Add-Member -MemberType ScriptMethod -Name CreateShortcut -Value {
    param($file)
    $link = [pscustomobject]@{ FullName=$file; TargetPath=''; Arguments=''; WorkingDirectory=''; WindowStyle=1; Description='' }
    $link | Add-Member -MemberType ScriptMethod -Name Save -Value {
      if ($this.FullName -match '[^\\x00-\\x7f]') { throw 'native-unicode-save-failed' }
      [System.IO.File]::WriteAllText($this.FullName, 'fixture shortcut')
    }
    return $link
  }
  return $shell
}
`;
  const result = installHostQuickShortcut('cursor', {
    launcher, programsDir,
    spawnSync(program, args, options) {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      return spawnSync(program, [...args.slice(0, -1), Buffer.from(nativeFixture + script, 'utf16le').toString('base64')], options);
    },
  });
  assert.equal(result.outcome, 'created');
  assert.deepEqual(fs.readdirSync(programsDir), ['beautiCode Cursor (背景).lnk']);
});

test('parent cleans its private shortcut alias when the native process is terminated', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beauticode-shortcut-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'launcher.ps1');
  fs.writeFileSync(launcher, 'exit 0\n');
  const programsDir = path.join(root, 'Programs');
  assert.throws(() => installHostQuickShortcut('cursor', {
    launcher, programsDir,
    spawnSync(_program, args) {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const temporary = script.match(/\$temporaryPath='([^']+)'/)[1];
      fs.writeFileSync(temporary, 'unfinished owned shortcut');
      return { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    },
  }), (error) => error.code === 'ETIMEDOUT');
  assert.deepEqual(fs.readdirSync(programsDir), []);
});

test('Linux quick launch entry is owned, idempotent, conflict-safe and removable', { skip: process.platform !== 'linux' }, async (t) => {
  const { removeLinuxQuickShortcut } = await import('../src/quick-shortcuts.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beauticode-quick-desktop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'data', 'beautiCode', 'runtime', 'cursor', 'launcher.sh');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '#!/bin/sh\n');
  const programsDir = path.join(root, 'applications');
  const first = installHostQuickShortcut('cursor', { platform: 'linux', xdgDataHome: path.join(root, 'data'), programsDir });
  assert.equal(first.outcome, 'created');
  const content = fs.readFileSync(first.path, 'utf8');
  assert.match(content, /^Exec="\/bin\/sh" ".*launcher\.sh" --quick-launch$/m);
  assert.match(content, /^X-BeautiCode-Managed=true$/m);
  assert.equal(installHostQuickShortcut('cursor', { platform: 'linux', xdgDataHome: path.join(root, 'data'), programsDir }).outcome, 'present');
  fs.writeFileSync(first.path, '[Desktop Entry]\nExec=foreign\n');
  assert.throws(() => installHostQuickShortcut('cursor', { platform: 'linux', xdgDataHome: path.join(root, 'data'), programsDir }), /shortcut-conflict/);
  assert.equal(removeLinuxQuickShortcut('cursor', { programsDir }), false);
  assert.equal(fs.existsSync(first.path), true);
  fs.rmSync(first.path);
  installHostQuickShortcut('cursor', { platform: 'linux', xdgDataHome: path.join(root, 'data'), programsDir });
  assert.equal(removeLinuxQuickShortcut('cursor', { programsDir }), true);
  assert.equal(fs.existsSync(first.path), false);
});

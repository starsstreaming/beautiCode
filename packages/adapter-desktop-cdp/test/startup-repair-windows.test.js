import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';
import { repairDesktopProcess } from '../dist/index.js';
import { stopWindowsDesktopProcess } from '../dist/windows-process-stop.js';

const execFileAsync = promisify(execFile);

test('a slower Windows shell gets the host-specific time needed to complete', { timeout: 10_000 }, async () => {
  const row = { pid: 42, createdAtMs: 1_000 };
  const spec = { displayName: 'test host', windowsProcessStopTimeoutMs: 5_000 };
  const run = async (_args, timeout) => {
    await execFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 2300)'], { timeout, windowsHide: true });
  };
  assert.equal(await stopWindowsDesktopProcess(row, 'close', spec, undefined, run), true);
});

test('Windows repair can stop its own freshly launched test process', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  let exited = false;
  child.once('exit', () => { exited = true; });

  const query = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}'; ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()`;
  const lookup = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(lookup.status, 0, lookup.stderr);
  const createdAtMs = Number(lookup.stdout.trim());
  assert.ok(Number.isFinite(createdAtMs) && createdAtMs > 0);

  const row = {
    pid: child.pid, name: 'node.exe', executablePath: process.execPath,
    commandLine: `"${process.execPath}"`, port: null, createdAtMs,
  };
  let relaunched = false;
  const result = await repairDesktopProcess({ displayName: 'test host' }, row, undefined, {
    listProcesses: async () => exited ? [] : [row],
    pickPort: async () => 9346,
    launch: async () => { relaunched = true; },
    waitForCdp: async () => null,
    exists: () => true,
  });
  assert.equal(result, 'launched');
  assert.equal(exited, true);
  assert.equal(relaunched, true);
});

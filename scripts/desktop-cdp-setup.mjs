#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeVerifiedExecutableRecord } from '../packages/beauticode-desktop/src/windows-host-install.mjs';
import {
  isManagedDesktopRunner,
  startDesktopGuardian,
  withDesktopWiringRollback,
} from './desktop-runner-identity.mjs';
import {
  activateStableRuntime,
  discardStableRuntime,
  hostRuntimeRoot,
  renderWindowsStartupVbs,
  resolveNodeExecutable,
  stableRuntimeRoot,
  startupDirectory,
  syncStableRuntime,
  writeTextAtomic,
} from './portable-runtime.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(REPO, 'scripts', 'desktop-cdp-runner.mjs');

function parseArgs(argv) {
  const out = { command: 'install', host: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'install' || arg === 'status' || arg === 'uninstall') out.command = arg;
    else if (arg === '--host') out.host = String(argv[++i] || '').toLowerCase();
    else if (arg.startsWith('--host=')) out.host = arg.slice(7).toLowerCase();
  }
  if (out.host !== 'cursor' && out.host !== 'doubao') {
    throw new Error('用法：node desktop-cdp-setup.mjs --host cursor|doubao install|status|uninstall');
  }
  return out;
}

if (process.platform !== 'win32') throw new Error('Cursor/豆包背景守护当前仅支持 Windows。');
const args = parseArgs(process.argv.slice(2));
const dataDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'beauticode', 'hosts', args.host);
const pidFile = path.join(dataDir, 'runner.pid');
const logFile = path.join(dataDir, 'runner.log');
const stableRoot = stableRuntimeRoot(process.env, os.homedir());
const stableHostRoot = hostRuntimeRoot(stableRoot, args.host);
const startupVbs = path.join(startupDirectory(process.env, os.homedir()), `beauticode-${args.host}-runner.vbs`);
const legacyStartupVbs = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), `beauticode-${args.host}-runner.vbs`);
const runnerArgs = ['--host', args.host, '--watchdog', '--pid-file', pidFile];
const runnerContext = { host: args.host, stableHostRoot, sourceRunner: RUNNER, pidFile };

const DESKTOP_RUNTIME_PREFIXES = [
  'scripts/desktop-cdp-runner.mjs',
  'scripts/quick-launch.mjs',
  'packages/core/dist/',
  'packages/adapter-desktop-cdp/dist/',
  `packages/adapter-${args.host}/dist/`,
];
function desktopRuntimeFilter(relative, entry) {
  const normalized = relative.replaceAll('\\', '/');
  return entry.isDirectory()
    ? DESKTOP_RUNTIME_PREFIXES.some((prefix) => prefix.startsWith(normalized) || normalized.startsWith(prefix))
    : DESKTOP_RUNTIME_PREFIXES.some((prefix) => prefix.endsWith('/') ? normalized.startsWith(prefix) : normalized === prefix);
}
async function prepareStableRuntime() {
  const runtime = await syncStableRuntime({
    sourceRoot: REPO,
    stableRoot,
    host: args.host,
    entrypoint: 'scripts/desktop-cdp-runner.mjs',
    filter: desktopRuntimeFilter,
    activate: false,
  });
  try {
    await resolveNodeExecutable({ stableRoot: runtime.hostRoot });
    return runtime;
  } catch (error) {
    await discardStableRuntime(runtime);
    throw error;
  }
}

function readPidRecord() {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || value.schema !== 'beauticode.desktop-runner/v1') return null;
    const pid = Number(value.pid);
    if (!Number.isInteger(pid) || pid < 1) return null;
    return { ...value, pid };
  } catch {
    // Old releases wrote a bare PID. It is deliberately not trusted for a
    // destructive action because the PID may already belong to another app.
    return null;
  }
}

function readWindowsProcess(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\";`,
    'if(-not $p){exit 1};',
    '$created=0;try{$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}catch{};',
    '[pscustomobject]@{pid=[int]$p.ProcessId;name=[string]$p.Name;image=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine;createdAtMs=$created}|ConvertTo-Json -Compress -Depth 3;',
  ].join('');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  if (result.status !== 0) return null;
  try {
    const value = JSON.parse(String(result.stdout || '').trim());
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function managedRunnerProcess() {
  const record = readPidRecord();
  if (!record) return null;
  const current = readWindowsProcess(record.pid);
  return isManagedDesktopRunner(record, current, runnerContext) ? current : null;
}

function stopRunner() {
  const record = readPidRecord();
  const current = record ? readWindowsProcess(record.pid) : null;
  if (isManagedDesktopRunner(record, current, runnerContext)) {
    const result = spawnSync('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true, timeout: 8_000 });
    // Do not discard the only ownership record when taskkill failed.  The
    // next install/status must still be able to identify and stop this exact
    // runner instead of starting a second watchdog beside it.
    const after = readWindowsProcess(record.pid);
    if (result.error || result.status !== 0 || isManagedDesktopRunner(record, after, runnerContext)) {
      const detail = result.error?.message || (result.status == null ? 'taskkill timed out' : `exit ${result.status}`);
      throw new Error(`无法停止现有 beautiCode ${args.host} 守护（${detail}）。`);
    }
  }
  try { fs.unlinkSync(pidFile); } catch {}
}

function cleanPage() {
  const launcher = path.join(stableHostRoot, 'launcher.ps1');
  if (!fs.existsSync(launcher)) return;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '--host', args.host, '--clean', '--no-repair'], {
    windowsHide: true, timeout: 10_000, stdio: 'ignore',
  });
}

async function readCdpStatus() {
  try {
    const shared = await import(pathToFileURL(path.join(REPO, 'packages', 'adapter-desktop-cdp', 'dist', 'index.js')).href);
    const adapter = await import(pathToFileURL(path.join(REPO, 'packages', `adapter-${args.host}`, 'dist', 'index.js')).href);
    const spec = args.host === 'cursor' ? adapter.CURSOR_CDP_SPEC : adapter.DOUBAO_CDP_SPEC;
    const processes = await shared.listDesktopProcesses(spec);
    const diagnosis = await shared.inspectDesktopUiHealth(spec);
    let executableFingerprint = null;
    if (processes.length === 1 && processes[0].executablePath) {
      try {
        const executable = processes[0].executablePath;
        const resources = path.join(path.dirname(executable), 'resources', 'app.asar');
        const fingerprintFile = fs.existsSync(resources) ? resources : executable;
        const stat = fs.statSync(fingerprintFile);
        executableFingerprint = `${path.basename(fingerprintFile)}:${Math.trunc(stat.mtimeMs)}-${stat.size}`;
      } catch { /* executable metadata may be unavailable while the host updates */ }
    }
    return {
      client: processes.length > 1 ? 'ambiguous' : processes.length === 1 ? 'running' : diagnosis.cdp === 'connected' ? 'unknown' : 'closed',
      processCount: processes.length,
      clientGeneration: processes.length === 1 ? processes[0].createdAtMs : null,
      executableFingerprint,
      connected: diagnosis.cdp === 'connected',
      port: diagnosis.port,
      state: diagnosis.state,
      anchor: diagnosis.anchor,
      anchorTextMatches: diagnosis.anchorTextMatches,
      entry: diagnosis.entry,
      style: diagnosis.style,
      stage: diagnosis.stage,
    };
  } catch {
    return { connected: false, port: null, state: 'probe-failed', anchor: null, anchorTextMatches: null, entry: null, style: null, stage: null };
  }
}

if (args.command === 'status') {
  const managed = managedRunnerProcess();
  process.stdout.write(JSON.stringify({
    host: args.host,
    installed: fs.existsSync(startupVbs),
    running: !!managed,
    pid: managed?.pid ?? null,
    cdp: await readCdpStatus(),
    startup: startupVbs,
    state: path.join(dataDir, 'state.json'),
  }, null, 2) + '\n');
}

if (args.command === 'uninstall') {
  stopRunner();
  cleanPage();
  try { fs.unlinkSync(startupVbs); } catch {}
  try { fs.unlinkSync(legacyStartupVbs); } catch {}
  process.stdout.write(`${args.host} 背景守护已卸载；独立主题状态保留在 ${dataDir}\n`);
  process.exit(0);
}

if (args.command === 'install') {
fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(path.join(REPO, 'package-lock.json'))) {
  const compiler = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
  for (const packageName of ['core', 'adapter-desktop-cdp', `adapter-${args.host}`]) {
    const config = path.join(REPO, 'packages', packageName, 'tsconfig.json');
    const result = spawnSync(process.execPath, [compiler, '-p', config], { cwd: REPO, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${packageName} build failed`).slice(-2000));
  }
}
const stableRuntime = await prepareStableRuntime();
const previousRunning = managedRunnerProcess();
const startFromStartup = () => {
  const result = spawnSync('wscript.exe', ['//B', startupVbs], { windowsHide: true, timeout: 5_000, stdio: 'ignore' });
  if (result.error || result.status !== 0) throw new Error('startup-launch-failed');
};
let guardian;
try {
  guardian = await withDesktopWiringRollback({
    pointerPath: stableRuntime.pointerPath,
    startupVbs,
    executableRecord: path.join(dataDir, 'executable.json'),
    run: async () => {
      stopRunner();
      await activateStableRuntime(stableRuntime, { startupLogPath: logFile });
      await writeVerifiedExecutableRecord(args.host, dataDir);
      fs.mkdirSync(path.dirname(startupVbs), { recursive: true });
      await writeTextAtomic(startupVbs, renderWindowsStartupVbs({ launcher: stableRuntime.launcher, args: runnerArgs }));
      try {
        return await startDesktopGuardian({
          context: runnerContext,
          start: startFromStartup,
          readRecord: readPidRecord,
          readProcess: readWindowsProcess,
        });
      } catch (error) {
        if (managedRunnerProcess()) stopRunner();
        throw error;
      }
    },
  });
} catch (error) {
  await discardStableRuntime(stableRuntime);
  if (previousRunning && fs.existsSync(startupVbs) && !managedRunnerProcess()) {
    try { startFromStartup(); } catch { /* Original error remains authoritative. */ }
  }
  throw error;
}
if (path.resolve(legacyStartupVbs) !== path.resolve(startupVbs)) fs.rmSync(legacyStartupVbs, { force: true });
process.stdout.write(`${args.host} 背景守护已安装并启动（PID ${guardian.pid}）。\n`);
}

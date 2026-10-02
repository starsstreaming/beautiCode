#!/usr/bin/env node
/**
 * wb-setup.mjs — beautiCode × WorkBuddy 一键安装/卸载/状态（Windows / macOS / Linux 通用）
 *
 * 做两件事，做完之后「点 WorkBuddy 图标」就有自定义背景：
 *   A. 持久化环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT —— WorkBuddy 主进程在启动时读它
 *      开 CDP（app.asar/main/index.js 的 applyCliCommandLineSwitches），所以点图标启动也带 CDP
 *   B. 安装登录自启的注入守护（wb-cdp-runner.mjs，内部 3s 重连）—— WorkBuddy 一运行就注入
 *      完整序列（UI + 契约 CSS + token 覆盖 + 硬编码中立化 + 样式看门狗）
 *
 * 用法：
 *   node wb-setup.mjs              # 安装（默认）
 *   node wb-setup.mjs install
 *   node wb-setup.mjs status       # 查看安装与连接状态
 *   node wb-setup.mjs uninstall    # 拆除（守护 + 自启 + 环境变量）
 *   node wb-setup.mjs --port 9335
 *
 * 平台做法：
 *   macOS  ：LaunchAgent（RunAtLoad+KeepAlive，登录时 launchctl setenv + 常驻 runner）
 *   Windows：setx 持久化用户 env + 「启动」文件夹放隐藏运行的 VBS
 *   Linux  ：environment.d（systemd 用户会话 env）+ ~/.config/autostart/*.desktop
 *
 * 安全：不写 ~/.workbuddy/；卸载可完整还原。
 */

import { spawn, spawnSync, execSync } from 'node:child_process';
import { isManagedWorkBuddyRunner, readWindowsProcess } from './guardian-process.mjs';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const RUNNER = path.join(REPO, 'scripts', 'wb-cdp-runner.mjs');
const NODE = process.execPath;
const PLAT = process.platform; // darwin | win32 | linux
const ENV_KEY = 'WORKBUDDY_REMOTE_DEBUGGING_PORT';
const PACKAGED_RUNTIME = process.env.BEAUTICODE_PACKAGED_RUNTIME === '1';
const DATA_ROOT = PLAT === 'win32'
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : PLAT === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const DATA_DIR = path.join(DATA_ROOT, 'beauticode');
const PORT_FILE = path.join(DATA_DIR, 'workbuddy-port.json');
const PORT_CANDIDATES = [9336, 9335, 9222, 9223, 9229, 9230, 9300, 9310, 9320, 9340, 9350];

// ── 参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let cmd = 'install';
let port = String(process.env[ENV_KEY] || '9335');
let portExplicit = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === 'install' || a === 'uninstall' || a === 'status') cmd = a;
  else if (a === '--port' || a === '-p') { port = String(parseInt(argv[++i], 10)); portExplicit = true; }
  else if (a === '--help' || a === '-h') cmd = 'help';
}
if (cmd === 'help') {
  console.log([
    '用法：node wb-setup.mjs [install|uninstall|status] [--port 9335]',
    '',
    'install   安装环境变量 + 登录自启守护，并立即启动守护（默认）',
    'status    查看安装与 CDP 连接状态',
    'uninstall 拆除守护、自启项与环境变量',
  ].join('\n'));
  process.exit(0);
}
if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) {
  console.error(`端口无效：${port}`); process.exit(2);
}
if (cmd === 'install' && !portExplicit) {
  port = await chooseInstallPort();
}

const log = (...m) => console.log(...m);
const run = (cmdline, opts = {}) => {
  try { return { ok: true, out: execSync(cmdline, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') + e.message }; }
};
const home = os.homedir();

function readConfiguredPort() {
  try {
    const value = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')).port;
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  } catch { return null; }
}

function writeConfiguredPort(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PORT_FILE, JSON.stringify({ port: Number(value), updatedAt: new Date().toISOString() }) + '\n', {
    encoding: 'utf8', mode: 0o600,
  });
}

function isLoopbackPortFree(value) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(value, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function hasWorkBuddyCdp(value) {
  try {
    const response = await fetch(`http://127.0.0.1:${value}/json/list`, {
      signal: AbortSignal.timeout(350), redirect: 'error',
    });
    if (!response.ok) return false;
    const targets = await response.json();
    return Array.isArray(targets) && targets.some((target) =>
      target && target.type === 'page' && typeof target.url === 'string' &&
      target.url.includes('/resources/app.asar/renderer/index.html'));
  } catch { return false; }
}

async function chooseInstallPort() {
  const configured = readConfiguredPort();
  const requested = Number(port);
  const ordered = [
    ...(configured ? [configured] : []),
    ...(Number.isInteger(requested) ? [requested] : []),
    ...PORT_CANDIDATES,
  ].filter((value, index, all) => Number.isInteger(value) && value > 0 && value <= 65535 && all.indexOf(value) === index);
  for (const candidate of ordered) {
    if (await hasWorkBuddyCdp(candidate)) return String(candidate);
    if (await isLoopbackPortFree(candidate)) return String(candidate);
  }
  throw new Error('没有可用的 WorkBuddy loopback CDP 端口。');
}

if (cmd !== 'install' && !portExplicit) {
  const configured = readConfiguredPort();
  if (configured) port = String(configured);
}

function broadcastWindowsEnvironment() {
  if (PLAT !== 'win32') return;
  const ps = [
    'Add-Type -Namespace Beauticode -Name NativeMethods -MemberDefinition',
    '"[DllImport(\\"user32.dll\\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);"',
    '; $result=[UIntPtr]::Zero; [Beauticode.NativeMethods]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,"Environment",2,1000,[ref]$result) | Out-Null',
  ].join(' ');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    stdio: 'ignore', windowsHide: true,
  });
}

const WB_RUNTIME_PREFIXES = [
  'scripts/wb-cdp-runner.mjs',
  'scripts/quick-launch.mjs',
  'scripts/wb-startup-media.mjs',
  'scripts/wb-runner-log.mjs',
  'scripts/wb-theme-name-diagnostic.mjs',
  'packages/core/dist/',
  'packages/adapter-workbuddy/dist/',
  'assets/themes/internal-beyond/',
];
function wbRuntimeFilter(relative, entry) {
  const normalized = relative.replaceAll('\\', '/');
  return entry.isDirectory()
    ? WB_RUNTIME_PREFIXES.some((prefix) => prefix.startsWith(normalized) || normalized.startsWith(prefix))
    : WB_RUNTIME_PREFIXES.some((prefix) => prefix.endsWith('/') ? normalized.startsWith(prefix) : normalized === prefix);
}

async function prepareStableRuntime() {
  const runtime = await syncStableRuntime({
    sourceRoot: REPO,
    stableRoot: STABLE_ROOT,
    host: 'workbuddy',
    entrypoint: 'scripts/wb-cdp-runner.mjs',
    filter: wbRuntimeFilter,
    activate: false,
  });
  try {
    await resolveNodeExecutable({ stableRoot: runtime.hostRoot });
    return await activateStableRuntime(runtime, { startupLogPath: WIN_LOG });
  } catch (error) {
    await discardStableRuntime(runtime);
    throw error;
  }
}

// ── 各平台路径与实现 ──────────────────────────────────────────────────
const LAUNCHER_MAC = path.join(home, 'Library/LaunchAgents/com.beauticode.wb-runner.plist');
const MAC_LOG = path.join(home, 'Library/Logs/beauticode-wb-runner.log');
const STABLE_ROOT = stableRuntimeRoot(process.env, home);
const STABLE_HOST_ROOT = hostRuntimeRoot(STABLE_ROOT, 'workbuddy');
const STARTUP_VBS = path.join(home, 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/beauticode-wb-runner.vbs');
const LEGACY_STARTUP_VBS = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'beauticode-wb-runner.vbs');
const WIN_LOG = path.join(
  process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
  'beauticode', 'logs', 'wb-runner.log',
);
const LINUX_ENV = path.join(home, '.config/environment.d/beauticode-wb.conf');
const LINUX_DESKTOP = path.join(home, '.config/autostart/beauticode-beauticode-wb-runner.desktop');
const PID_FILE = PLAT === 'win32'
  ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'beauticode', 'wb-runner.pid')
  : PLAT === 'darwin'
    ? path.join(home, 'Library', 'Logs', 'beauticode-wb-runner.pid')
    : '/tmp/beauticode-wb-runner.pid';

const macPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.beauticode.wb-runner</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>launchctl setenv ${ENV_KEY} ${port} 2>/dev/null; exec ${JSON.stringify(NODE)} ${JSON.stringify(RUNNER)} --watchdog</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${MAC_LOG}</string>
  <key>StandardErrorPath</key><string>${MAC_LOG}</string>
</dict></plist>`;

const winVbs = (launcher) => renderWindowsStartupVbs({ launcher, args: ['--watchdog'] });

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
const linuxDesktop = () => {
  const cmd = `exec ${shSingleQuote(NODE)} ${shSingleQuote(RUNNER)} --watchdog >> /tmp/beauticode-wb-runner.log 2>&1`;
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[Desktop Entry]
Type=Application
Name=beautiCode WorkBuddy runner
Comment=注入 WorkBuddy 自定义背景（CDP）
Exec=/bin/sh -c "${escaped}"
X-GNOME-Autostart-enabled=true
Terminal=false`;
};

function installMac() {
  fs.mkdirSync(path.dirname(LAUNCHER_MAC), { recursive: true });
  fs.mkdirSync(path.dirname(MAC_LOG), { recursive: true });
  fs.writeFileSync(LAUNCHER_MAC, macPlist());
  run(`launchctl unload "${LAUNCHER_MAC}" 2>/dev/null`); // 覆盖安装
  const load = run(`launchctl load "${LAUNCHER_MAC}"`);
  log(load.ok ? '  ✓ LaunchAgent 已装载（登录自启 + KeepAlive）'
              : `  ✗ launchctl load 失败（沙箱限制？）请在 Terminal 里手动跑：\n      launchctl load "${LAUNCHER_MAC}"`);
  // 会话内立即生效（跨重启由 plist 的 RunAtLoad 补）
  const setenv = run(`launchctl setenv ${ENV_KEY} ${port}`);
  log(setenv.ok ? `  ✓ launchctl setenv —— 之后点图标启动的 WorkBuddy 自带 CDP`
                : `  ✗ setenv 需要你在 Terminal 手动跑一次：\n      launchctl setenv ${ENV_KEY} ${port}`);
}
function uninstallMac() {
  run(`launchctl unload "${LAUNCHER_MAC}" 2>/dev/null`);
  run(`launchctl unsetenv ${ENV_KEY} 2>/dev/null`);
  fs.rmSync(LAUNCHER_MAC, { force: true });
  log('  ✓ 已拆除 LaunchAgent 并 unsetenv');
}
function statusMac() {
  const listed = run(`launchctl list 2>/dev/null`).out;
  const loaded = listed.split('\n').some((l) => l.includes('com.beauticode.wb-runner'));
  log(`  LaunchAgent：${fs.existsSync(LAUNCHER_MAC) ? '已安装' : '未安装'}${loaded ? '（已装载）' : ''}`);
}

async function installWin(runtime) {
  const r = spawnSync('setx', [ENV_KEY, port], { encoding: 'utf8' });
  log(r.status === 0 ? '  ✓ setx 已持久化用户环境变量（点图标启动的 WorkBuddy 自带 CDP）'
                     : `  ✗ setx 失败：${r.stderr}`);
  broadcastWindowsEnvironment();
  log('  ✓ 已广播环境变更（无需注销即可让后续原图标启动继承端口）');
  fs.mkdirSync(path.dirname(STARTUP_VBS), { recursive: true });
  const startupContent = winVbs(runtime.launcher);
  let currentStartupContent = null;
  try { currentStartupContent = fs.readFileSync(STARTUP_VBS, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (currentStartupContent !== startupContent) await writeTextAtomic(STARTUP_VBS, startupContent);
  if (path.resolve(LEGACY_STARTUP_VBS) !== path.resolve(STARTUP_VBS)) fs.rmSync(LEGACY_STARTUP_VBS, { force: true });
  log(currentStartupContent === startupContent
    ? '  ✓「启动」文件夹 VBS 已是当前配置（跳过无变化替换）'
    : '  ✓ 已写入「启动」文件夹 VBS（登录自启、隐藏窗口）');
  if (process.env[ENV_KEY] !== port) {
    log('  ⚠ 当前会话还没继承新 env：注销重登一次，或先手动带 env 启动一次 WorkBuddy');
  }
}
function uninstallWin() {
  fs.rmSync(STARTUP_VBS, { force: true });
  fs.rmSync(LEGACY_STARTUP_VBS, { force: true });
  run(`reg delete "HKCU\\Environment" /v ${ENV_KEY} /f`);
  log('  ✓ 已拆除启动项并删除用户环境变量');
}
function statusWin() {
  log(`  用户 env：${run('reg query "HKCU\\Environment" /v ' + ENV_KEY).out.includes(ENV_KEY) ? '已设置' : '未设置'}`);
  log(`  启动项：${fs.existsSync(STARTUP_VBS) ? '已安装' : '未安装'}`);
  let state = '不存在';
  try {
    const info = fs.statSync(WIN_LOG);
    const writable = (() => { try { fs.accessSync(WIN_LOG, fs.constants.W_OK); return true; } catch { return false; } })();
    state = `${writable ? '可写' : '不可写'}，最后更新 ${info.mtime.toISOString()}`;
  } catch { /* read-only status: missing is not proof the runner stopped */ }
  log(`  守护日志：${state}`);
}

function installLinux() {
  fs.mkdirSync(path.dirname(LINUX_ENV), { recursive: true });
  fs.mkdirSync(path.dirname(LINUX_DESKTOP), { recursive: true });
  fs.writeFileSync(LINUX_ENV, `${ENV_KEY}=${port}\n`);
  fs.writeFileSync(LINUX_DESKTOP, linuxDesktop());
  log('  ✓ environment.d + autostart 已写入（下次登录生效；当前会话可手动 export）');
}
function uninstallLinux() {
  fs.rmSync(LINUX_ENV, { force: true });
  fs.rmSync(LINUX_DESKTOP, { force: true });
  log('  ✓ 已拆除 environment.d 与 autostart');
}
function statusLinux() {
  log(`  environment.d：${fs.existsSync(LINUX_ENV) ? '已安装' : '未安装'}`);
  log(`  autostart：${fs.existsSync(LINUX_DESKTOP) ? '已安装' : '未安装'}`);
}

function findWindowsRunnerPids(nodeOnly = false) {
  if (PLAT !== 'win32') return [];
  // Never trust a stale/reused PID file on Windows. Restrict discovery to the
  // exact runner path and watchdog mode, so install/uninstall cannot kill a
  // user's unrelated process (or WorkBuddy/Codex) after a PID was recycled.
  const runner = String(RUNNER).replace(/'/g, "''");
  const stable = String(STABLE_HOST_ROOT).replace(/'/g, "''");
  const script = [
    `$runner='${runner}'`,
    `$stable='${stable}'`,
    '$needle=$runner.ToLowerInvariant(); $stableNeedle=$stable.ToLowerInvariant()',
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '${nodeOnly ? '^node(\\.exe)?$' : '^(node|powershell)(\\.exe)?$'}' -and $_.CommandLine -and ( $_.CommandLine.ToLowerInvariant().Contains($needle) -or $_.CommandLine.ToLowerInvariant().Contains($stableNeedle) ) -and $_.CommandLine -match '--watchdog' } | Select-Object -ExpandProperty ProcessId`,
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return [];
  return String(result.stdout || '').split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function managedWindowsRunnerProcess() {
  if (PLAT !== 'win32') return null;
  let record;
  try { record = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); }
  catch { return null; }
  const pid = Number(record?.pid);
  const current = readWindowsProcess(pid);
  return isManagedWorkBuddyRunner(record, current, {
    stableHostRoot: STABLE_HOST_ROOT, sourceRunner: RUNNER, pidFile: PID_FILE,
  }) ? current : null;
}

function stopManagedDaemon() {
  try {
    if (PLAT === 'win32') {
      const managed = new Set(findWindowsRunnerPids());
      for (const pid of managed) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      }
    } else {
      if (!fs.existsSync(PID_FILE)) return;
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) return;
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  } finally {
    fs.rmSync(PID_FILE, { force: true });
  }
}

function startDaemon() {
  stopManagedDaemon();
  const logFile = PLAT === 'darwin' ? MAC_LOG : PLAT === 'win32' ? WIN_LOG : '/tmp/beauticode-wb-runner.log';
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(NODE, [RUNNER, '--watchdog'], {
    detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, [ENV_KEY]: port },
    windowsHide: true,
  });
  if (out !== null) fs.closeSync(out);
  child.unref();
  if (PLAT !== 'win32') fs.writeFileSync(PID_FILE, String(child.pid));
  log(`  ✓ 守护启动器已调用（pid ${child.pid}，日志 ${logFile}）`);
}

async function cdpUp() {
  return hasWorkBuddyCdp(Number(port));
}

// ── 命令 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(RUNNER)) {
  console.error(`找不到 ${RUNNER} —— 请在 beautiCode 仓库里运行本脚本`); process.exit(2);
}

if (cmd === 'status') {
  if (PLAT === 'win32' && process.argv.includes('--machine-status')) {
    let health = { state: 'probe-failed' };
    try {
      const adapterUrl = pathToFileURL(path.join(REPO, 'packages', 'adapter-workbuddy', 'dist', 'index.js')).href;
      const adapter = await import(adapterUrl);
      health = await adapter.inspectWorkBuddyUiHealth();
    } catch { /* report a sanitized failure instead of spawning the long-lived runner */ }
    process.stdout.write(JSON.stringify({
      installed: fs.existsSync(STARTUP_VBS),
      running: Boolean(managedWindowsRunnerProcess()),
      health,
    }) + '\n');
    process.exit(0);
  }
  log(`平台：${PLAT}   端口：${port}`);
  if (PLAT === 'darwin') statusMac(); else if (PLAT === 'win32') statusWin(); else statusLinux();
  log(`  CDP：${(await cdpUp()) ? '在线（WorkBuddy 正带着调试端口运行）' : '离线（WorkBuddy 未启动，或本次启动还没带 CDP）'}`);
  log('  提示：CDP 离线时点一次 WorkBuddy 图标，守护会在 3 秒内自动连上注入。');
  process.exit(0);
}

if (cmd === 'uninstall') {
  log('拆除 beautiCode × WorkBuddy：');
  stopManagedDaemon();
  if (PLAT === 'darwin') uninstallMac(); else if (PLAT === 'win32') uninstallWin(); else uninstallLinux();
  log('完成。已停止受管理的守护并拆除自启项。');
  process.exit(0);
}

if (PACKAGED_RUNTIME) {
  log('  ✓ 使用包内预构建 WorkBuddy adapter');
} else if (!fs.existsSync(path.join(REPO, 'package-lock.json'))) {
  throw new Error('包内 WorkBuddy runtime 不完整：缺少预构建 adapter；拒绝访问源码或临时 npm 缓存。');
} else {
  const build = spawnSync('npm', ['run', 'build', '-w', '@beauticode/adapter-workbuddy'], {
    cwd: REPO, encoding: 'utf8', shell: PLAT === 'win32',
  });
  log(build.status === 0 ? '  ✓ adapter 编译通过' : `  ✗ adapter 编译失败：\n${(build.stderr || build.stdout || '').slice(0, 400)}`);
}

// install — resolve and stage first; startup wiring is only replaced after
// the stable runtime and verified Node are ready.
log(`安装 beautiCode × WorkBuddy（${PLAT}，端口 ${port}）：`);
const stableRuntime = PLAT === 'win32' ? await prepareStableRuntime() : null;
writeConfiguredPort(port);
if (PLAT === 'darwin') installMac(); else if (PLAT === 'win32') await installWin(stableRuntime); else installLinux();

startDaemon();

const up = await cdpUp();
if (up) {
  log('  ✓ WorkBuddy CDP 在线 —— 注入应已完成，侧栏找「自定义背景」');
} else {
  log('  ⚠ WorkBuddy 当前没带 CDP（还没重启过）。点一次 WorkBuddy 图标重启它，');
  log('    守护会在 3 秒内自动连上注入 —— 之后每次点图标都直接生效。');
}
log('完成。卸载：node wb-setup.mjs uninstall');

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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(REPO, 'scripts', 'wb-cdp-runner.mjs');
const NODE = process.execPath;
const PLAT = process.platform; // darwin | win32 | linux
const ENV_KEY = 'WORKBUDDY_REMOTE_DEBUGGING_PORT';

// ── 参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let cmd = 'install';
let port = String(process.env[ENV_KEY] || '9335');
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === 'install' || a === 'uninstall' || a === 'status') cmd = a;
  else if (a === '--port' || a === '-p') port = String(parseInt(argv[++i], 10));
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

const log = (...m) => console.log(...m);
const run = (cmdline, opts = {}) => {
  try { return { ok: true, out: execSync(cmdline, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') + e.message }; }
};
const home = os.homedir();

// ── 各平台路径与实现 ──────────────────────────────────────────────────
const LAUNCHER_MAC = path.join(home, 'Library/LaunchAgents/com.beauticode.wb-runner.plist');
const MAC_LOG = path.join(home, 'Library/Logs/beauticode-wb-runner.log');
const STARTUP_VBS = path.join(home, 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/beauticode-wb-runner.vbs');
const WIN_LOG = path.join(
  process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
  'beauticode', 'logs', 'wb-runner.log',
);
const LINUX_ENV = path.join(home, '.config/environment.d/beauticode-wb.conf');
const LINUX_DESKTOP = path.join(home, '.config/autostart/beauticode-beauticode-wb-runner.desktop');
const PID_FILE = PLAT === 'win32'
  ? path.join(home, 'AppData', 'Roaming', 'beauticode', 'wb-runner.pid')
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

function vbsString(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
const winVbs = () => `CreateObject("WScript.Shell").Run ${vbsString(`"${NODE}" "${RUNNER}" --watchdog`)}, 0, False`;

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

function installWin() {
  const r = spawnSync('setx', [ENV_KEY, port], { encoding: 'utf8' });
  log(r.status === 0 ? '  ✓ setx 已持久化用户环境变量（点图标启动的 WorkBuddy 自带 CDP）'
                     : `  ✗ setx 失败：${r.stderr}`);
  fs.mkdirSync(path.dirname(STARTUP_VBS), { recursive: true });
  fs.writeFileSync(STARTUP_VBS, winVbs());
  log('  ✓ 已写入「启动」文件夹 VBS（登录自启、隐藏窗口）');
  if (process.env[ENV_KEY] !== port) {
    log('  ⚠ 当前会话还没继承新 env：注销重登一次，或先手动带 env 启动一次 WorkBuddy');
  }
}
function uninstallWin() {
  fs.rmSync(STARTUP_VBS, { force: true });
  run(`reg delete "HKCU\\Environment" /v ${ENV_KEY} /f`);
  log('  ✓ 已拆除启动项并删除用户环境变量');
}
function statusWin() {
  log(`  用户 env：${run('reg query "HKCU\\Environment" /v ' + ENV_KEY).out.includes(ENV_KEY) ? '已设置' : '未设置'}`);
  log(`  启动项：${fs.existsSync(STARTUP_VBS) ? '已安装' : '未安装'}`);
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

function stopManagedDaemon() {
  try {
    if (!fs.existsSync(PID_FILE)) return;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return;
    if (PLAT === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
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
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  log(`  ✓ 守护已启动（pid ${child.pid}，日志 ${logFile}）`);
}

async function cdpUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    return r.ok;
  } catch { return false; }
}

// ── 命令 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(RUNNER)) {
  console.error(`找不到 ${RUNNER} —— 请在 beautiCode 仓库里运行本脚本`); process.exit(2);
}

if (cmd === 'status') {
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

// install
log(`安装 beautiCode × WorkBuddy（${PLAT}，端口 ${port}）：`);
if (PLAT === 'darwin') installMac(); else if (PLAT === 'win32') installWin(); else installLinux();

const build = spawnSync('npm', ['run', 'build', '-w', '@beauticode/adapter-workbuddy'], {
  cwd: REPO, encoding: 'utf8', shell: PLAT === 'win32',
});
log(build.status === 0 ? '  ✓ adapter 编译通过' : `  ✗ adapter 编译失败：\n${(build.stderr || build.stdout || '').slice(0, 400)}`);

startDaemon();

const up = await cdpUp();
if (up) {
  log('  ✓ WorkBuddy CDP 在线 —— 注入应已完成，侧栏找「自定义背景」');
} else {
  log('  ⚠ WorkBuddy 当前没带 CDP（还没重启过）。点一次 WorkBuddy 图标重启它，');
  log('    守护会在 3 秒内自动连上注入 —— 之后每次点图标都直接生效。');
}
log('完成。卸载：node wb-setup.mjs uninstall');
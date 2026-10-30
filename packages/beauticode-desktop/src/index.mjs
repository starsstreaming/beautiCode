import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { queryWindowsInstallRecords, resolveRegisteredExecutable } from "./windows-host-install.mjs";
import { createHealthRunner } from "./health.mjs";
import { installHostQuickShortcut, removeLinuxQuickShortcut } from "./quick-shortcuts.mjs";

export { resolveRegisteredExecutable, writeVerifiedExecutableRecord } from "./windows-host-install.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Platforms with a supported install path. Linux skips Doubao (no Linux client). */
const SUPPORTED_PLATFORMS = Object.freeze(["win32", "linux"]);
const LINUX_UNSUPPORTED_HOSTS = Object.freeze(["doubao"]);

function xdgDir(env, key, home, fallback) {
  const value = env[key];
  return value && path.isAbsolute(value) ? value : path.join(home, ...fallback);
}

function canonicalStartupMarker(host, env, home) {
  const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `beauticode-${host}-runner.vbs`);
}

export const HOSTS = Object.freeze([
  "dsh",
  "codex",
  "workbuddy",
  "cursor",
  "doubao",
]);

export const COMMANDS = Object.freeze(["install", "status", "uninstall"]);

export const HOST_RUNTIME = Object.freeze({
  dsh: Object.freeze({
    required: Object.freeze([
      "dsh/index.mjs",
      "dsh/cli.js",
      "dsh/vendor/core/index.js",
      "dsh/vendor/core/skin-catalog.js",
      "dsh/vendor/adapter-dsh/index.js",
      "dsh/client.js",
      "dsh/console.js",
    ]),
  }),
  codex: Object.freeze({
    required: Object.freeze([
      "codex/cli.js",
      "codex/watch-host.mjs",
      "codex/codex-watchdog.mjs",
      "codex/lifecycle.mjs",
      "codex/task-wiring.mjs",
      "codex/health.mjs",
      "codex/portable-runtime.mjs",
      "codex/vendor/core/index.js",
      "codex/vendor/core/skin-catalog.js",
      "codex/vendor/adapter-codex/index.js",
      "codex/quick-launch.mjs",
      "codex/vendor/adapter-codex/renderer/background-runtime.js",
    ]),
  }),
  workbuddy: Object.freeze({
    required: Object.freeze([
      "workbuddy/scripts/wb-cdp-runner.mjs",
      "workbuddy/scripts/quick-launch.mjs",
      "workbuddy/scripts/wb-startup-media.mjs",
      "workbuddy/scripts/wb-runner-log.mjs",
      "workbuddy/scripts/wb-theme-name-diagnostic.mjs",
      "workbuddy/scripts/wb-setup.mjs",
      "workbuddy/scripts/portable-runtime.mjs",
      "workbuddy/packages/core/dist/index.js",
      "workbuddy/packages/core/dist/skin-catalog.js",
      "workbuddy/packages/adapter-workbuddy/dist/index.js",
      "workbuddy/packages/adapter-workbuddy/dist/background-bar.js",
      "workbuddy/packages/adapter-workbuddy/dist/background-stage.js",
    ]),
  }),
  cursor: Object.freeze({
    required: Object.freeze([
      "desktop/scripts/desktop-cdp-runner.mjs",
      "desktop/scripts/quick-launch.mjs",
      "desktop/scripts/desktop-cdp-setup.mjs",
      "desktop/scripts/desktop-runner-identity.mjs",
      "desktop/packages/beauticode-desktop/src/windows-host-install.mjs",
      "desktop/scripts/portable-runtime.mjs",
      "desktop/packages/core/dist/index.js",
      "desktop/packages/core/dist/skin-catalog.js",
      "desktop/packages/adapter-desktop-cdp/dist/index.js",
      "desktop/packages/adapter-cursor/dist/index.js",
      "desktop/packages/adapter-desktop-cdp/dist/runtime.js",
    ]),
  }),
  doubao: Object.freeze({
    required: Object.freeze([
      "desktop/scripts/desktop-cdp-runner.mjs",
      "desktop/scripts/quick-launch.mjs",
      "desktop/scripts/desktop-cdp-setup.mjs",
      "desktop/scripts/desktop-runner-identity.mjs",
      "desktop/packages/beauticode-desktop/src/windows-host-install.mjs",
      "desktop/scripts/portable-runtime.mjs",
      "desktop/packages/core/dist/index.js",
      "desktop/packages/core/dist/skin-catalog.js",
      "desktop/packages/adapter-desktop-cdp/dist/index.js",
      "desktop/packages/adapter-doubao/dist/index.js",
      "desktop/packages/adapter-desktop-cdp/dist/runtime.js",
    ]),
  }),
});

export function parseCommand(argv) {
  const args = Array.from(argv ?? [], String);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }
  const host = args[0].toLowerCase();
  if (host === "all") {
    const command = (args[1] || "").toLowerCase();
    if (command !== "install" && command !== "status" && command !== "health") throw new Error("all 仅支持 install、status 或 health。");
    if (args.length > 2) throw new Error("命令参数过多。");
    return { kind: "all", command };
  }
  if (!HOSTS.includes(host)) throw new Error(`未知宿主：${args[0]}`);
  const command = (args[1] || "").toLowerCase();
  if (!COMMANDS.includes(command) && command !== "health") throw new Error(`未知命令：${args[1] || ""}`);
  if (args.length > 2) throw new Error("命令参数过多。");
  return { kind: "host", host, command };
}

export function helpText(cliName = "beauticode-desktop", platform = process.platform) {
  const lines = [
    `用法：${cliName} <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall|health>`,
    `      ${cliName} all <install|status|health>`,
    "",
    "宿主：dsh、codex、workbuddy、cursor、doubao",
    "命令：install 安装后台接线；status 检查守护；health 检查宿主、CDP 与背景入口；uninstall 卸载后台接线",
    "提示：各宿主的 install/uninstall 只调用包内运行时；不会依赖源码 workspace。",
    "all install 安装守护并创建四个背景版开始菜单快捷方式；安装时不启动客户端。原图标仍由守护兜底。",
  ];
  if (platform === "linux") {
    lines.push("Linux：支持 codex、workbuddy、cursor（以及已安装的 dsh）；守护写入 ~/.config/autostart，背景版启动项写入 ~/.local/share/applications；doubao 无 Linux 客户端，自动跳过。");
  }
  return lines.join("\n");
}

function defaultOptions(options = {}) {
  return {
    runtimeRoot: options.runtimeRoot || path.resolve(here, "..", "runtime"),
    home: options.home || os.homedir(),
    env: options.env || process.env,
    platform: options.platform || process.platform,
    exists: options.exists || fs.existsSync,
    probeAppxCodex: options.probeAppxCodex || packagedCodexPresent,
    queryRegistered: options.queryRegistered || queryWindowsInstallRecords,
    realpath: options.realpath || fs.realpathSync.native,
    lstat: options.lstat || fs.lstatSync,
    verifyHostInstall: options.verifyHostInstall || verifyHostInstall,
    installShortcut: options.installShortcut || installHostQuickShortcut,
    spawnSync: options.spawnSync || spawnSync,
  };
}

function installationMarkers(host, options) {
  const { home, env, platform } = options;
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  if (host === "dsh") {
    const dshHome = env.DSH_HOME || path.join(home, ".dsh");
    return [
      path.join(dshHome, "cordis.patch.yml"),
      path.join(dshHome, "profiles", "web", "cordis.patch.yml"),
      path.join(dshHome, "plugins", "beauticode-dsh"),
    ];
  }
  if (host === "codex") {
    const root = env.BEAUTICODE_DATA_ROOT || (platform === "linux"
      ? env.LOCALAPPDATA || xdgDir(env, "XDG_DATA_HOME", home, [".local", "share"])
      : localAppData);
    return [path.join(root, "beautiCode", "codex-plugin", "codex-watchdog.mjs")];
  }
  if (host === "workbuddy") {
    if (platform === "win32") return [canonicalStartupMarker("wb", env, home)];
    if (platform === "darwin") return [path.join(home, "Library", "LaunchAgents", "com.beauticode.wb-runner.plist")];
    return [path.join(home, ".config", "autostart", "beauticode-beauticode-wb-runner.desktop")];
  }
  if (platform === "win32") return [canonicalStartupMarker(host, env, home)];
  if (platform === "linux") {
    return [path.join(xdgDir(env, "XDG_CONFIG_HOME", home, [".config"]), "autostart", `beauticode-${host}-runner.desktop`)];
  }
  return [path.join(appData, `beauticode-${host}-runner.vbs`)];
}

export function getHostStatus(host, options = {}) {
  if (!HOSTS.includes(host)) throw new Error(`未知宿主：${host}`);
  const resolved = defaultOptions(options);
  const required = HOST_RUNTIME[host].required;
  const missingRuntime = required.filter((relative) => !resolved.exists(path.join(resolved.runtimeRoot, relative)));
  const installed = installationMarkers(host, resolved).some((marker) => resolved.exists(marker));
  return {
    host,
    runtimeReady: missingRuntime.length === 0,
    missingRuntime,
    installed,
  };
}

export function statusText(status) {
  return JSON.stringify(status, null, 2);
}

function windowsExecutableCandidates(host, env, home) {
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  if (host === "codex") return [
    path.join(local, "Programs", "ChatGPT", "ChatGPT.exe"),
    path.join(local, "Programs", "chatgpt", "ChatGPT.exe"),
    path.join(local, "Programs", "Codex", "Codex.exe"),
    path.join(local, "Programs", "codex", "Codex.exe"),
    path.join(local, "OpenAI", "Codex", "Codex.exe"),
    path.join(local, "OpenAI", "ChatGPT", "ChatGPT.exe"),
    path.join(local, "Codex", "app", "Codex.exe"),
    path.join(programFiles, "Codex", "Codex.exe"),
    path.join(programFiles, "ChatGPT", "ChatGPT.exe"),
    path.join(programFilesX86, "ChatGPT", "ChatGPT.exe"),
  ];
  if (host === "workbuddy") return [
    path.join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"),
    path.join(local, "WorkBuddy", "WorkBuddy.exe"),
    path.join(programFiles, "WorkBuddy", "WorkBuddy.exe"),
    path.join(programFilesX86, "WorkBuddy", "WorkBuddy.exe"),
  ];
  if (host === "cursor") return [
    path.join(local, "Programs", "cursor", "Cursor.exe"),
    path.join(programFiles, "Cursor", "Cursor.exe"),
    path.join(programFilesX86, "Cursor", "Cursor.exe"),
  ];
  if (host === "doubao") return [
    path.join(local, "Doubao", "Doubao.exe"),
    path.join(local, "Programs", "Doubao", "Doubao.exe"),
    path.join(programFiles, "Doubao", "Doubao.exe"),
    "D:\\Doubao\\app\\Doubao.exe",
  ];
  return [];
}

/** Mirrors the adapters' Linux executable candidates (deb/rpm/opt and per-user installs). */
function linuxExecutableCandidates(host, env, home) {
  const data = xdgDir(env, "XDG_DATA_HOME", home, [".local", "share"]);
  if (host === "codex") return [
    "/usr/lib/chatgpt/ChatGPT", "/opt/ChatGPT/ChatGPT", "/opt/chatgpt/ChatGPT",
    "/usr/lib/codex/Codex", "/opt/Codex/Codex",
    path.join(data, "chatgpt", "ChatGPT"), path.join(home, ".local", "opt", "ChatGPT", "ChatGPT"),
  ];
  if (host === "workbuddy") return [
    "/opt/WorkBuddy/workbuddy", "/opt/workbuddy/workbuddy", "/usr/lib/workbuddy/workbuddy",
    path.join(data, "WorkBuddy", "workbuddy"),
  ];
  if (host === "cursor") return [
    ...(env.BEAUTICODE_CURSOR_EXECUTABLE ? [env.BEAUTICODE_CURSOR_EXECUTABLE] : []),
    "/usr/share/cursor/cursor", "/opt/Cursor/cursor", "/opt/cursor/cursor",
    path.join(data, "cursor", "cursor"), path.join(home, "Applications", "cursor", "cursor"),
  ];
  return [];
}

function commandOnPath(command, options) {
  const pathValue = options.env.PATH || options.env.Path || "";
  if (options.platform === "linux") {
    return pathValue.split(":").filter(Boolean).some((directory) => options.exists(path.join(directory, command)));
  }
  return pathValue.split(";").filter(Boolean).some((directory) =>
    [".cmd", ".exe", ".bat"].some((extension) =>
      options.exists(path.join(directory, `${command}${extension}`)),
    ),
  );
}

function packagedCodexPresent(options) {
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | ForEach-Object { $_.InstallLocation }",
    ], { encoding: "utf8", windowsHide: true, timeout: 12_000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) return false;
    return String(result.stdout || "").split(/\r?\n/).some((line) => {
      const installRoot = line.trim();
      return path.win32.isAbsolute(installRoot) && options.exists(path.win32.join(installRoot, "app", "ChatGPT.exe"));
    });
  } catch {
    return false;
  }
}

/** Detection is deliberately read-only. Unknown custom installs can use per-host install. */
export function detectHostAvailability(host, options = {}) {
  if (!HOSTS.includes(host)) throw new Error(`未知宿主：${host}`);
  const resolved = defaultOptions(options);
  if (!SUPPORTED_PLATFORMS.includes(resolved.platform) ||
    (resolved.platform === "linux" && LINUX_UNSUPPORTED_HOSTS.includes(host))) {
    return { host, available: false, reason: "unsupported-platform" };
  }
  if (host === "dsh") {
    const dshHome = resolved.env.DSH_HOME || path.join(resolved.home, ".dsh");
    const plugin = path.join(dshHome, "plugins", "beauticode-dsh", "index.mjs");
    if (resolved.exists(plugin) || resolved.exists(dshHome) || commandOnPath("dsh", resolved)) {
      return { host, available: true, reason: "detected" };
    }
  } else if (resolved.platform === "linux") {
    if (getHostStatus(host, resolved).installed ||
      linuxExecutableCandidates(host, resolved.env, resolved.home).some(resolved.exists)) {
      return { host, available: true, reason: "detected" };
    }
  } else {
    const installed = getHostStatus(host, resolved).installed;
    if (installed || windowsExecutableCandidates(host, resolved.env, resolved.home).some(resolved.exists) ||
      ((host === "cursor" || host === "doubao") && resolveRegisteredExecutable(host, {
        query: resolved.queryRegistered, exists: resolved.exists, realpath: resolved.realpath,
      })) ||
      (host === "codex" && resolved.probeAppxCodex(resolved))) {
      return { host, available: true, reason: "detected" };
    }
  }
  return { host, available: false, reason: "host-not-found" };
}

export function runAllInstall(options = {}) {
  const resolved = defaultOptions(options);
  if (!SUPPORTED_PLATFORMS.includes(resolved.platform)) throw new Error("all install 仅支持 Windows 和 Linux。");
  const results = [];
  for (const host of HOSTS) {
    try {
      const detection = detectHostAvailability(host, resolved);
      if (!detection.available) {
        results.push({ host, outcome: "skipped", reason: detection.reason });
        continue;
      }
      const dshLinkConflict = host === "dsh" ? inspectDshLinkConflict(resolved) : null;
      if (dshLinkConflict) {
        results.push({ host, outcome: "conflict", reason: dshLinkConflict });
        continue;
      }
      const status = getHostStatus(host, resolved);
      if (!status.runtimeReady) {
        results.push({ host, outcome: "failed", reason: "runtime-incomplete" });
        continue;
      }
      runHostCommand(host, "install", options);
      const verification = resolved.verifyHostInstall(host, resolved, true);
      if (!verification.ready) {
        results.push({ host, outcome: "failed", reason: verification.reason || "guardian-not-ready" });
        continue;
      }
      const shortcut = host === "dsh" ? null : resolved.installShortcut(host, resolved.platform === "linux"
        ? { platform: "linux", home: resolved.home, localAppData: resolved.env.LOCALAPPDATA, xdgDataHome: resolved.env.XDG_DATA_HOME }
        : {
          localAppData: resolved.env.LOCALAPPDATA,
          appData: resolved.env.APPDATA,
        });
      results.push({ host, outcome: "installed", readiness: verification.state || "guardian-ready", shortcut: shortcut?.path ?? null, action: shortcut ? "open-background-shortcut" : "wait-for-launch" });
    } catch (error) {
      results.push({ host, outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { command: "install", results, ok: results.some((entry) => entry.outcome === "installed") && !results.some((entry) => entry.outcome === "failed" || entry.outcome === "conflict") };
}

function inspectDshLinkConflict(options) {
  const dshHome = options.env.DSH_HOME || path.join(options.home, ".dsh");
  const link = path.join(dshHome, "profiles", "web", "node_modules", "beauticode-dsh");
  let stat;
  try { stat = options.lstat(link); }
  catch (error) { return error?.code === "ENOENT" ? null : "dsh-link-inspection-failed"; }
  if (!stat?.isSymbolicLink()) return null;

  const managed = path.join(dshHome, "plugins", "beauticode-dsh");
  try {
    // Only the exact resolved installer target is managed; dangling or unknown links must not be overwritten.
    const canonical = (candidate) => {
      const normalized = path.win32.normalize(candidate);
      const withoutNamespace = normalized.startsWith("\\\\?\\") ? normalized.slice(4) : normalized;
      return withoutNamespace.replace(/[\\\\]+$/, "").toLowerCase();
    };
    return canonical(options.realpath(link)) === canonical(options.realpath(managed))
      ? null
      : "foreign-dsh-junction";
  } catch {
    return "dsh-link-target-unresolved";
  }
}

function verifyHostInstall(host, options, waitForGuardian = false) {
  if (host === "dsh") return { ready: true, state: "plugin-ready" };
  const deadline = Date.now() + (waitForGuardian && (host === "codex" || host === "workbuddy") ? 15_000 : 0);
  let verification;
  do {
    verification = probeHostInstallOnce(host, options);
    if (verification.ready || Date.now() >= deadline) return verification;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  } while (true);
}

function probeHostInstallOnce(host, options) {
  const runtimeRoot = options.runtimeRoot;
  const script = host === "codex"
    ? path.join(runtimeRoot, "codex", "cli.js")
    : host === "workbuddy"
      ? path.join(runtimeRoot, "workbuddy", "scripts", "wb-setup.mjs")
      : path.join(runtimeRoot, "desktop", "scripts", "desktop-cdp-setup.mjs");
  const args = host === "codex" ? ["--health"]
    : host === "workbuddy" ? ["status", "--machine-status"]
      : ["--host", host, "status"];
  const result = (options.spawnSync || spawnSync)(process.execPath, [script, ...args], {
    cwd: runtimeRoot,
    env: { ...process.env, ...options.env, BEAUTICODE_PACKAGED_RUNTIME: "1" },
    encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return { ready: false, reason: "status-probe-failed" };
  let status;
  try { status = JSON.parse(String(result.stdout || "")); }
  catch { return { ready: false, reason: "status-invalid" }; }
  if (host === "codex") {
    return status.installation === "ready" && status.guardian === "running"
      ? { ready: true, state: "guardian-ready" }
      : { ready: false, reason: status.reason || "guardian-not-ready" };
  }
  return status.installed === true && status.running === true
    ? { ready: true, state: "guardian-ready" }
    : { ready: false, reason: "guardian-not-ready" };
}

export function getAllStatus(options = {}) {
  const resolved = defaultOptions(options);
  return { command: "status", hosts: HOSTS.map((host) => {
    const status = getHostStatus(host, resolved);
    if (host === "dsh") {
      const conflict = resolved.platform === "win32" ? inspectDshLinkConflict(resolved) : null;
      return {
        ...status,
        guardian: "not-applicable",
        readiness: conflict ? "conflict" : status.installed ? "plugin-ready" : "not-installed",
        ...(conflict ? { reason: conflict } : {}),
      };
    }
    if (!status.installed || !status.runtimeReady || !SUPPORTED_PLATFORMS.includes(resolved.platform)) {
      return { ...status, guardian: "not-checked" };
    }
    const verification = resolved.verifyHostInstall(host, resolved);
    return { ...status, guardian: verification.ready ? "running" : "not-ready", reason: verification.reason || null };
  }) };
}

export function resolveRoute(host, command, options = {}) {
  if (!HOSTS.includes(host)) throw new Error(`未知宿主：${host}`);
  if (!COMMANDS.includes(command) && command !== "health") throw new Error(`未知命令：${command}`);
  if (command === "health") return { host, command, readOnly: true };
  if (command === "status") return { host, command, readOnly: true };
  const runtimeRoot = options.runtimeRoot || path.resolve(here, "..", "runtime");
  if (host === "dsh") {
    return {
      host,
      command,
      script: path.join(runtimeRoot, "dsh", "bin", "beauticode-dsh"),
      args: command === "uninstall" ? ["--remove"] : [],
    };
  }
  if (host === "codex") {
    return {
      host,
      command,
      script: path.join(runtimeRoot, "codex", "cli.js"),
      args: command === "uninstall" ? ["--remove"] : [],
    };
  }
  if (host === "workbuddy") {
    return {
      host,
      command,
      script: path.join(runtimeRoot, "workbuddy", "scripts", "wb-setup.mjs"),
      args: [command],
    };
  }
  return {
    host,
    command,
    script: path.join(runtimeRoot, "desktop", "scripts", "desktop-cdp-setup.mjs"),
    args: ["--host", host, command],
  };
}

export function runHostCommand(host, command, options = {}) {
  const route = resolveRoute(host, command, options);
  if (command === "health") throw new Error("Use the asynchronous runHostHealth API for health checks.");
  if (route.readOnly) return getHostStatus(host, options);
  const runtimeRoot = options.runtimeRoot || path.resolve(here, "..", "runtime");
  const result = (options.spawnSync || spawnSync)(process.execPath, [route.script, ...route.args], {
    cwd: runtimeRoot,
    env: { ...process.env, ...(options.env || {}), BEAUTICODE_PACKAGED_RUNTIME: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${host} ${command} failed with exit code ${result.status ?? "unknown"}`);
  }
  if (command === "uninstall" && host !== "dsh" && (options.platform || process.platform) === "linux") {
    // Linux clean uninstall also drops our own "(背景)" application entry.
    (options.removeShortcut || removeLinuxQuickShortcut)(host, { home: options.home, xdgDataHome: options.env?.XDG_DATA_HOME });
  }
  return { host, command, ok: true };
}

export async function runCodexHealth(options = {}) {
  const runtimeRoot = options.runtimeRoot || path.resolve(here, "..", "runtime");
  const modulePath = path.join(runtimeRoot, "codex", "health.mjs");
  if (!(options.exists || fs.existsSync)(modulePath)) {
    return { installation: "missing", taskOwned: false, guardian: "unknown", host: "closed", cdp: "unknown", entry: "not-checked", primaryPages: 0, action: "inspect-guardian", reason: "runtime-missing" };
  }
  const { pathToFileURL } = await import("node:url");
  const { probeLocalCodexHealth } = await import(pathToFileURL(modulePath).href);
  return probeLocalCodexHealth();
}

const health = createHealthRunner({
  hosts: HOSTS,
  defaultOptions,
  getHostStatus,
  inspectDshLinkConflict,
  runCodexHealth,
  defaultRuntimeRoot: path.resolve(here, "..", "runtime"),
});
export const runHostHealth = health.runHostHealth;
export const runAllHealth = health.runAllHealth;

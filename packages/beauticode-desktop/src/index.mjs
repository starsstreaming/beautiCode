import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));

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
      "codex/vendor/core/index.js",
      "codex/vendor/core/skin-catalog.js",
      "codex/vendor/adapter-codex/index.js",
      "codex/vendor/adapter-codex/renderer/background-runtime.js",
    ]),
  }),
  workbuddy: Object.freeze({
    required: Object.freeze([
      "workbuddy/scripts/wb-cdp-runner.mjs",
      "workbuddy/scripts/wb-setup.mjs",
      "workbuddy/packages/core/dist/index.js",
      "workbuddy/packages/core/dist/skin-catalog.js",
      "workbuddy/packages/adapter-workbuddy/dist/index.js",
      "workbuddy/packages/adapter-workbuddy/dist/background-bar.js",
    ]),
  }),
  cursor: Object.freeze({
    required: Object.freeze([
      "desktop/scripts/desktop-cdp-runner.mjs",
      "desktop/scripts/desktop-cdp-setup.mjs",
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
      "desktop/scripts/desktop-cdp-setup.mjs",
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
  if (!HOSTS.includes(host)) throw new Error(`未知宿主：${args[0]}`);
  const command = (args[1] || "").toLowerCase();
  if (!COMMANDS.includes(command)) throw new Error(`未知命令：${args[1] || ""}`);
  if (args.length > 2) throw new Error("命令参数过多。");
  return { kind: "host", host, command };
}

export function helpText() {
  return [
    "用法：beauticode-desktop <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall>",
    "",
    "宿主：dsh、codex、workbuddy、cursor、doubao",
    "命令：install 安装后台接线；status 只读检查；uninstall 卸载后台接线",
    "提示：各宿主的 install/uninstall 只调用包内运行时；不会依赖源码 workspace。",
  ].join("\n");
}

function defaultOptions(options = {}) {
  return {
    runtimeRoot: options.runtimeRoot || path.resolve(here, "..", "runtime"),
    home: options.home || os.homedir(),
    env: options.env || process.env,
    platform: options.platform || process.platform,
    exists: options.exists || fs.existsSync,
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
    const root = env.BEAUTICODE_DATA_ROOT || localAppData;
    return [path.join(root, "beautiCode", "codex-plugin", "codex-watchdog.mjs")];
  }
  if (host === "workbuddy") {
    if (platform === "win32") return [path.join(appData, "beauticode-wb-runner.vbs")];
    if (platform === "darwin") return [path.join(home, "Library", "LaunchAgents", "com.beauticode.wb-runner.plist")];
    return [path.join(home, ".config", "autostart", "beauticode-beauticode-wb-runner.desktop")];
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

export function resolveRoute(host, command, options = {}) {
  if (!HOSTS.includes(host)) throw new Error(`未知宿主：${host}`);
  if (!COMMANDS.includes(command)) throw new Error(`未知命令：${command}`);
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
  return { host, command, ok: true };
}

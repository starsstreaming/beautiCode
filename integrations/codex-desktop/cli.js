#!/usr/bin/env node
/**
 * npx beauticode-codex — copy a stable watch host and start it on login.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recoverStaleCodexLock, stopInstalledCodexGuardians } from "./lifecycle.mjs";
import { createCodexRunKeyAdapter, createCodexTaskAdapter, installCodexWiring, uninstallCodexWiring } from "./task-wiring.mjs";
import { probeLocalCodexHealth } from "./health.mjs";

function findPackageRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i += 1) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "watch-host.mjs"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

const here = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

function pluginHome() {
  const local = process.env.LOCALAPPDATA || process.env.BEAUTICODE_DATA_ROOT;
  if (local) return path.join(local, "beautiCode", "codex-plugin");
  return path.join(os.homedir(), ".beauticode", "codex-plugin");
}

async function copyJsTree(fromDir, toDir) {
  await fsp.mkdir(toDir, { recursive: true });
  const entries = await fsp.readdir(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith(".map") || entry.name.endsWith(".d.ts")) continue;
    const source = path.join(fromDir, entry.name);
    const dest = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      await copyJsTree(source, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".css")) continue;
    await fsp.copyFile(source, dest);
  }
}

async function loadPortableRuntime() {
  const bundled = path.join(here, "portable-runtime.mjs");
  if (fs.existsSync(bundled)) return import(pathToFileURL(bundled).href);
  const source = path.resolve(here, "../../scripts/portable-runtime.mjs");
  return import(pathToFileURL(source).href);
}

function codexRuntimeFilter(relative, entry) {
  const normalized = relative.replaceAll("\\", "/");
  const prefixes = ["watch-host.mjs", "codex-watchdog.mjs", "lifecycle.mjs", "task-wiring.mjs", "health.mjs", "quick-launch.mjs", "package.json", "vendor/"];
  return entry.isDirectory()
    ? prefixes.some((prefix) => prefix.startsWith(normalized) || normalized.startsWith(prefix))
    : prefixes.some((prefix) => prefix.endsWith("/") ? normalized.startsWith(prefix) : normalized === prefix);
}

async function copyFileAtomic(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fsp.copyFile(source, temporary);
  await fsp.rename(temporary, destination).catch(async (error) => {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  });
}

function rewriteCoreImports(text) {
  return text
    .replaceAll('from "@beauticode/core"', 'from "../core/index.js"')
    .replaceAll("from '@beauticode/core'", "from '../core/index.js'");
}

async function ensureVendor(destRoot) {
  const vendorRoot = path.join(destRoot, "vendor");
  const vendorAdapter = path.join(vendorRoot, "adapter-codex");
  const temporaryVendor = `${vendorRoot}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fsp.rm(temporaryVendor, { recursive: true, force: true });
  const packed = path.join(here, "vendor", "adapter-codex");
  if (fs.existsSync(path.join(packed, "index.js"))) {
    await copyJsTree(path.join(here, "vendor"), temporaryVendor);
    await fsp.rm(vendorRoot, { recursive: true, force: true });
    await fsp.rename(temporaryVendor, vendorRoot);
    return;
  }
  const repoCore = path.resolve(here, "../../packages/core/dist");
  const repoAdapter = path.resolve(here, "../../packages/adapter-codex/dist");
  if (!fs.existsSync(path.join(repoAdapter, "index.js"))) {
    throw new Error("缺少 adapter-codex 产物。请先运行 npm run build。");
  }
  const temporaryAdapter = path.join(temporaryVendor, "adapter-codex");
  await copyJsTree(repoCore, path.join(temporaryVendor, "core"));
  await copyJsTree(repoAdapter, temporaryAdapter);
  for (const name of await fsp.readdir(temporaryAdapter)) {
    if (!name.endsWith(".js")) continue;
    const filePath = path.join(temporaryAdapter, name);
    await fsp.writeFile(filePath, rewriteCoreImports(await fsp.readFile(filePath, "utf8")));
  }
  await fsp.rm(vendorRoot, { recursive: true, force: true });
  await fsp.rename(temporaryVendor, vendorRoot);
}

function startHidden(node, script) {
  const child = spawn(node, [script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function resumeLegacyGuardian(starter) {
  const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${starter}"`;
  const literal = `'${command.replaceAll("'", "''")}'`;
  const script = `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${literal}}; if(-not $r -or $r.ReturnValue -ne 0){exit 1}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    stdio: "ignore", windowsHide: true, timeout: 5_000,
  });
}

export function parseCodexCliMode(argv) {
  if (argv.length === 0) return "install";
  if (argv.length !== 1) throw new Error("Unknown Codex option");
  if (argv[0] === "--health" || argv[0] === "--status") return "health";
  if (argv[0] === "--remove") return "remove";
  if (argv[0] === "--help") return "help";
  throw new Error("Unknown Codex option");
}

export async function runCli(argv = process.argv.slice(2)) {
  const mode = parseCodexCliMode(argv);
  if (mode === "help") {
    console.log("Usage: beauticode-codex [--health|--status|--remove|--help]");
    return;
  }
  if (mode === "health") {
    console.log(JSON.stringify(await probeLocalCodexHealth(), null, 2));
    return;
  }
  const home = pluginHome();
  if (mode === "remove") {
    if (process.platform === "win32") {
      await uninstallCodexWiring({
        task: createCodexTaskAdapter(path.join(home, "start-watch.ps1")),
        runKey: createCodexRunKeyAdapter(path.join(home, "start-watch.ps1")),
        stopOwned: async () => { stopInstalledCodexGuardians(home, home); },
      });
    }
    console.log("已取消开机自动注入。打开 Codex 前请自行启动 beautiCode。");
    return;
  }
  await fsp.mkdir(home, { recursive: true });
  for (const name of ["watch-host.mjs", "codex-watchdog.mjs", "lifecycle.mjs", "task-wiring.mjs", "health.mjs", "quick-launch.mjs", "package.json"]) {
    const source = name === "quick-launch.mjs" && !fs.existsSync(path.join(here, name))
      ? path.resolve(here, "../../scripts/quick-launch.mjs")
      : path.join(here, name);
    await copyFileAtomic(source, path.join(home, name));
  }
  await ensureVendor(home);
  const portable = await loadPortableRuntime();
  const runtime = await portable.syncStableRuntime({
    sourceRoot: home,
    stableRoot: path.dirname(home),
    host: path.basename(home),
    entrypoint: "codex-watchdog.mjs",
    filter: codexRuntimeFilter,
    activate: false,
  });
  const oldPointer = await fsp.readFile(runtime.pointerPath, "utf8").catch(() => null);
  try {
    await portable.resolveNodeExecutable({ stableRoot: runtime.hostRoot });
    await portable.activateStableRuntime(runtime);
  } catch (error) {
    await portable.discardStableRuntime(runtime);
    throw error;
  }
  const watch = path.join(home, "codex-watchdog.mjs");
  const starter = path.join(home, "start-watch.ps1");
  await portable.writeTextAtomic(starter, portable.renderCodexStarter({ launcher: runtime.launcher }));
  const namespaceLock = path.join(home, "..", "hosts", "codex", "injector.lock");
  await recoverStaleCodexLock(namespaceLock, home).catch(() => false);
  if (process.platform === "win32") {
    try {
      await installCodexWiring({
        task: createCodexTaskAdapter(starter),
        runKey: createCodexRunKeyAdapter(starter),
        stopOld: async () => stopInstalledCodexGuardians(home, runtime.hostRoot),
        rollbackRuntime: async () => {
          if (oldPointer !== null) await portable.writeTextAtomic(runtime.pointerPath, oldPointer);
          else await fsp.rm(runtime.pointerPath, { force: true });
        },
        resumeOld: async () => resumeLegacyGuardian(starter),
        starter,
      });
    } catch (error) {
      if (oldPointer !== null) await portable.writeTextAtomic(runtime.pointerPath, oldPointer);
      else await fsp.rm(runtime.pointerPath, { force: true });
      await portable.discardStableRuntime(runtime);
      throw error;
    }
  } else {
    const node = await portable.resolveNodeExecutable({ stableRoot: runtime.hostRoot });
    startHidden(node.path, watch);
  }
  console.log("已安装 Codex 后台注入。");
  console.log("打开 Codex Desktop 后，侧栏「探索」下方会出现「背景」。");
  console.log(`常驻目录：${home}`);
  console.log("卸载：npx beauticode-codex --remove");
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

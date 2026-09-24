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
import { recoverStaleCodexLock } from "./lifecycle.mjs";

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
const RUN_VALUE = "BeautiCodeCodex";

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

function writeRunKey(command) {
  if (process.platform !== "win32") return;
  execFileSync(
    "reg",
    [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      RUN_VALUE,
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ],
    { stdio: "pipe" },
  );
}

function removeRunKey() {
  if (process.platform !== "win32") return;
  try {
    execFileSync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", RUN_VALUE, "/f"], {
      stdio: "pipe",
    });
  } catch {
    /* already absent */
  }
}

function startHidden(node, script) {
  const child = spawn(node, [script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function startIndependentWindows(starter) {
  const commandLine =
    `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${JSON.stringify(starter)}`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} }`,
    "if ($null -eq $result) { throw 'Win32_Process.Create returned no result' }",
    "if ([int]$result.ReturnValue -ne 0) { exit [int]$result.ReturnValue }",
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: "pipe", windowsHide: true },
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  const home = pluginHome();
  const remove = argv.includes("--remove");
  if (remove) {
    removeRunKey();
    console.log("已取消开机自动注入。打开 Codex 前请自行启动 beautiCode。");
    return;
  }
  await fsp.mkdir(home, { recursive: true });
  for (const name of ["watch-host.mjs", "codex-watchdog.mjs", "lifecycle.mjs", "package.json"]) {
    await copyFileAtomic(path.join(here, name), path.join(home, name));
  }
  await ensureVendor(home);
  const watch = path.join(home, "codex-watchdog.mjs");
  const starter = path.join(home, "start-watch.ps1");
  const starterText =
    `Start-Process -WindowStyle Hidden -FilePath ${JSON.stringify(process.execPath)} -ArgumentList ${JSON.stringify(watch)}\r\n`;
  await fsp.writeFile(`${starter}.tmp-${process.pid}-${crypto.randomUUID()}`, starterText, "utf8");
  const starterTemp = (await fsp.readdir(home)).find((name) => name.startsWith("start-watch.ps1.tmp-"));
  if (!starterTemp) throw new Error("无法准备 Codex watcher 启动脚本。");
  await fsp.rename(path.join(home, starterTemp), starter);
  const namespaceLock = path.join(home, "..", "hosts", "codex", "injector.lock");
  await recoverStaleCodexLock(namespaceLock, home).catch(() => false);
  writeRunKey(`powershell.exe -NoProfile -WindowStyle Hidden -File "${starter}"`);
  if (process.platform === "win32") {
    try {
      startIndependentWindows(starter);
    } catch (error) {
      console.warn(
        `本次未能立即启动后台监视器：${error instanceof Error ? error.message : String(error)}。下次登录时会自动启动。`,
      );
    }
  } else {
    startHidden(process.execPath, watch);
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

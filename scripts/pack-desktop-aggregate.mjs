#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageCodexPlugin } from "./pack-codex-plugin.mjs";
import { stageDshPlugin } from "./pack-dsh-plugin.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sourceRoot = path.join(repoRoot, "packages", "beauticode-desktop");

export function defaultStageDir() {
  return path.join(repoRoot, "artifacts", "desktop-aggregate");
}

function runBuild() {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) throw new Error("Failed to build the desktop aggregate runtimes.");
}

async function copyTree(fromDir, toDir, filter = () => true) {
  await fsp.mkdir(toDir, { recursive: true });
  for (const entry of await fsp.readdir(fromDir, { withFileTypes: true })) {
    if (!filter(entry.name, entry)) continue;
    const source = path.join(fromDir, entry.name);
    const dest = path.join(toDir, entry.name);
    if (entry.isDirectory()) await copyTree(source, dest, filter);
    else if (entry.isFile()) await fsp.copyFile(source, dest);
  }
}

async function copyJsTree(fromDir, toDir) {
  await copyTree(fromDir, toDir, (name, entry) =>
    entry.isDirectory() || (name.endsWith(".js") || name.endsWith(".css")) && !name.endsWith(".d.ts"),
  );
}

async function copyText(from, to, rewrite = (value) => value) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, rewrite(await fsp.readFile(from, "utf8")), "utf8");
}

function rewriteDesktopRunner(text) {
  return text
    .replaceAll("loadModule('@beauticode/adapter-desktop-cdp', '../packages/adapter-desktop-cdp/dist/index.js')", "loadModule('../packages/adapter-desktop-cdp/dist/index.js', '../packages/adapter-desktop-cdp/dist/index.js')")
    .replaceAll("loadModule('@beauticode/core', '../packages/core/dist/index.js')", "loadModule('../packages/core/dist/index.js', '../packages/core/dist/index.js')")
    .replaceAll("loadModule('@beauticode/adapter-cursor', '../packages/adapter-cursor/dist/index.js')", "loadModule('../packages/adapter-cursor/dist/index.js', '../packages/adapter-cursor/dist/index.js')")
    .replaceAll("loadModule('@beauticode/adapter-doubao', '../packages/adapter-doubao/dist/index.js')", "loadModule('../packages/adapter-doubao/dist/index.js', '../packages/adapter-doubao/dist/index.js')");
}

function rewriteWorkbuddyRunner(text) {
  return text
    .replaceAll("'@beauticode/adapter-workbuddy',", "'../packages/adapter-workbuddy/dist/index.js',")
    .replaceAll("await import('@beauticode/core')", "await import('../packages/core/dist/index.js')")
    .replaceAll("无法导入 @beauticode/adapter-workbuddy", "无法导入 WorkBuddy adapter");
}

function rewriteWorkbuddySetup(text) {
  const rewritten = text.replace(
    /if \(PACKAGED_RUNTIME\) \{[\s\S]*?^\}\r?\n\r?\nstartDaemon\(\);/m,
    "if (PACKAGED_RUNTIME) {\n  log('  ✓ 使用包内预构建 WorkBuddy adapter');\n}\n\nstartDaemon();",
  );
  // 复审 I-2：正则失配时 String.replace 静默返回原文，打包产物会退化成
  // 「每次启动跑 npm run build」且无任何信号。必须断言替换真的发生。
  if (rewritten === text) {
    throw new Error(
      "rewriteWorkbuddySetup 未命中 PACKAGED_RUNTIME 块；wb-setup.mjs 模板已漂移，请同步更新聚合脚本。",
    );
  }
  return rewritten;
}

function rewriteDesktopAdapter(text) {
  return text
    .replaceAll('from "@beauticode/adapter-desktop-cdp"', 'from "../../adapter-desktop-cdp/dist/index.js"')
    .replaceAll("from '@beauticode/adapter-desktop-cdp'", "from '../../adapter-desktop-cdp/dist/index.js'")
    .replaceAll('from "@beauticode/core"', 'from "../../core/dist/index.js"')
    .replaceAll("from '@beauticode/core'", "from '../../core/dist/index.js'");
}

function rewriteCodexCli(text) {
  return text
    .replaceAll('from "@beauticode/core"', 'from "./vendor/core/index.js"')
    .replaceAll("from '@beauticode/core'", "from './vendor/core/index.js'")
    .replaceAll("找不到 @beauticode/adapter-codex", "找不到 Codex adapter")
    .replace(/\s*const repoCore = path\.resolve\(here, "\.\.\/\.\.\/packages\/core\/dist"\);[\s\S]*?\s*await fsp\.rename\(temporaryVendor, vendorRoot\);\r?\n}/, "\n  throw new Error(\"缺少包内 Codex vendor runtime。\");\n}");
}

function rewriteCodexWatchHost(text) {
  return text
    .replace(
      /  const workspace = path\.join\(here, "\.\.\/\.\.\/packages\/adapter-codex\/dist\/index\.js"\);\r?\n  const file = fs\.existsSync\(vendor\) \? vendor : workspace;/,
      "  const file = vendor;",
    )
    .replaceAll("@beauticode/adapter-codex", "Codex adapter");
}

async function copyDesktopRuntime(destRoot) {
  const desktop = path.join(destRoot, "runtime", "desktop");
  await copyText(
    path.join(repoRoot, "scripts", "desktop-cdp-runner.mjs"),
    path.join(desktop, "scripts", "desktop-cdp-runner.mjs"),
    rewriteDesktopRunner,
  );
  await copyText(
    path.join(repoRoot, "scripts", "desktop-cdp-setup.mjs"),
    path.join(desktop, "scripts", "desktop-cdp-setup.mjs"),
  );
  await copyJsTree(path.join(repoRoot, "packages", "core", "dist"), path.join(desktop, "packages", "core", "dist"));
  await copyJsTree(path.join(repoRoot, "packages", "adapter-desktop-cdp", "dist"), path.join(desktop, "packages", "adapter-desktop-cdp", "dist"));
  await copyJsTree(path.join(repoRoot, "packages", "adapter-cursor", "dist"), path.join(desktop, "packages", "adapter-cursor", "dist"));
  await copyJsTree(path.join(repoRoot, "packages", "adapter-doubao", "dist"), path.join(desktop, "packages", "adapter-doubao", "dist"));
  for (const name of ["adapter-cursor", "adapter-doubao"]) {
    const entry = path.join(desktop, "packages", name, "dist", "index.js");
    await fsp.writeFile(entry, rewriteDesktopAdapter(await fsp.readFile(entry, "utf8")), "utf8");
  }
}

async function copyWorkbuddyRuntime(destRoot) {
  const workbuddy = path.join(destRoot, "runtime", "workbuddy");
  await copyText(
    path.join(repoRoot, "scripts", "wb-cdp-runner.mjs"),
    path.join(workbuddy, "scripts", "wb-cdp-runner.mjs"),
    rewriteWorkbuddyRunner,
  );
  await copyText(
    path.join(repoRoot, "scripts", "wb-setup.mjs"),
    path.join(workbuddy, "scripts", "wb-setup.mjs"),
    rewriteWorkbuddySetup,
  );
  await copyJsTree(path.join(repoRoot, "packages", "core", "dist"), path.join(workbuddy, "packages", "core", "dist"));
  await copyJsTree(path.join(repoRoot, "packages", "adapter-workbuddy", "dist"), path.join(workbuddy, "packages", "adapter-workbuddy", "dist"));
  await copyTree(
    path.join(repoRoot, "assets", "themes", "internal-beyond"),
    path.join(workbuddy, "assets", "themes", "internal-beyond"),
    (name, entry) => entry.isDirectory() || name === "bg-canvas-4k.png" || name === "NOTICE.md",
  );
}

export async function stageDesktopAggregate(destRoot = defaultStageDir(), opts = {}) {
  if (opts.build !== false) runBuild();
  await fsp.rm(destRoot, { recursive: true, force: true });
  await fsp.mkdir(destRoot, { recursive: true });
  await fsp.copyFile(path.join(sourceRoot, "package.json"), path.join(destRoot, "package.json"));
  for (const name of ["README.md", "LICENSE"]) {
    const source = name === "LICENSE" ? path.join(repoRoot, name) : path.join(sourceRoot, name);
    if (fs.existsSync(source)) await fsp.copyFile(source, path.join(destRoot, name));
  }
  await copyTree(path.join(sourceRoot, "bin"), path.join(destRoot, "bin"));
  await copyTree(path.join(sourceRoot, "src"), path.join(destRoot, "src"));
  await stageDshPlugin(path.join(destRoot, "runtime", "dsh"), { build: false });
  await stageCodexPlugin(path.join(destRoot, "runtime", "codex"), { build: false });
  await copyDesktopRuntime(destRoot);
  await copyWorkbuddyRuntime(destRoot);
  await copyText(
    path.join(destRoot, "runtime", "codex", "cli.js"),
    path.join(destRoot, "runtime", "codex", "cli.js"),
    rewriteCodexCli,
  );
  await copyText(
    path.join(destRoot, "runtime", "codex", "watch-host.mjs"),
    path.join(destRoot, "runtime", "codex", "watch-host.mjs"),
    rewriteCodexWatchHost,
  );
  return destRoot;
}

async function main() {
  const dest = await stageDesktopAggregate();
  // 复审 I-5：版本号以 beauticode-desktop/package.json 为单一事实源，
  // 打包脚本与测试都从那里读取，避免三处硬编码漂移。
  const pkg = JSON.parse(
    await fsp.readFile(path.join(repoRoot, "packages", "beauticode-desktop", "package.json"), "utf8"),
  );
  process.stdout.write(`Staged ${pkg.name}@${pkg.version} at ${dest}\n`);
}

const launchedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (launchedDirectly) await main();

#!/usr/bin/env node
/**
 * Stage a self-contained @beauticode/dsh-plugin for npm / npx.
 * Copies the Cordis plugin, vendored core + adapter-dsh, and 画窗 assets.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginSrc = path.join(repoRoot, "integrations", "deepseek-harness");

const PLUGIN_FILES = [
  "index.mjs",
  "client.js",
  "console.js",
  "atmosphere.js",
  "presets.mjs",
  "agent.mjs",
  "control-client.mjs",
  "host-apply.mjs",
  "ui-host.mjs",
  "cli.js",
  "bin/beauticode-dsh",
  "cordis.patch.yml",
  "package.json",
  "README.zh-CN.md",
];

const THEME_FILES = [
  "bg-canvas-4k.png",
  "bg-canvas.png",
  "bg-internal.jpg",
  "bg-infernal.jpg",
  "NOTICE.md",
];

export function defaultStageDir() {
  return path.join(repoRoot, "artifacts", "dsh-plugin");
}

function runBuild() {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "-w", "@beauticode/core"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) {
    throw new Error("Failed to build @beauticode/core.");
  }
  const adapter = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "-w", "@beauticode/adapter-dsh"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (adapter.status !== 0) {
    throw new Error("Failed to build @beauticode/adapter-dsh.");
  }
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
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    await fsp.copyFile(source, dest);
  }
}

function rewriteCoreImports(jsText) {
  return jsText
    .replaceAll('from "@beauticode/core"', 'from "../core/index.js"')
    .replaceAll("from '@beauticode/core'", "from '../core/index.js'");
}

export async function stageEngineInto(destRoot) {
  const vendorAdapter = path.join(destRoot, "vendor", "adapter-dsh");
  const vendorCore = path.join(destRoot, "vendor", "core");
  const themesDest = path.join(destRoot, "themes", "internal-beyond");
  await copyJsTree(path.join(repoRoot, "packages", "core", "dist"), vendorCore);
  await copyJsTree(
    path.join(repoRoot, "packages", "adapter-dsh", "dist"),
    vendorAdapter,
  );
  await fsp.writeFile(
    path.join(vendorCore, "package.json"),
    `${JSON.stringify({ name: "@beauticode/core", type: "module", main: "./index.js" }, null, 2)}\n`,
    "utf8",
  );
  await fsp.writeFile(
    path.join(vendorAdapter, "package.json"),
    `${JSON.stringify({ name: "@beauticode/adapter-dsh", type: "module", main: "./index.js" }, null, 2)}\n`,
    "utf8",
  );
  const adapterFiles = await fsp.readdir(vendorAdapter);
  for (const name of adapterFiles) {
    if (!name.endsWith(".js")) continue;
    const filePath = path.join(vendorAdapter, name);
    const next = rewriteCoreImports(await fsp.readFile(filePath, "utf8"));
    await fsp.writeFile(filePath, next, "utf8");
  }
  await fsp.mkdir(themesDest, { recursive: true });
  const themesSrc = path.join(repoRoot, "assets", "themes", "internal-beyond");
  for (const name of THEME_FILES) {
    const source = path.join(themesSrc, name);
    if (!fs.existsSync(source)) continue;
    await fsp.copyFile(source, path.join(themesDest, name));
  }
}

export async function applyPublishName(destRoot, publishName) {
  const pkgPath = path.join(destRoot, "package.json");
  const pkg = JSON.parse(await fsp.readFile(pkgPath, "utf8"));
  const previous = pkg.name;
  pkg.name = publishName;
  await fsp.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  for (const relative of ["cordis.patch.yml", "cli.js", "bin/beauticode-dsh"]) {
    const filePath = path.join(destRoot, relative);
    if (!fs.existsSync(filePath)) continue;
    const text = await fsp.readFile(filePath, "utf8");
    await fsp.writeFile(filePath, text.replaceAll(previous, publishName), "utf8");
  }
}

export async function stageDshPlugin(destRoot = defaultStageDir(), opts = {}) {
  if (opts.build !== false) runBuild();
  await fsp.rm(destRoot, { recursive: true, force: true });
  await fsp.mkdir(destRoot, { recursive: true });
  for (const name of PLUGIN_FILES) {
    const source = path.join(pluginSrc, name);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing plugin file: ${name}`);
    }
    const dest = path.join(destRoot, name);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(source, dest);
  }
  await stageEngineInto(destRoot);
  if (opts.publishName) await applyPublishName(destRoot, opts.publishName);
  return destRoot;
}

function parseArgs(argv) {
  const otpIdx = argv.indexOf("--otp");
  const nameIdx = argv.indexOf("--name");
  return {
    publish: argv.includes("--publish"),
    dryRun: argv.includes("--dry-run"),
    build: !argv.includes("--no-build"),
    otp: otpIdx === -1 ? null : argv[otpIdx + 1] ?? null,
    publishName: nameIdx === -1 ? "beauticode-dsh" : argv[nameIdx + 1] ?? "beauticode-dsh",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dest = defaultStageDir();
  await stageDshPlugin(dest, { build: args.build, publishName: args.publishName });
  const pkg = JSON.parse(await fsp.readFile(path.join(dest, "package.json"), "utf8"));
  process.stdout.write(`Staged ${pkg.name}@${pkg.version} at ${dest}\n`);
  if (!args.publish && !args.dryRun) return;
  const npmArgs = ["publish", "--access", "public"];
  if (args.dryRun) npmArgs.push("--dry-run");
  if (args.otp) npmArgs.push("--otp", args.otp);
  const published = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    npmArgs,
    { cwd: dest, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (published.status !== 0) {
    process.exit(published.status ?? 1);
  }
}

const launchedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() ===
    import.meta.url.toLowerCase();
if (launchedDirectly) {
  await main();
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginSrc = path.join(repoRoot, "integrations", "codex-desktop");

const PLUGIN_FILES = [
  "cli.js",
  "watch-host.mjs",
  "codex-watchdog.mjs",
  "lifecycle.mjs",
  "bin/beauticode-codex",
  "package.json",
];

export function defaultStageDir() {
  return path.join(repoRoot, "artifacts", "codex-plugin");
}

function runBuild() {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "-w", "@beauticode/core"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) throw new Error("Failed to build @beauticode/core.");
  const adapter = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "-w", "@beauticode/adapter-codex"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (adapter.status !== 0) throw new Error("Failed to build @beauticode/adapter-codex.");
}

async function copyTree(fromDir, toDir) {
  await fsp.mkdir(toDir, { recursive: true });
  for (const entry of await fsp.readdir(fromDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".map") || entry.name.endsWith(".d.ts")) continue;
    const source = path.join(fromDir, entry.name);
    const dest = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".css")) continue;
    await fsp.copyFile(source, dest);
  }
}

function rewriteCoreImports(text) {
  return text
    .replaceAll('from "@beauticode/core"', 'from "../core/index.js"')
    .replaceAll("from '@beauticode/core'", "from '../core/index.js'");
}

export async function stageCodexPlugin(destRoot = defaultStageDir(), opts = {}) {
  if (opts.build !== false) runBuild();
  await fsp.rm(destRoot, { recursive: true, force: true });
  await fsp.mkdir(destRoot, { recursive: true });
  for (const name of PLUGIN_FILES) {
    const source = path.join(pluginSrc, name);
    const dest = path.join(destRoot, name);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(source, dest);
  }
  const vendorAdapter = path.join(destRoot, "vendor", "adapter-codex");
  await copyTree(path.join(repoRoot, "packages", "core", "dist"), path.join(destRoot, "vendor", "core"));
  await copyTree(path.join(repoRoot, "packages", "adapter-codex", "dist"), vendorAdapter);
  for (const name of await fsp.readdir(vendorAdapter)) {
    if (!name.endsWith(".js")) continue;
    const filePath = path.join(vendorAdapter, name);
    await fsp.writeFile(filePath, rewriteCoreImports(await fsp.readFile(filePath, "utf8")));
  }
  return destRoot;
}

async function main() {
  const dest = defaultStageDir();
  await stageCodexPlugin(dest, { build: !process.argv.includes("--no-build") });
  process.stdout.write(`Staged beauticode-codex at ${dest}\n`);
}

const launchedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() ===
    import.meta.url.toLowerCase();
if (launchedDirectly) {
  await main();
}

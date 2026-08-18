#!/usr/bin/env node
/**
 * One-line installer: npx @beauticode/dsh-plugin
 *
 * Copies this package to a stable local folder and writes the DSH patch so
 * `dsh web` loads beautiCode. Does not start DeepSeek Harness.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginName = "@beauticode/dsh-plugin";
const bridgeId = "beauticode-bridge";

function argValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return value && !value.startsWith("--") ? value : null;
}

function defaultDataRoot() {
  if (process.env.BEAUTICODE_DATA_ROOT) return process.env.BEAUTICODE_DATA_ROOT;
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "beautiCode");
  }
  return path.join(os.homedir(), ".beauticode");
}

function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function toFileUri(filePath) {
  const full = path.resolve(filePath).replaceAll("\\", "/");
  if (/^[A-Za-z]:/.test(full)) return `file:///${full}`;
  return pathToFileURL(full).href;
}

function fileUriInsert(uri) {
  return [
    "# beauticode-bridge (installer)",
    "- insert:",
    "    - id: beauticode-bridge",
    `      name: '${uri}'`,
    "      inject: [webServer]",
    "",
  ].join("\n");
}

function packageInsert() {
  return [
    "# beauticode-bridge (installer)",
    "- insert:",
    "    - id: beauticode-bridge",
    `      name: '${pluginName}'`,
    "      inject: [webServer]",
    "",
  ].join("\n");
}

function hasBridge(text) {
  return new RegExp(`^\\s*-\\s*id:\\s*${bridgeId}\\s*$`, "m").test(text);
}

function stripBridge(text) {
  const patterns = [
    /(?:^|\r?\n)# beauticode-bridge \(installer\)\r?\n- insert:\r?\n(?:[ \t]+.*\r?\n)*/g,
    /(?:^|\r?\n)- insert:\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+-\s*id:\s*beauticode-bridge\r?\n(?:[ \t]+.*\r?\n)*/g,
  ];
  let next = text;
  for (const pattern of patterns) next = next.replace(pattern, "\n");
  return next;
}

async function writePatch(filePath, body) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    await fsp.writeFile(filePath, body, "utf8");
    return;
  }
  const raw = await fsp.readFile(filePath, "utf8");
  if (hasBridge(raw)) {
    const replaced = raw.replace(
      /(?:# beauticode-bridge \(installer\)\r?\n)?- insert:\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+-\s*id:\s*beauticode-bridge\r?\n(?:[ \t]+.*\r?\n)*/,
      body,
    );
    await fsp.writeFile(filePath, replaced.endsWith("\n") ? replaced : `${replaced}\n`, "utf8");
    return;
  }
  const stripped = raw.trim();
  if (stripped === "" || stripped === "[]") {
    await fsp.writeFile(filePath, body, "utf8");
    return;
  }
  await fsp.writeFile(filePath, `${stripped}\n\n${body}`, "utf8");
}

async function removePatch(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = await fsp.readFile(filePath, "utf8");
  if (!hasBridge(raw)) return false;
  const cleaned = stripBridge(raw).trim();
  if (cleaned === "" || cleaned === "[]") {
    await fsp.writeFile(
      filePath,
      "# Your patch layer for this dsh profile.\n[]\n",
      "utf8",
    );
    return true;
  }
  await fsp.writeFile(filePath, `${cleaned}\n`, "utf8");
  return true;
}

function shouldCopy(source) {
  const relative = path.relative(here, source);
  if (relative.startsWith("test") || relative.includes(`${path.sep}test${path.sep}`)) {
    return false;
  }
  if (relative.endsWith(".test.mjs")) return false;
  return true;
}

async function copyPackage(dest) {
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(here, dest, {
    recursive: true,
    filter: (source) => shouldCopy(source),
  });
}

async function ensureEngine(dest) {
  const vendor = path.join(dest, "vendor", "adapter-dsh", "index.js");
  if (fs.existsSync(vendor)) return;
  const packPath = path.resolve(here, "../../scripts/pack-dsh-plugin.mjs");
  if (!fs.existsSync(packPath)) {
    throw new Error("插件包不完整：缺少本机导入引擎。请重新执行 npx @beauticode/dsh-plugin。");
  }
  const { stageEngineInto } = await import(pathToFileURL(packPath).href);
  await stageEngineInto(dest);
}

async function install(opts) {
  const dest = path.resolve(opts.pluginHome);
  const dshHome = path.resolve(opts.dshHome);
  const webProfile = path.join(dshHome, "profiles", "web");
  const webPatch = path.join(webProfile, "cordis.patch.yml");
  const webPackage = path.join(webProfile, "package.json");
  const homePatch = path.join(dshHome, "cordis.patch.yml");

  await fsp.mkdir(dest, { recursive: true });
  await copyPackage(dest);
  await ensureEngine(dest);
  const indexFile = path.join(dest, "index.mjs");
  if (!fs.existsSync(indexFile)) {
    throw new Error(`缺少插件入口：${indexFile}`);
  }

  if (fs.existsSync(webPackage)) {
    await writePatch(webPatch, packageInsert());
    if (fs.existsSync(homePatch)) {
      const homeRaw = await fsp.readFile(homePatch, "utf8");
      if (hasBridge(homeRaw)) await removePatch(homePatch);
    }
    console.log(`已写入 ${webPatch}`);
    console.log(`插件已复制到 ${dest}`);
    console.log("请自己运行：npx @deepseek-ai/dsh web");
    return { dest, patch: webPatch };
  }

  await fsp.mkdir(dshHome, { recursive: true });
  await writePatch(homePatch, fileUriInsert(toFileUri(indexFile)));
  console.log(`DSH web profile 还不存在，已写入 ${homePatch}`);
  console.log(`插件已复制到 ${dest}`);
  console.log("请自己运行：npx @deepseek-ai/dsh web");
  return { dest, patch: homePatch };
}

async function uninstall(opts) {
  const dshHome = path.resolve(opts.dshHome);
  const removed = [];
  if (await removePatch(path.join(dshHome, "profiles", "web", "cordis.patch.yml"))) {
    removed.push("web patch");
  }
  if (await removePatch(path.join(dshHome, "cordis.patch.yml"))) {
    removed.push("home patch");
  }
  const dest = path.resolve(opts.pluginHome);
  if (fs.existsSync(dest)) {
    await fsp.rm(dest, { recursive: true, force: true });
    removed.push(dest);
  }
  console.log(removed.length ? `已移除：${removed.join("、")}` : "没有可移除的 beautiCode 插件接线。");
  return { removed };
}

export async function runCli(argv = process.argv.slice(2)) {
  const dshHome = argValue(argv, "--dsh-home") || defaultDshHome();
  const pluginHome =
    argValue(argv, "--plugin-home") || path.join(defaultDataRoot(), "plugin");
  const opts = { dshHome, pluginHome };
  if (argv.includes("--remove")) return uninstall(opts);
  return install(opts);
}

const launchedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() ===
    import.meta.url.toLowerCase();
if (launchedDirectly) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

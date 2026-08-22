#!/usr/bin/env node
/**
 * One-line installer: npx beauticode-dsh
 *
 * Copies this package to a stable local folder and writes the DSH patch so
 * `dsh web` loads beautiCode. Does not start DeepSeek Harness.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function findPackageRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 5; i += 1) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "index.mjs"))
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
const pluginName = "beauticode-dsh";
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

function defaultPluginHome(dshHome) {
  return path.join(path.resolve(dshHome), "plugins", pluginName);
}

function legacyDefaultPluginHome() {
  return path.join(defaultDataRoot(), "plugin");
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
  const lines = text.split(/\r?\n/);
  const removed = new Array(lines.length).fill(false);
  const indentOf = (line) => line.match(/^[ \t]*/)?.[0].length ?? 0;

  for (let i = 0; i < lines.length; i += 1) {
    const insert = lines[i].match(/^([ \t]*)-\s*insert:\s*(?:#.*)?$/);
    if (!insert) continue;
    const insertIndent = insert[1].length;
    let blockEnd = i + 1;
    while (blockEnd < lines.length) {
      const line = lines[blockEnd];
      if (line.trim() && indentOf(line) <= insertIndent) break;
      blockEnd += 1;
    }

    let foundBridge = false;
    for (let j = i + 1; j < blockEnd; ) {
      const bridge = lines[j].match(
        /^([ \t]*)-\s*id:\s*beauticode-bridge\s*(?:#.*)?$/,
      );
      if (!bridge || bridge[1].length <= insertIndent) {
        j += 1;
        continue;
      }
      foundBridge = true;
      const itemIndent = bridge[1].length;
      let itemEnd = j + 1;
      while (itemEnd < blockEnd) {
        const line = lines[itemEnd];
        if (line.trim() && indentOf(line) <= itemIndent) break;
        itemEnd += 1;
      }
      for (let k = j; k < itemEnd; k += 1) removed[k] = true;
      j = itemEnd;
    }

    if (!foundBridge) continue;
    const marker = `${insert[1]}# beauticode-bridge (installer)`;
    if (i > 0 && lines[i - 1].trimEnd() === marker) removed[i - 1] = true;
    const hasSibling = lines
      .slice(i + 1, blockEnd)
      .some(
        (line, offset) =>
          !removed[i + 1 + offset] &&
          line.trim() !== "" &&
          !line.trimStart().startsWith("#"),
      );
    if (!hasSibling) {
      for (let k = i; k < blockEnd; k += 1) removed[k] = true;
    }
    i = blockEnd - 1;
  }

  return lines.filter((_, index) => !removed[index]).join("\n");
}

function overlayPayload(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

function isEmptyOverlay(text) {
  const payload = overlayPayload(text);
  return payload === "" || payload === "[]";
}

// DSH seeds overlays as `# comment\n[]`. `[]` is already a complete YAML
// document, so appending `- insert:` makes js-yaml throw.
function keptOverlay(text) {
  const withoutFlowEmpty = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "[]")
    .join("\n");
  if (isEmptyOverlay(withoutFlowEmpty)) return "";
  return withoutFlowEmpty.trim();
}

function withTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function writePatch(filePath, body) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const insert = withTrailingNewline(body);
  if (!fs.existsSync(filePath)) {
    await fsp.writeFile(filePath, insert, "utf8");
    return;
  }
  const raw = await fsp.readFile(filePath, "utf8");
  const remainder = hasBridge(raw) ? stripBridge(raw) : raw;
  const kept = keptOverlay(remainder);
  const next = kept ? `${kept}\n\n${insert}` : insert;
  await fsp.writeFile(filePath, withTrailingNewline(next), "utf8");
}

async function removePatch(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = await fsp.readFile(filePath, "utf8");
  if (!hasBridge(raw)) return false;
  const kept = keptOverlay(stripBridge(raw));
  if (!kept) {
    await fsp.writeFile(
      filePath,
      "# Your patch layer for this dsh profile.\n[]\n",
      "utf8",
    );
    return true;
  }
  await fsp.writeFile(filePath, withTrailingNewline(kept), "utf8");
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

async function sameInstalledVersion(dest) {
  try {
    const incoming = JSON.parse(await fsp.readFile(path.join(here, "package.json"), "utf8"));
    const installed = JSON.parse(await fsp.readFile(path.join(dest, "package.json"), "utf8"));
    return (
      incoming.name === installed.name &&
      incoming.version === installed.version &&
      fs.existsSync(path.join(dest, "index.mjs")) &&
      fs.existsSync(path.join(dest, "vendor", "adapter-dsh", "index.js"))
    );
  } catch {
    return false;
  }
}

async function copyPackage(dest) {
  if (await sameInstalledVersion(dest)) return false;
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(here, dest, {
    recursive: true,
    filter: (source) => shouldCopy(source),
  });
  return true;
}

async function removeLegacyManagedPlugin(legacyHome, currentHome) {
  if (!legacyHome) return false;
  const legacy = path.resolve(legacyHome);
  if (legacy === path.resolve(currentHome) || !fs.existsSync(legacy)) return false;
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(legacy, "package.json"), "utf8"));
    if (
      ![pluginName, "@beauticode/dsh-plugin"].includes(pkg.name) ||
      !fs.existsSync(path.join(legacy, "index.mjs"))
    ) {
      return false;
    }
  } catch {
    return false;
  }
  await fsp.rm(legacy, { recursive: true, force: true });
  return true;
}

async function ensureEngine(dest) {
  const vendor = path.join(dest, "vendor", "adapter-dsh", "index.js");
  if (fs.existsSync(vendor)) return;
  const packPath = path.resolve(here, "../../scripts/pack-dsh-plugin.mjs");
  if (!fs.existsSync(packPath)) {
    throw new Error("插件包不完整：缺少本机导入引擎。请重新执行 npx beauticode-dsh。");
  }
  const { stageEngineInto } = await import(pathToFileURL(packPath).href);
  await stageEngineInto(dest);
}

function pluginLinkPath(webProfile) {
  return path.join(webProfile, "node_modules", pluginName);
}

function legacyPluginLinkPath(webProfile) {
  return path.join(webProfile, "node_modules", "@beauticode", "dsh-plugin");
}

function linkSpecFor(pluginHome) {
  return `link:${path.resolve(pluginHome).replaceAll("\\", "/")}`;
}

async function sameLinkTarget(link, dest) {
  try {
    const stat = await fsp.lstat(link);
    if (stat.isSymbolicLink()) {
      const target = await fsp.readlink(link);
      return path.resolve(path.dirname(link), target) === path.resolve(dest);
    }
    if (stat.isDirectory()) {
      return path.resolve(link) === path.resolve(dest);
    }
  } catch {
    return false;
  }
  return false;
}

async function linkPluginIntoProfile(webProfile, dest) {
  const link = pluginLinkPath(webProfile);
  const legacy = legacyPluginLinkPath(webProfile);
  if (fs.existsSync(legacy)) {
    await fsp.rm(legacy, { recursive: true, force: true });
  }
  await fsp.mkdir(path.dirname(link), { recursive: true });
  if (fs.existsSync(link)) {
    if (await sameLinkTarget(link, dest)) return;
    await fsp.rm(link, { recursive: true, force: true });
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  await fsp.symlink(path.resolve(dest), link, type);
}

async function ensureWebPackageDep(webPackage, pluginHome) {
  const raw = await fsp.readFile(webPackage, "utf8");
  const json = JSON.parse(raw);
  if (!json.dependencies || typeof json.dependencies !== "object" || Array.isArray(json.dependencies)) {
    json.dependencies = {};
  }
  const spec = linkSpecFor(pluginHome);
  const hadLegacy = Object.prototype.hasOwnProperty.call(
    json.dependencies,
    "@beauticode/dsh-plugin",
  );
  delete json.dependencies["@beauticode/dsh-plugin"];
  const current = json.dependencies[pluginName];
  if (current === spec && !hadLegacy) return;
  json.dependencies[pluginName] = spec;
  await fsp.writeFile(webPackage, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

async function removeWebPackageDep(webPackage) {
  if (!fs.existsSync(webPackage)) return false;
  const json = JSON.parse(await fsp.readFile(webPackage, "utf8"));
  if (!json.dependencies || typeof json.dependencies !== "object") return false;
  let changed = false;
  for (const name of [pluginName, "@beauticode/dsh-plugin"]) {
    if (Object.prototype.hasOwnProperty.call(json.dependencies, name)) {
      delete json.dependencies[name];
      changed = true;
    }
  }
  if (!changed) return false;
  await fsp.writeFile(webPackage, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return true;
}

async function install(opts) {
  const dest = path.resolve(opts.pluginHome);
  const dshHome = path.resolve(opts.dshHome);
  const webProfile = path.join(dshHome, "profiles", "web");
  const webPatch = path.join(webProfile, "cordis.patch.yml");
  const webPackage = path.join(webProfile, "package.json");
  const homePatch = path.join(dshHome, "cordis.patch.yml");

  await fsp.mkdir(dest, { recursive: true });
  const copied = await copyPackage(dest);
  await ensureEngine(dest);
  const indexFile = path.join(dest, "index.mjs");
  if (!fs.existsSync(indexFile)) {
    throw new Error(`缺少插件入口：${indexFile}`);
  }

  if (fs.existsSync(webPackage)) {
    await linkPluginIntoProfile(webProfile, dest);
    await ensureWebPackageDep(webPackage, dest);
    await writePatch(webPatch, packageInsert());
    if (fs.existsSync(homePatch)) {
      const homeRaw = await fsp.readFile(homePatch, "utf8");
      if (hasBridge(homeRaw)) await removePatch(homePatch);
    }
    const migrated = await removeLegacyManagedPlugin(opts.legacyPluginHome, dest);
    console.log(`已写入 ${webPatch}`);
    console.log(copied ? `插件已安装到 ${dest}` : `已复用已安装的插件 ${dest}`);
    if (migrated) console.log("已迁移 1.0.5 的旧插件目录，已保留主题数据。");
    console.log("请自己运行：npx @deepseek-ai/dsh web");
    return { dest, patch: webPatch };
  }

  await fsp.mkdir(dshHome, { recursive: true });
  await writePatch(homePatch, fileUriInsert(toFileUri(indexFile)));
  const migrated = await removeLegacyManagedPlugin(opts.legacyPluginHome, dest);
  console.log(`DSH web profile 还不存在，已写入 ${homePatch}`);
  console.log(copied ? `插件已安装到 ${dest}` : `已复用已安装的插件 ${dest}`);
  if (migrated) console.log("已迁移 1.0.5 的旧插件目录，已保留主题数据。");
  console.log("请自己运行：npx @deepseek-ai/dsh web");
  return { dest, patch: homePatch };
}

async function uninstall(opts) {
  const dshHome = path.resolve(opts.dshHome);
  const webProfile = path.join(dshHome, "profiles", "web");
  const removed = [];
  if (await removePatch(path.join(webProfile, "cordis.patch.yml"))) {
    removed.push("web patch");
  }
  if (await removePatch(path.join(dshHome, "cordis.patch.yml"))) {
    removed.push("home patch");
  }
  if (await removeWebPackageDep(path.join(webProfile, "package.json"))) {
    removed.push("web package.json");
  }
  for (const link of [pluginLinkPath(webProfile), legacyPluginLinkPath(webProfile)]) {
    if (fs.existsSync(link)) {
      await fsp.rm(link, { recursive: true, force: true });
      removed.push(link);
    }
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
  const requestedPluginHome = argValue(argv, "--plugin-home");
  const pluginHome = requestedPluginHome || defaultPluginHome(dshHome);
  const opts = {
    dshHome,
    pluginHome,
    legacyPluginHome: requestedPluginHome ? null : legacyDefaultPluginHome(),
  };
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

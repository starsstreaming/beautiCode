#!/usr/bin/env node
/**
 * One-line installer: npx beauticode-dsh
 *
 * Copies this package to a stable local folder and writes the DSH patch so
 * `dsh web` loads beautiCode. Does not start DeepSeek Harness.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
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
// 这些入口在源码里使用 monorepo 裸导入 `@beauticode/core`，落位到插件
// 目录后必须重写为 ./vendor/core/index.js 才能被 DSH 加载。
const LOADABLE_ENTRY_FILES = [
  "index.mjs",
  "gallery-host.mjs",
  "control-client.mjs",
  "host-apply.mjs",
];

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

function bridgeCount(text) {
  return (String(text).match(new RegExp(`^\\s*-\\s*id:\\s*${bridgeId}\\s*$`, "gm")) || []).length;
}

async function backupPatch(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const base = `${filePath}.beauticode-backup-${Date.now()}`;
  let backup = base;
  let suffix = 0;
  while (fs.existsSync(backup)) backup = `${base}-${++suffix}`;
  await fsp.copyFile(filePath, backup, fs.constants.COPYFILE_EXCL);
  return backup;
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

  // 返回删除计数而非仅文本：调用方需要区分「删掉了 bridge」与
  // 「文本因 CRLF 归一等原因变化但 bridge 原样保留」。
  const kept = [];
  let removedCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (removed[i]) {
      removedCount += 1;
      continue;
    }
    kept.push(lines[i]);
  }
  return { text: kept.join("\n"), removedCount };
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
  // 对用户文件的任何写入前无条件备份：writePatch 可能重排/清理既有内容，
  // 一旦 stripBridge/keptOverlay 的判据有盲区，备份是唯一的恢复手段。
  await backupPatch(filePath);
  const raw = await fsp.readFile(filePath, "utf8");
  const remainder = hasBridge(raw) ? stripBridge(raw).text : raw;
  const kept = keptOverlay(remainder);
  const next = kept ? `${kept}\n\n${insert}` : insert;
  await fsp.writeFile(filePath, withTrailingNewline(next), "utf8");
}

async function removePatch(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = await fsp.readFile(filePath, "utf8");
  if (!hasBridge(raw)) return false;
  const { text: stripped, removedCount } = stripBridge(raw);
  if (removedCount === 0) {
    // hasBridge 认可的形态比 stripBridge 宽（如顶层 `- id:` 条目）。此时
    // 实际删除量为零——谎报「已移除」会让用户以为卸载完成而插件仍被
    // 加载；明确报错并给出行号，交由用户手工处理。
    const lineNo =
      raw.split(/\r?\n/).findIndex((line) =>
        new RegExp(`^\\s*-\\s*id:\\s*${bridgeId}\\s*$`).test(line),
      ) + 1;
    throw new Error(
      `无法从 ${filePath} 移除 beauticode-bridge（第 ${lineNo} 行的形态不受支持），请手工处理该行后重试。`,
    );
  }
  const kept = keptOverlay(stripped);
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
    if (incoming.name !== installed.name || incoming.version !== installed.version) {
      return false;
    }
    if (
      !fs.existsSync(path.join(dest, "index.mjs")) ||
      !fs.existsSync(path.join(dest, "vendor", "adapter-dsh", "index.js"))
    ) {
      return false;
    }
    // 可用性判据：入口残留裸 `@beauticode/core` 导入的副本在插件目录里
    // 永远解析不到（monorepo 依赖），DSH 加载必报 ERR_MODULE_NOT_FOUND。
    // 视为「不同版本」，让重跑安装走重装修复，而不是把坏副本当完好跳过。
    const bareCoreRef = /["']@beauticode\/core["']/;
    for (const name of LOADABLE_ENTRY_FILES) {
      const filePath = path.join(dest, name);
      if (!fs.existsSync(filePath)) continue;
      if (bareCoreRef.test(await fsp.readFile(filePath, "utf8"))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// 删除/替换目标目录前必须证明它确实是 beautiCode 的插件安装。
// --plugin-home 是用户可传参数，误指向（例如 ~/.dsh 本体）时若不做归属
// 校验，递归删除会连带清掉用户的 profiles 与全部插件配置。
async function assertRemovablePluginDir(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return; // 目录不存在或不可读：交给调用方的既有错误路径处理
  }
  if (entries.length === 0) return; // 全新安装：空目录无需归属证明
  let pkg = null;
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    throw new Error(`拒绝操作非 beautiCode 插件目录（缺少可识别的 package.json）：${dir}`);
  }
  if (!["beauticode-dsh", "@beauticode/dsh-plugin"].includes(pkg?.name)) {
    throw new Error(
      `拒绝操作非 beautiCode 插件目录（package.json.name=${pkg?.name ?? "未知"}）：${dir}`,
    );
  }
}

function isBusyFsError(error) {
  const code = error?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EXDEV";
}

async function copyPackage(dest) {
  if (await sameInstalledVersion(dest)) return false;
  await assertRemovablePluginDir(dest);
  // 原子替换：先拷到兄弟临时目录并校验完整，再换名落位。Windows 上
  // `dsh web` 运行中会占用 vendor/*.js，先删后拷会留下半个插件目录且
  // 摧毁原可用安装；staging 方案失败时旧目录原样保留。
  const staging = `${dest}.tmp-${crypto.randomUUID()}`;
  const previous = `${dest}.old-${crypto.randomUUID()}`;
  let movedOld = false;
  try {
    await fsp.cp(here, staging, {
      recursive: true,
      filter: (source) => shouldCopy(source),
    });
    await assertStagedPlugin(staging);
    if (fs.existsSync(dest)) {
      await fsp.rename(dest, previous);
      movedOld = true;
    }
    await fsp.rename(staging, dest);
  } catch (error) {
    if (movedOld && !fs.existsSync(dest)) {
      const restored = await fsp
        .rename(previous, dest)
        .then(() => true)
        .catch(() => false);
      if (!restored) {
        // 恢复也失败：绝不能删掉 previous，保留旧版本供用户手工找回
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `插件安装失败且无法自动恢复原目录；旧版本保留在 ${previous}。原因：${error.message}`,
        );
      }
    }
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (isBusyFsError(error)) {
      throw new Error(`插件目录被占用，请先关闭 \`dsh web\` 后重试。`);
    }
    throw error;
  }
  try {
    await fsp.rm(previous, { recursive: true, force: true });
  } catch {
    // 旧目录可能仍被运行中的 dsh web 占用：新插件已就位，残留无害，
    // 下次安装会通过 assertRemovablePluginDir 清理路径自然处理。
  }
  return true;
}

async function assertStagedPlugin(dir) {
  for (const name of ["package.json", "index.mjs"]) {
    if (!fs.existsSync(path.join(dir, name))) {
      throw new Error(`staged 插件不完整：缺少 ${name}`);
    }
  }
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
  // 两个来源的副本都必须产出「可加载」的安装：
  // ① npx 发布包——文件已在打包时重写，vendor 自带，重写幂等；
  // ② 源码目录直装——裸导入必须重写为 vendor 引用，否则加载必失败。
  // 因此这里无条件执行「vendor 就位 + 入口重写」，而不是只在 vendor
  // 缺失时才动作。
  const packPath = path.resolve(here, "../../scripts/pack-dsh-plugin.mjs");
  const coreVendor = path.join(dest, "vendor", "core", "index.js");
  const adapterVendor = path.join(dest, "vendor", "adapter-dsh", "index.js");
  if ((!fs.existsSync(coreVendor) || !fs.existsSync(adapterVendor)) && !fs.existsSync(packPath)) {
    throw new Error("插件包不完整：缺少本机导入引擎。请重新执行 npx beauticode-dsh。");
  }
  if (fs.existsSync(packPath)) {
    const pack = await import(pathToFileURL(packPath).href);
    if (!fs.existsSync(coreVendor) || !fs.existsSync(adapterVendor)) {
      await pack.stageEngineInto(dest);
    }
    for (const name of LOADABLE_ENTRY_FILES) {
      const filePath = path.join(dest, name);
      if (!fs.existsSync(filePath)) continue;
      const text = await fsp.readFile(filePath, "utf8");
      const next = pack.rewritePluginCoreImports(text);
      if (next !== text) await fsp.writeFile(filePath, next, "utf8");
    }
  }
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

// A dangling symlink has a live directory entry even though fs.existsSync
// (which follows the link) reports false. Use lstat so leftover plugin links
// are detected and cleaned instead of making fsp.symlink fail with EEXIST.
async function entryExists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function linkPluginIntoProfile(webProfile, dest) {
  const link = pluginLinkPath(webProfile);
  const legacy = legacyPluginLinkPath(webProfile);
  if (await entryExists(legacy)) {
    await fsp.rm(legacy, { recursive: true, force: true });
  }
  await fsp.mkdir(path.dirname(link), { recursive: true });
  if (await entryExists(link)) {
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
    const pluginPatch = path.join(dest, "cordis.patch.yml");
    const pluginShipsBridge =
      fs.existsSync(pluginPatch) && hasBridge(await fsp.readFile(pluginPatch, "utf8"));
    if (pluginShipsBridge) {
      // DSH loads the package patch as well as the profile patch. Keep the
      // package's canonical loader and remove only beautiCode's managed
      // profile block, preserving unrelated profile configuration. Back up
      // the user's profile before this repair, even when it had one entry.
      if (fs.existsSync(webPatch)) {
        const profilePatch = await fsp.readFile(webPatch, "utf8");
        if (hasBridge(profilePatch)) {
          await backupPatch(webPatch);
          await removePatch(webPatch);
        }
      }
    } else {
      await writePatch(webPatch, packageInsert());
    }
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
  const webPatch = path.join(webProfile, "cordis.patch.yml");
  const homePatch = path.join(dshHome, "cordis.patch.yml");
  const removed = [];
  if (await removePatch(webPatch)) {
    removed.push("web patch");
  }
  if (await removePatch(homePatch)) {
    removed.push("home patch");
  }
  if (await removeWebPackageDep(path.join(webProfile, "package.json"))) {
    removed.push("web package.json");
  }
  for (const link of [pluginLinkPath(webProfile), legacyPluginLinkPath(webProfile)]) {
    if (await entryExists(link)) {
      await fsp.rm(link, { recursive: true, force: true });
      removed.push(link);
    }
  }
  const dest = path.resolve(opts.pluginHome);
  if (fs.existsSync(dest)) {
    await assertRemovablePluginDir(dest);
    await fsp.rm(dest, { recursive: true, force: true });
    removed.push(dest);
  }
  if (await removeLegacyManagedPlugin(opts.legacyPluginHome, dest)) {
    removed.push("旧版 1.0.5 插件目录");
  }
  // 清理本插件历次安装产生的备份文件：卸载是接线生命周期的终点，
  // 备份不再有恢复场景，留着只会无限堆积。
  let backupsRemoved = 0;
  for (const patch of [webPatch, homePatch]) {
    const dir = path.dirname(patch);
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(`${path.basename(patch)}.beauticode-backup-`)) continue;
      await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
      backupsRemoved += 1;
    }
  }
  if (backupsRemoved) removed.push(`${backupsRemoved} 个备份文件`);
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

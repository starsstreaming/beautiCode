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
import { backupPatch, fileUriInsert, hasBridge, packageInsert, removePatch, writePatch } from "./profile-patch.mjs";

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

function isPathRoot(target) {
  return path.resolve(target) === path.parse(path.resolve(target)).root;
}

async function assertNoSymlinkAncestors(target) {
  let current = path.dirname(path.resolve(target));
  while (true) {
    try {
      if ((await fsp.lstat(current)).isSymbolicLink()) {
        throw new Error(`拒绝在符号链接目录下操作插件目录：${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function isDirectory(target) {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isManagedPluginDirectory(target) {
  if (!(await isDirectory(target))) return false;
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(target, "package.json"), "utf8"));
    return (
      [pluginName, "@beauticode/dsh-plugin"].includes(pkg.name) &&
      fs.existsSync(path.join(target, "index.mjs")) &&
      fs.existsSync(path.join(target, "cordis.patch.yml")) &&
      hasBridge(await fsp.readFile(path.join(target, "cordis.patch.yml"), "utf8"))
    );
  } catch {
    return false;
  }
}

async function assertPluginHomeTarget(target, { forRemoval = false } = {}) {
  const resolved = path.resolve(target);
  if (isPathRoot(resolved) || resolved === path.resolve(here)) {
    throw new Error(`拒绝使用不安全的插件目录：${resolved}`);
  }
  await assertNoSymlinkAncestors(resolved);
  let stat;
  try {
    stat = await fsp.lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, owned: false };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`拒绝操作符号链接插件目录：${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`插件目录不是目录：${resolved}`);
  }
  const owned = await isManagedPluginDirectory(resolved);
  if (forRemoval && !owned) {
    throw new Error(`拒绝移除不属于 beautiCode 的插件目录：${resolved}`);
  }
  if (!owned) {
    const entries = await fsp.readdir(resolved);
    if (entries.length > 0) {
      throw new Error(`拒绝覆盖不属于 beautiCode 的非空插件目录：${resolved}`);
    }
  }
  return { exists: true, owned };
}

function legacyDefaultPluginHome() {
  return path.join(defaultDataRoot(), "plugin");
}

async function backupDirectory(target) {
  const base = `${target}.beauticode-backup-${Date.now()}`;
  let backup = base;
  let suffix = 0;
  while (await entryExists(backup)) backup = `${base}-${++suffix}`;
  await fsp.rename(target, backup);
  return backup;
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
  const target = path.resolve(dest);
  await assertPluginHomeTarget(target);
  if (await sameInstalledVersion(target)) return false;

  const parent = path.dirname(target);
  await fsp.mkdir(parent, { recursive: true });
  const stage = path.join(
    parent,
    `.${path.basename(target)}.beauticode-stage-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  let backup = null;
  try {
    await fsp.cp(here, stage, {
      recursive: true,
      filter: (source) => shouldCopy(source),
    });
    await ensureEngine(stage);
    if (await entryExists(target)) backup = await backupDirectory(target);
    await fsp.rename(stage, target);
    return true;
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (backup && !(await entryExists(target))) {
      await fsp.rename(backup, target).catch(() => {});
    }
    throw error;
  }
}

async function removeLegacyManagedPlugin(legacyHome, currentHome) {
  if (!legacyHome) return false;
  const legacy = path.resolve(legacyHome);
  if (legacy === path.resolve(currentHome) || !fs.existsSync(legacy)) return false;
  const target = await assertPluginHomeTarget(legacy, { forRemoval: true });
  if (!target.owned) return false;
  const backup = await backupDirectory(legacy);
  // Keep the backup: an interrupted migration can be rolled back by the user.
  void backup;
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
      return path.relative(await fsp.realpath(link), await fsp.realpath(dest)) === "";
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
    if (!(await isOwnedPluginLink(legacy))) {
      throw new Error(`拒绝替换不属于 beautiCode 的插件链接：${legacy}`);
    }
    await removeOwnedPluginEntry(legacy);
  }
  await fsp.mkdir(path.dirname(link), { recursive: true });
  if (await entryExists(link)) {
    if (await sameLinkTarget(link, dest)) return;
    if (!(await isOwnedPluginLink(link, dest))) {
      throw new Error(`拒绝替换不属于 beautiCode 的插件链接：${link}`);
    }
    await removeOwnedPluginEntry(link);
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  await fsp.symlink(path.resolve(dest), link, type);
}

async function isOwnedPluginLink(link, expectedTarget) {
  try {
    const stat = await fsp.lstat(link);
    if (stat.isSymbolicLink()) {
      if (expectedTarget) return await sameLinkTarget(link, expectedTarget);
      const target = await fsp.realpath(link).catch(() => null);
      return target ? await isManagedPluginDirectory(target) : false;
    }
    return stat.isDirectory() && (await isManagedPluginDirectory(link));
  } catch {
    return false;
  }
}

async function removeOwnedPluginEntry(target) {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) {
    await fsp.unlink(target);
    return;
  }
  if (!stat.isDirectory() || !(await isManagedPluginDirectory(target))) {
    throw new Error(`拒绝移除不属于 beautiCode 的插件条目：${target}`);
  }
  await fsp.rm(target, { recursive: true, force: true });
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
  const bundles = json.dsh?.profile?.bundles;
  const loadsPluginBundle = Array.isArray(bundles) && bundles.includes(pluginName);
  if (current === spec && !hadLegacy) return loadsPluginBundle;
  json.dependencies[pluginName] = spec;
  await fsp.writeFile(webPackage, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return loadsPluginBundle;
}

async function checkProfileWiring(opts) {
  const profile = path.join(opts.dshHome, "profiles", "web");
  const manifest = path.join(profile, "package.json");
  const link = pluginLinkPath(profile);
  const legacy = legacyPluginLinkPath(profile);
  for (const entry of [link, legacy, manifest, path.join(profile, "cordis.patch.yml"), path.join(opts.dshHome, "cordis.patch.yml")]) {
    await assertNoSymlinkAncestors(entry);
    if (entry !== link && entry !== legacy && await entryExists(entry) && (await fsp.lstat(entry)).isSymbolicLink()) {
      throw new Error("拒绝改写链接指向的 DSH 配置：" + entry);
    }
  }
  for (const entry of [link, legacy]) {
    if (await entryExists(entry) && !(await isOwnedPluginLink(entry, entry === link ? opts.pluginHome : undefined))) {
      throw new Error("DSH 插件链接属于其他安装：" + entry);
    }
  }
  if (!fs.existsSync(manifest)) return;
  const { dependencies } = JSON.parse(await fsp.readFile(manifest, "utf8"));
  if (dependencies === undefined) return;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("无效的 DSH dependencies 配置。");
  }
  for (const name of [pluginName, "@beauticode/dsh-plugin"]) {
    if (!Object.hasOwn(dependencies, name)) continue;
    const value = dependencies[name];
    if (typeof value === "string" && value.startsWith("link:") && value.length > 5) {
      const target = path.resolve(profile, value.slice(5));
      if (path.relative(opts.pluginHome, target) === "") continue;
      if (opts.legacyPluginHome && path.relative(opts.legacyPluginHome, target) === "" && await isManagedPluginDirectory(target)) continue;
    }
    throw new Error("DSH 依赖属于其他安装：" + name);
  }
}

async function removeWebPackageDep(webPackage) {
  if (!fs.existsSync(webPackage)) return false;
  const json = JSON.parse(await fsp.readFile(webPackage, "utf8"));
  let changed = false;
  for (const name of [pluginName, "@beauticode/dsh-plugin"]) {
    if (json.dependencies && Object.hasOwn(json.dependencies, name)) {
      delete json.dependencies[name];
      changed = true;
    }
  }
  const bundles = json.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const remaining = bundles.filter((name) => name !== pluginName && name !== "@beauticode/dsh-plugin");
    if (remaining.length !== bundles.length) {
      json.dsh.profile.bundles = remaining;
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

  const copied = await copyPackage(dest);
  await ensureEngine(dest);
  const indexFile = path.join(dest, "index.mjs");
  if (!fs.existsSync(indexFile)) {
    throw new Error(`缺少插件入口：${indexFile}`);
  }

  if (fs.existsSync(webPackage)) {
    await linkPluginIntoProfile(webProfile, dest);
    const loadsPluginBundle = await ensureWebPackageDep(webPackage, dest);
    const pluginPatch = path.join(dest, "cordis.patch.yml");
    const pluginShipsBridge =
      fs.existsSync(pluginPatch) && hasBridge(await fsp.readFile(pluginPatch, "utf8"));
    if (loadsPluginBundle && pluginShipsBridge) {
      // DSH composes only the bundles listed by this profile. Keep its
      // existing bundle mount and back up any redundant overlay entry.
      if (fs.existsSync(webPatch)) {
        const profilePatch = await fsp.readFile(webPatch, "utf8");
        if (hasBridge(profilePatch)) {
          await backupPatch(webPatch);
          await removePatch(webPatch);
        }
      }
    } else {
      await writePatch(webPatch, packageInsert(pluginName));
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
  await writePatch(homePatch, fileUriInsert(pathToFileURL(indexFile).href));
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
  const dest = path.resolve(opts.pluginHome);
  const pluginTarget = await assertPluginHomeTarget(dest, { forRemoval: true });
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
    if (await entryExists(link)) {
      const expected = link === pluginLinkPath(webProfile) ? dest : undefined;
      if (await isOwnedPluginLink(link, expected)) {
        await removeOwnedPluginEntry(link);
        removed.push(link);
      }
    }
  }
  if (pluginTarget.exists) {
    await removeOwnedPluginEntry(dest);
    removed.push(dest);
  }
  console.log(removed.length ? `已移除：${removed.join("、")}` : "没有可移除的 beautiCode 插件接线。");
  return { removed };
}

export async function runCli(argv = process.argv.slice(2)) {
  // Validate the entire command before resolving paths or installing anything.
  const actions = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dsh-home' || arg === '--plugin-home') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error(`Missing value for ${arg}`);
      i += 1;
    } else if (['--help', '-h', '--version', '-v', '--remove', '--status'].includes(arg)) {
      actions.push(arg === '-h' ? '--help' : arg === '-v' ? '--version' : arg);
    } else {
      throw new Error(`Unknown argument: ${arg}. Use --help.`);
    }
  }
  if (new Set(actions).size > 1) throw new Error('Conflicting actions. Use --help.');
  const action = actions[0] || 'install';
  if (action === '--help') {
    const help = 'Usage: beauticode-dsh [--remove] [--dsh-home PATH] [--plugin-home PATH]\nNo action: install. --help: show help. --version: show version. --status: inspect plugin files without writing.\nInstallation does not launch DeepSeek Harness.';
    console.log(help);
    return { help };
  }
  if (action === '--version') {
    const { version } = JSON.parse(await fsp.readFile(path.join(here, 'package.json'), 'utf8'));
    console.log(version);
    return { version };
  }
  const selectedHome = argValue(argv, "--dsh-home") || defaultDshHome();
  // A relocated DSH home defines the installation boundary. Guard its child paths separately.
  const dshHome = await fsp.realpath(selectedHome).catch(error => {
    if (error.code === "ENOENT") return selectedHome;
    throw error;
  });
  const requestedPluginHome = argValue(argv, "--plugin-home");
  const pluginHome = requestedPluginHome || defaultPluginHome(dshHome);
  const opts = {
    dshHome,
    pluginHome,
    legacyPluginHome: requestedPluginHome ? null : legacyDefaultPluginHome(),
  };
  if (action === '--status') {
    const filesPresent = await isManagedPluginDirectory(path.resolve(pluginHome));
    const result = {ok:true,pluginHome:path.resolve(pluginHome),filesPresent,state:filesPresent?'plugin-files-present':'not-installed',wiring:'not-verified',liveVerified:false};
    console.log(JSON.stringify(result,null,2));
    return result;
  }
  await checkProfileWiring(opts);
  if (action === '--remove') return uninstall(opts);
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

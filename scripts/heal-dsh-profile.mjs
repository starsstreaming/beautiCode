#!/usr/bin/env node
/**
 * Prepare $DSH_HOME so `dsh web` can resolve every bundled plugin on first
 * boot. DSH itself heals profiles/node_modules during startup, but two
 * overlapping boots race those junctions and leave the web profile unable
 * to import @deepseek-ai/*. This script is idempotent and is meant to run
 * under the launcher mutex before any dsh process is spawned.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_PACKAGES = [
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/cordis-plugin-timer",
];

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  const value = process.argv[idx + 1] ?? null;
  return value && !value.startsWith("--") ? value : null;
}

export function samePath(left, right) {
  const normalize = (value) =>
    path.resolve(String(value)).replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function realPathOrNull(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function sameRealPath(left, right) {
  const resolvedLeft = realPathOrNull(left);
  const resolvedRight = realPathOrNull(right);
  return Boolean(resolvedLeft && resolvedRight && samePath(resolvedLeft, resolvedRight));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function packageVisible(dir) {
  try {
    return fs.statSync(path.join(dir, "package.json")).isFile();
  } catch {
    return false;
  }
}

function waitUntilPackageVisible(dir, attempts = 25) {
  for (let i = 0; i < attempts; i += 1) {
    if (packageVisible(dir)) return true;
    sleepMs(40);
  }
  return packageVisible(dir);
}

function readLinkOrEmpty(link) {
  try {
    return fs.readlinkSync(link);
  } catch {
    return "";
  }
}

function isLinkTo(link, target) {
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) return false;
    return samePath(readLinkOrEmpty(link), target) || sameRealPath(link, target);
  } catch {
    return false;
  }
}

export function ensureJunction(link, target) {
  if (!isDirectory(target)) {
    throw new Error(`heal-dsh-profile: target is not a directory: ${target}`);
  }
  // dest/node_modules may itself be a junction onto the install tree. In that
  // case `link` *is* the install package — never delete it.
  if (samePath(link, target) || sameRealPath(link, target)) {
    if (!packageVisible(link)) {
      throw new Error(`heal-dsh-profile: install package has no package.json: ${target}`);
    }
    return "kept";
  }
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    stat = null;
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      const current = readLinkOrEmpty(link);
      if (samePath(current, target) && packageVisible(link)) return "kept";
      fs.unlinkSync(link);
    } else {
      fs.rmSync(link, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, "junction");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST" &&
      isLinkTo(link, target) &&
      waitUntilPackageVisible(link)
    ) {
      return "kept";
    }
    throw error;
  }
  waitUntilPackageVisible(link);
  return "linked";
}

export function removeShadowingProfileModules(dshHome) {
  const webModules = path.join(dshHome, "profiles", "web", "node_modules");
  if (!fs.existsSync(webModules)) return false;
  fs.rmSync(webModules, { recursive: true, force: true });
  return true;
}

export function initWebProfile(dshHome) {
  const dir = path.join(dshHome, "profiles", "web");
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          name: "dsh-profile-web",
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
        },
        null,
        2,
      )}\n`,
    );
  }
  return dir;
}

export function prepareDestNodeModules(destNodeModules, installNodeModules) {
  let stat;
  try {
    stat = fs.lstatSync(destNodeModules);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) {
    if (isLinkTo(destNodeModules, installNodeModules)) return "passthrough";
    fs.unlinkSync(destNodeModules);
  }
  fs.mkdirSync(destNodeModules, { recursive: true });
  return "directory";
}

export function packageDirFromAnchor(anchor, packageName) {
  const require = createRequire(pathToFileURL(path.resolve(anchor)).href);
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const candidate = path.join(searchPath, packageName);
    if (packageVisible(candidate)) return candidate;
  }
  return null;
}

export function linkRequiredPackages(installAnchor, destNodeModules) {
  const absAnchor = path.resolve(installAnchor);
  const required = new Map();
  required.set("@deepseek-ai/dsh", path.dirname(absAnchor));
  for (const name of REQUIRED_PACKAGES) {
    if (required.has(name)) continue;
    const dir = packageDirFromAnchor(absAnchor, name);
    if (dir) required.set(name, dir);
  }
  let linked = 0;
  for (const [name, target] of required) {
    try {
      ensureJunction(path.join(destNodeModules, ...name.split("/")), target);
      linked += 1;
    } catch {
      // Required-package retry happens in verify; do not abort heal.
    }
  }
  return linked;
}

export function linkDependencyClosure(installAnchor, destNodeModules) {
  const absAnchor = path.resolve(installAnchor);
  let appManifest;
  try {
    appManifest = JSON.parse(fs.readFileSync(absAnchor, "utf8"));
  } catch {
    return 0;
  }
  const links = new Map();
  if (appManifest.name) links.set(appManifest.name, path.dirname(absAnchor));
  const queue = [{ anchor: absAnchor, manifest: appManifest }];
  while (queue.length) {
    const next = queue.shift();
    const deps = [
      ...Object.keys(next.manifest.dependencies ?? {}),
      ...Object.keys(next.manifest.peerDependencies ?? {}),
    ];
    for (const dep of deps) {
      if (links.has(dep)) continue;
      const dir = packageDirFromAnchor(next.anchor, dep);
      if (!dir) continue;
      links.set(dep, dir);
      const manifestPath = path.join(dir, "package.json");
      try {
        queue.push({
          anchor: manifestPath,
          manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
        });
      } catch {
        // Skip a broken nested manifest.
      }
    }
  }
  let linked = 0;
  for (const [name, target] of links) {
    try {
      ensureJunction(path.join(destNodeModules, ...name.split("/")), target);
      linked += 1;
    } catch {
      // Continue the rest of the closure.
    }
  }
  return linked;
}

export function linkInstallModules(installNodeModules, destNodeModules) {
  if (!isDirectory(installNodeModules)) {
    throw new Error(`heal-dsh-profile: install node_modules missing: ${installNodeModules}`);
  }
  fs.mkdirSync(destNodeModules, { recursive: true });
  let linked = 0;
  for (const entry of fs.readdirSync(installNodeModules, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    const source = path.join(installNodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      const scopeDest = path.join(destNodeModules, entry.name);
      let scopeStat;
      try {
        scopeStat = fs.lstatSync(scopeDest);
      } catch {
        scopeStat = null;
      }
      if (scopeStat?.isSymbolicLink()) {
        if (sameRealPath(scopeDest, source)) continue;
        fs.unlinkSync(scopeDest);
      }
      fs.mkdirSync(scopeDest, { recursive: true });
      if (!isDirectory(source)) continue;
      for (const pkg of fs.readdirSync(source, { withFileTypes: true })) {
        if (pkg.name.startsWith(".")) continue;
        const pkgSource = path.join(source, pkg.name);
        if (!isDirectory(pkgSource)) continue;
        try {
          ensureJunction(path.join(scopeDest, pkg.name), pkgSource);
          linked += 1;
        } catch {
          // A single package must not abort first boot on a locked host.
        }
      }
      continue;
    }
    if (!isDirectory(source)) continue;
    try {
      ensureJunction(path.join(destNodeModules, entry.name), source);
      linked += 1;
    } catch {
      // Continue linking the rest of the install tree.
    }
  }
  return linked;
}

export function verifyProfileResolution(dshHome, packageNames = REQUIRED_PACKAGES) {
  const webManifest = path.join(dshHome, "profiles", "web", "package.json");
  const require = createRequire(pathToFileURL(webManifest).href);
  const resolved = {};
  for (const name of packageNames) {
    const packageJson = path.join(
      dshHome,
      "profiles",
      "node_modules",
      ...name.split("/"),
      "package.json",
    );
    const packageDir = path.dirname(packageJson);
    if (!waitUntilPackageVisible(packageDir)) {
      throw new Error(`heal-dsh-profile: ${name} is not visible from ${packageJson}`);
    }
    const search = require.resolve.paths(name) ?? [];
    const visible = search.some((dir) =>
      samePath(path.join(dir, name, "package.json"), packageJson) &&
      packageVisible(path.join(dir, name)),
    );
    if (!visible) {
      throw new Error(`heal-dsh-profile: Node cannot see ${name} from ${webManifest}`);
    }
    resolved[name] = packageJson;
  }
  require.resolve("@deepseek-ai/cordis-plugin-timer");
  return resolved;
}

function verifyWithRetry(dshHome, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return verifyProfileResolution(dshHome);
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw lastError;
}

export function healDshProfile({ dshHome, installAnchor }) {
  if (!dshHome) throw new Error("heal-dsh-profile: --dsh-home is required");
  if (!installAnchor) throw new Error("heal-dsh-profile: --install-anchor is required");
  const absHome = path.resolve(dshHome);
  const absAnchor = path.resolve(installAnchor);
  if (!fs.existsSync(absAnchor)) {
    throw new Error(`heal-dsh-profile: install anchor missing: ${absAnchor}`);
  }
  const installNodeModules = path.resolve(path.dirname(absAnchor), "..", "..");
  const destNodeModules = path.join(absHome, "profiles", "node_modules");
  fs.mkdirSync(absHome, { recursive: true });
  initWebProfile(absHome);
  const removedShadow = removeShadowingProfileModules(absHome);
  const destKind = prepareDestNodeModules(destNodeModules, installNodeModules);
  let linked = 0;
  if (destKind !== "passthrough") {
    linked += linkRequiredPackages(absAnchor, destNodeModules);
    linked += linkDependencyClosure(absAnchor, destNodeModules);
    linked += linkInstallModules(installNodeModules, destNodeModules);
  } else {
    linked += linkRequiredPackages(absAnchor, destNodeModules);
  }
  let resolved = {};
  let warning = "";
  try {
    resolved = verifyWithRetry(absHome);
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: !warning,
    dshHome: absHome,
    installNodeModules,
    destKind,
    linked,
    removedShadow,
    resolved,
    warning,
  };
}

const invokedAsCli =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    const result = healDshProfile({
      dshHome: argValue("--dsh-home"),
      installAnchor: argValue("--install-anchor"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

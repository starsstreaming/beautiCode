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

export function ensureJunction(link, target) {
  if (!isDirectory(target)) {
    throw new Error(`heal-dsh-profile: target is not a directory: ${target}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    stat = null;
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      let current = "";
      try {
        current = fs.readlinkSync(link);
      } catch {
        current = "";
      }
      if (samePath(current, target) || samePath(link, target)) return "kept";
      fs.unlinkSync(link);
    } else {
      fs.rmSync(link, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, "junction");
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
      if (scopeStat?.isSymbolicLink()) fs.unlinkSync(scopeDest);
      fs.mkdirSync(scopeDest, { recursive: true });
      if (!isDirectory(source)) continue;
      for (const pkg of fs.readdirSync(source, { withFileTypes: true })) {
        if (pkg.name.startsWith(".")) continue;
        const pkgSource = path.join(source, pkg.name);
        if (!isDirectory(pkgSource)) continue;
        ensureJunction(path.join(scopeDest, pkg.name), pkgSource);
        linked += 1;
      }
      continue;
    }
    if (!isDirectory(source)) continue;
    ensureJunction(path.join(destNodeModules, entry.name), source);
    linked += 1;
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
    if (!fs.existsSync(packageJson)) {
      throw new Error(`heal-dsh-profile: ${name} is not visible from ${packageJson}`);
    }
    const search = require.resolve.paths(name) ?? [];
    const visible = search.some((dir) =>
      samePath(path.join(dir, name, "package.json"), packageJson) &&
      fs.existsSync(path.join(dir, name, "package.json")),
    );
    if (!visible) {
      throw new Error(`heal-dsh-profile: Node cannot see ${name} from ${webManifest}`);
    }
    resolved[name] = packageJson;
  }
  require.resolve("@deepseek-ai/cordis-plugin-timer");
  return resolved;
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
  const linked = linkInstallModules(installNodeModules, destNodeModules);
  const resolved = verifyProfileResolution(absHome);
  return {
    dshHome: absHome,
    installNodeModules,
    linked,
    removedShadow,
    resolved,
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

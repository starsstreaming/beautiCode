import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  ACTIVE_DIR_NAME,
  MANIFEST_NAME,
  RUNTIME_MEDIA_DIR_NAME,
  SAVED_DIR_NAME,
  SCHEMA_ID,
  SNAPSHOTS_DIR_NAME,
  STAGING_DIR_NAME,
} from "./constants.js";

const DATA_ROOT_MARKER_NAME = ".beauticode-root.json";
const DATA_ROOT_SCHEMA = "beauticode.data-root/v1";

export function defaultDataRoot(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "beautiCode");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "beautiCode");
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "beautiCode");
}

export interface DataPaths {
  root: string;
  activeDir: string;
  stagingDir: string;
  snapshotsDir: string;
  savedDir: string;
  runtimeMediaDir: string;
}

export function resolveDataPaths(root: string = defaultDataRoot()): DataPaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    activeDir: path.join(resolved, ACTIVE_DIR_NAME),
    stagingDir: path.join(resolved, STAGING_DIR_NAME),
    snapshotsDir: path.join(resolved, SNAPSHOTS_DIR_NAME),
    savedDir: path.join(resolved, SAVED_DIR_NAME),
    runtimeMediaDir: path.join(resolved, RUNTIME_MEDIA_DIR_NAME),
  };
}

export async function ensureDataLayout(paths: DataPaths): Promise<void> {
  let rootExists = true;
  try {
    const stat = await fs.lstat(paths.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("beautiCode data root must be a real directory.");
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") throw error;
    rootExists = false;
    await fs.mkdir(paths.root, { recursive: true });
  }

  const markerPath = path.join(paths.root, DATA_ROOT_MARKER_NAME);
  let markerValid = false;
  try {
    const raw = await fs.readFile(markerPath, "utf8");
    const marker = JSON.parse(raw) as { schema?: unknown };
    markerValid = marker?.schema === DATA_ROOT_SCHEMA;
    if (!markerValid) {
      throw new Error("beautiCode data-root ownership marker is invalid.");
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") throw error;
  }

  if (!markerValid) {
    const entries = rootExists ? await fs.readdir(paths.root) : [];
    const allowedLegacyEntry = (entry: string): boolean =>
      entry === ACTIVE_DIR_NAME ||
      entry === STAGING_DIR_NAME ||
      entry === SNAPSHOTS_DIR_NAME ||
      entry === SAVED_DIR_NAME ||
      entry === RUNTIME_MEDIA_DIR_NAME ||
      entry === "logs" ||
      entry === "engine-launcher.log" ||
      entry === "injector.lock" ||
      entry === "store.lock" ||
      entry === "dsh-control.json" ||
      entry === "session-host.json" ||
      entry === "tray-claim.json" ||
      entry === "dsh-bridge.token" ||
      entry === ".beauticode-commit.json" ||
      entry === ".beauticode-commit-in-progress" ||
      entry.startsWith("active-backup-");
    let hasLegacyManifest = false;
    try {
      const raw = await fs.readFile(
        path.join(paths.activeDir, MANIFEST_NAME),
        "utf8",
      );
      const manifest = JSON.parse(raw) as { schema?: unknown };
      hasLegacyManifest = manifest?.schema === SCHEMA_ID;
    } catch {
      hasLegacyManifest = false;
    }
    if (
      entries.length > 0 &&
      !hasLegacyManifest &&
      !entries.every(allowedLegacyEntry)
    ) {
      throw new Error(
        "Refusing to adopt a non-empty directory without beautiCode data. Choose an empty --data-root.",
      );
    }
    const marker = `${JSON.stringify(
      {
        schema: DATA_ROOT_SCHEMA,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`;
    try {
      const handle = await fs.open(markerPath, "wx", 0o600);
      try {
        await handle.writeFile(marker, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "EEXIST") throw error;
      const raw = await fs.readFile(markerPath, "utf8");
      const existing = JSON.parse(raw) as { schema?: unknown };
      if (existing?.schema !== DATA_ROOT_SCHEMA) {
        throw new Error("beautiCode data-root ownership marker is invalid.");
      }
    }
  }

  await fs.mkdir(paths.stagingDir, { recursive: true });
  await fs.mkdir(paths.snapshotsDir, { recursive: true });
  await fs.mkdir(paths.savedDir, { recursive: true });
  await fs.mkdir(paths.runtimeMediaDir, { recursive: true });
}

/** True iff `candidate` is equal to or strictly inside `root`. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candResolved = path.resolve(candidate);
  if (rootResolved === candResolved) return true;
  const rel = path.relative(rootResolved, candResolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function rmrf(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

export async function emptyDir(target: string): Promise<void> {
  await rmrf(target);
  await fs.mkdir(target, { recursive: true });
}

export async function copyFileAtomic(
  source: string,
  destination: string,
): Promise<void> {
  const dir = path.dirname(destination);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.copyFile(source, tmp);
  await fs.rename(tmp, destination);
}

/**
 * Snapshot helper: use a same-volume hard link to avoid copying large media,
 * with an atomic-copy fallback for filesystems that do not support links.
 */
export async function linkOrCopyFileAtomic(
  source: string,
  destination: string,
): Promise<void> {
  const dir = path.dirname(destination);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.link(source, tmp);
    await fs.rename(tmp, destination);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    await copyFileAtomic(source, destination);
  }
}

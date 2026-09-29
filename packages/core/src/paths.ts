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

export type HostDataNamespace = "codex" | "dsh" | "workbuddy" | "cursor" | "doubao";

/** Keep host state separate while retaining one user-visible beautiCode root. */
export function hostDataRoot(
  host: HostDataNamespace,
  root: string = defaultDataRoot(),
): string {
  return path.join(path.resolve(root), "hosts", host);
}

const LEGACY_MIGRATION_ENTRIES = [
  ACTIVE_DIR_NAME,
  SAVED_DIR_NAME,
  SNAPSHOTS_DIR_NAME,
  RUNTIME_MEDIA_DIR_NAME,
  "logs",
] as const;

async function copyLegacyTree(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    throw new Error("Legacy beautiCode data must not contain symbolic links.");
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      await copyLegacyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!stat.isFile()) throw new Error("Legacy beautiCode data contains a non-regular entry.");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

/**
 * Copy legacy shared-root media into a host namespace exactly once. The old
 * root is never moved, removed, or rewritten; an existing namespaced root is
 * left untouched so a second process cannot overwrite user state.
 */
export async function migrateLegacyDataRoot(
  legacyRoot: string,
  hostRoot: string,
): Promise<boolean> {
  const sourceRoot = path.resolve(legacyRoot);
  const destinationRoot = path.resolve(hostRoot);
  if (sourceRoot === destinationRoot) return false;
  let sourceStat;
  try {
    sourceStat = await fs.lstat(sourceRoot);
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return false;
    throw error;
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Legacy beautiCode data root must be a real directory.");
  }
  let destinationEntries: string[] = [];
  try {
    const destinationStat = await fs.lstat(destinationRoot);
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
      throw new Error("Host beautiCode data root must be a real directory.");
    }
    destinationEntries = await fs.readdir(destinationRoot);
  } catch (error) {
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
  }
  if (destinationEntries.length > 0) return false;

  const available = [] as string[];
  for (const entry of LEGACY_MIGRATION_ENTRIES) {
    try {
      const stat = await fs.lstat(path.join(sourceRoot, entry));
      if (stat.isSymbolicLink()) throw new Error("Legacy beautiCode data must not contain symbolic links.");
      available.push(entry);
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") throw error;
    }
  }
  if (available.length === 0) return false;
  await fs.mkdir(destinationRoot, { recursive: true });
  for (const entry of available) {
    await copyLegacyTree(path.join(sourceRoot, entry), path.join(destinationRoot, entry));
  }
  return true;
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

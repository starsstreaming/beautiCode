import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import {
  COMMIT_MARKER_NAME,
  COMMIT_MARKER_STALE_MS,
  DEFAULT_VIDEO_BASENAME,
  MANIFEST_NAME,
  SAVED_META_NAME,
  SCHEMA_ID,
} from "./constants.js";
import {
  assertSafeBasename,
  MediaValidationError,
  validateImageFile,
  validateVideoFile,
} from "./media-validation.js";
import {
  copyFileAtomic,
  emptyDir,
  ensureDataLayout,
  isPathInsideRoot,
  linkOrCopyFileAtomic,
  resolveDataPaths,
  rmrf,
  type DataPaths,
} from "./paths.js";
import type {
  ApplyInput,
  BackgroundManifest,
  BackgroundMedia,
} from "./types.js";
import { normalizeBackgroundEffects } from "./types.js";
import {
  BUNDLED_GALLERY_THEME_ID,
  type BundledThemeSpec,
} from "./bundled-gallery.js";
import { acquireFileLock } from "./file-lock.js";

export interface BackgroundSnapshot {
  id: string;
  dir: string;
  manifest: BackgroundManifest;
}

export interface BackgroundStoreOptions {
  root?: string;
  commitMarkerStaleMs?: number;
  maxSavedThemes?: number;
  maxSavedBytes?: number;
  /** Always-visible built-in themes (plugin-shipped 画窗, etc.). */
  bundledThemes?: BundledThemeSpec[];
}

/** 1×1 transparent PNG — poster when video apply has no prior image. */
const SYNTHETIC_POSTER_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const COMMIT_JOURNAL_NAME = ".beauticode-commit.json";

interface CommitJournal {
  version: 1;
  phase: "prepared" | "old-moved" | "new-active";
  nextDir: string;
  backupDir: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyManifest(generation = 0): BackgroundManifest {
  return {
    schema: SCHEMA_ID,
    generation,
    background: null,
    updatedAt: nowIso(),
  };
}

function isManifest(value: unknown): value is BackgroundManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schema !== SCHEMA_ID) return false;
  if (typeof v.generation !== "number" || !Number.isInteger(v.generation) || v.generation < 0) {
    return false;
  }
  if (typeof v.updatedAt !== "string") return false;
  if (v.background === null) return true;
  if (!v.background || typeof v.background !== "object") return false;
  const b = v.background as Record<string, unknown>;
  if (b.type !== "image" && b.type !== "video") return false;
  if (typeof b.image !== "string") return false;
  if (b.type === "video" && typeof b.video !== "string") return false;
  if (b.effects != null && !normalizeBackgroundEffects(b.effects)) return false;
  return true;
}

export class BackgroundStore {
  readonly paths: DataPaths;
  readonly commitMarkerStaleMs: number;
  readonly maxSavedThemes: number;
  readonly maxSavedBytes: number;
  readonly bundledThemes: BundledThemeSpec[];
  readonly #runtimeSessionName = `session-${process.pid}-${crypto.randomUUID()}`;
  #runtimeVideoCache = new Map<number, string>();
  #writeChain: Promise<unknown> = Promise.resolve();
  #writeContext = new AsyncLocalStorage<boolean>();

  constructor(opts: BackgroundStoreOptions = {}) {
    this.paths = resolveDataPaths(opts.root);
    this.commitMarkerStaleMs = opts.commitMarkerStaleMs ?? COMMIT_MARKER_STALE_MS;
    this.maxSavedThemes = opts.maxSavedThemes ?? 20;
    this.maxSavedBytes = opts.maxSavedBytes ?? 2 * 1024 * 1024 * 1024;
    this.bundledThemes = normalizeBundledThemes(opts.bundledThemes);
  }

  async init(): Promise<void> {
    await ensureDataLayout(this.paths);
    const markerFresh = await this.#isCommitMarkerFresh();
    if (!markerFresh || this.#writeContext.getStore()) {
      await this.#recoverInterruptedCommit();
      await fs.mkdir(this.paths.activeDir, { recursive: true });
    } else {
      return;
    }
    const manifestPath = path.join(this.paths.activeDir, MANIFEST_NAME);
    try {
      await fs.access(manifestPath);
    } catch {
      await this.#writeJsonAtomic(manifestPath, emptyManifest(0));
    }
  }

  #markerPath(): string {
    return path.join(this.paths.root, COMMIT_MARKER_NAME);
  }

  #legacyMarkerPath(): string {
    return path.join(this.paths.activeDir, COMMIT_MARKER_NAME);
  }

  async #isCommitMarkerFresh(): Promise<boolean> {
    for (const marker of [this.#markerPath(), this.#legacyMarkerPath()]) {
      try {
        const st = await fs.stat(marker);
        if (Date.now() - st.mtimeMs <= this.commitMarkerStaleMs) return true;
      } catch {
        /* absent */
      }
    }
    return false;
  }

  async #assertNotCommitting(): Promise<void> {
    if (await this.#isCommitMarkerFresh()) {
      throw new MediaValidationError(
        "Background store commit in progress; refusing half-written tree.",
      );
    }
    await this.#recoverInterruptedCommit();
  }

  async #writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tmp, filePath);
  }

  #journalPath(): string {
    return path.join(this.paths.root, COMMIT_JOURNAL_NAME);
  }

  async #hasValidManifest(dir: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(path.join(dir, MANIFEST_NAME), "utf8");
      return isManifest(JSON.parse(raw) as unknown);
    } catch {
      return false;
    }
  }

  async #recoverInterruptedCommit(): Promise<void> {
    let journal: CommitJournal | null = null;
    try {
      const raw = await fs.readFile(this.#journalPath(), "utf8");
      const value = JSON.parse(raw) as Partial<CommitJournal>;
      if (
        value.version === 1 &&
        (value.phase === "prepared" ||
          value.phase === "old-moved" ||
          value.phase === "new-active") &&
        typeof value.nextDir === "string" &&
        /^tx-[A-Za-z0-9._-]+$/.test(value.nextDir) &&
        typeof value.backupDir === "string" &&
        /^active-backup-[A-Za-z0-9._-]+$/.test(value.backupDir)
      ) {
        journal = value as CommitJournal;
      }
    } catch {
      /* no journal */
    }

    if (!journal) {
      await fs.rm(this.#journalPath(), { force: true }).catch(() => {});
      await fs.rm(this.#markerPath(), { force: true }).catch(() => {});
      await fs.rm(this.#legacyMarkerPath(), { force: true }).catch(() => {});
      return;
    }

    const nextDir = path.join(this.paths.stagingDir, journal.nextDir);
    const backupDir = path.join(this.paths.root, journal.backupDir);
    if (
      !isPathInsideRoot(this.paths.stagingDir, nextDir) ||
      !isPathInsideRoot(this.paths.root, backupDir)
    ) {
      throw new MediaValidationError("Commit recovery journal escaped data root.");
    }

    const activeValid = await this.#hasValidManifest(this.paths.activeDir);
    const nextValid = await this.#hasValidManifest(nextDir);
    const backupValid = await this.#hasValidManifest(backupDir);

    if (!activeValid) {
      await rmrf(this.paths.activeDir);
      if (nextValid) {
        await fs.rename(nextDir, this.paths.activeDir);
      } else if (backupValid) {
        await fs.rename(backupDir, this.paths.activeDir);
      } else {
        throw new MediaValidationError(
          "Interrupted commit could not recover either active generation.",
        );
      }
    }

    await rmrf(nextDir);
    await rmrf(backupDir);
    await fs.rm(this.#journalPath(), { force: true });
    await fs.rm(this.#markerPath(), { force: true });
    await fs.rm(this.#legacyMarkerPath(), { force: true }).catch(() => {});
  }

  async #createStagingDir(): Promise<string> {
    await fs.mkdir(this.paths.stagingDir, { recursive: true });
    return fs.mkdtemp(path.join(this.paths.stagingDir, "tx-"));
  }

  async readActiveManifest(): Promise<BackgroundManifest> {
    await this.init();
    await this.#assertNotCommitting();
    const manifestPath = path.join(this.paths.activeDir, MANIFEST_NAME);
    const raw = await fs.readFile(manifestPath, "utf8");
    // End-of-load marker check (race with writer).
    await this.#assertNotCommitting();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MediaValidationError("Active background manifest is not valid JSON.");
    }
    if (!isManifest(parsed)) {
      throw new MediaValidationError("Active background manifest failed schema checks.");
    }
    if (parsed.background) {
      assertSafeBasename(parsed.background.image, "background.image");
      if (parsed.background.video) {
        assertSafeBasename(parsed.background.video, "background.video");
      }
    }
    return parsed;
  }

  async activeImagePath(): Promise<string | null> {
    const m = await this.readActiveManifest();
    if (!m.background) return null;
    return path.join(this.paths.activeDir, m.background.image);
  }

  async activeVideoPath(): Promise<string | null> {
    const m = await this.readActiveManifest();
    if (!m.background || m.background.type !== "video" || !m.background.video) {
      return null;
    }
    return path.join(this.paths.activeDir, m.background.video);
  }

  /**
   * Serialize mutations. Prevents concurrent stage/commit interleaving
   * (upstream tray recursion / dueling writers lesson).
   */
  async #withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#writeContext.getStore()) return fn();
    const guarded = async (): Promise<T> => {
      const lease = await acquireFileLock(
        path.join(this.paths.root, "store.lock"),
        { purpose: "beautiCode store mutation" },
      );
      try {
        return await this.#writeContext.run(true, fn);
      } finally {
        await lease.release();
      }
    };
    const run = this.#writeChain.then(guarded, guarded);
    this.#writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Copy the active video to a renderer-only path outside `active`.
   *
   * Chromium keeps a Windows file handle for videos attached through
   * DOM.setFileInputFiles. Pointing it at `active/background.mp4` prevents the
   * next atomic active-directory rotation with EPERM. The detached copy keeps
   * renderer lifetime independent from the disk transaction.
   */
  async prepareRuntimeVideo(
    manifest: BackgroundManifest,
  ): Promise<string | null> {
    return this.#withWriteLock(async () => {
      if (
        manifest.background?.type !== "video" ||
        !manifest.background.video
      ) {
        return null;
      }
      await this.init();

      const cached = this.#runtimeVideoCache.get(manifest.generation);
      if (cached) {
        try {
          await validateVideoFile(cached);
          return cached;
        } catch {
          this.#runtimeVideoCache.delete(manifest.generation);
        }
      }

      const source = path.join(
        this.paths.activeDir,
        manifest.background.video,
      );
      const validated = await validateVideoFile(source);
      const sessionDir = path.join(
        this.paths.runtimeMediaDir,
        this.#runtimeSessionName,
      );
      if (!isPathInsideRoot(this.paths.runtimeMediaDir, sessionDir)) {
        throw new MediaValidationError(
          "Runtime media path escaped runtime-media root.",
        );
      }
      const runtimeRootStat = await fs.lstat(this.paths.runtimeMediaDir);
      if (
        !runtimeRootStat.isDirectory() ||
        runtimeRootStat.isSymbolicLink()
      ) {
        throw new MediaValidationError(
          "Runtime media root must be a real directory.",
        );
      }
      await fs.mkdir(sessionDir, { recursive: true });
      const sessionStat = await fs.lstat(sessionDir);
      if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
        throw new MediaValidationError(
          "Runtime media session must be a real directory.",
        );
      }
      const [realRuntimeRoot, realSessionDir] = await Promise.all([
        fs.realpath(this.paths.runtimeMediaDir),
        fs.realpath(sessionDir),
      ]);
      if (!isPathInsideRoot(realRuntimeRoot, realSessionDir)) {
        throw new MediaValidationError(
          "Runtime media session escaped runtime-media root.",
        );
      }

      const destination = path.join(
        sessionDir,
        `video-${manifest.generation}-${validated.identity.slice(0, 16)}.mp4`,
      );
      await copyFileAtomic(validated.filePath, destination);
      const copied = await validateVideoFile(destination);
      if (copied.identity !== validated.identity) {
        await fs.rm(destination, { force: true }).catch(() => {});
        throw new MediaValidationError(
          "Runtime video copy failed its identity check.",
        );
      }
      this.#runtimeVideoCache.set(manifest.generation, destination);
      await this.#pruneRuntimeMediaUnlocked(destination);
      return destination;
    });
  }

  /**
   * Best-effort cleanup. Locked stale files are retained and retried on the
   * next apply/start instead of turning successful theme switching into an
   * error.
   */
  async pruneRuntimeMedia(keepPath: string | null = null): Promise<void> {
    await this.#withWriteLock(async () => {
      await this.init();
      await this.#pruneRuntimeMediaUnlocked(keepPath);
    });
  }

  async #pruneRuntimeMediaUnlocked(
    keepPath: string | null,
  ): Promise<void> {
    const runtimeRoot = path.resolve(this.paths.runtimeMediaDir);
    const keep =
      keepPath && isPathInsideRoot(runtimeRoot, keepPath)
        ? path.resolve(keepPath)
        : null;
    let sessions: string[];
    try {
      sessions = await fs.readdir(runtimeRoot);
    } catch {
      return;
    }

    for (const name of sessions) {
      if (!/^session-[A-Za-z0-9._-]+$/.test(name)) continue;
      const sessionDir = path.join(runtimeRoot, name);
      if (!isPathInsideRoot(runtimeRoot, sessionDir)) continue;
      if (!keep || !isPathInsideRoot(sessionDir, keep)) {
        await rmrf(sessionDir).catch(() => {});
        continue;
      }
      let files: string[];
      try {
        files = await fs.readdir(sessionDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const candidate = path.resolve(sessionDir, file);
        if (candidate === keep || !isPathInsideRoot(sessionDir, candidate)) {
          continue;
        }
        await fs.rm(candidate, { recursive: true, force: true }).catch(() => {});
      }
    }

    for (const [generation, cached] of this.#runtimeVideoCache) {
      if (path.resolve(cached) !== keep) {
        this.#runtimeVideoCache.delete(generation);
      }
    }
  }

  /**
   * Hold the store lease across a multi-step apply/verify/rollback sequence.
   * Nested store mutations in the same async context are re-entrant.
   */
  async withExclusiveMutation<T>(fn: () => Promise<T>): Promise<T> {
    return this.#withWriteLock(fn);
  }

  async snapshot(): Promise<BackgroundSnapshot> {
    return this.#withWriteLock(async () => {
      await this.init();
      const manifest = await this.readActiveManifest();
      const id = `snap-${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
      const dir = path.join(this.paths.snapshotsDir, id);
      if (!isPathInsideRoot(this.paths.root, dir)) {
        throw new MediaValidationError("Snapshot path escaped data root.");
      }
      await emptyDir(dir);
      await this.#writeJsonAtomic(path.join(dir, MANIFEST_NAME), manifest);
      if (manifest.background) {
        const imgSrc = path.join(this.paths.activeDir, manifest.background.image);
        const imgDst = path.join(dir, manifest.background.image);
        await linkOrCopyFileAtomic(imgSrc, imgDst);
        if (manifest.background.video) {
          const vSrc = path.join(this.paths.activeDir, manifest.background.video);
          const vDst = path.join(dir, manifest.background.video);
          await linkOrCopyFileAtomic(vSrc, vDst);
        }
      }
      return { id, dir, manifest };
    });
  }

  async clearSnapshot(snapshot: BackgroundSnapshot): Promise<void> {
    await this.#assertSnapshotPath(snapshot);
    await rmrf(snapshot.dir);
  }

  async #assertSnapshotPath(snapshot: BackgroundSnapshot): Promise<void> {
    const dir = path.resolve(snapshot.dir);
    if (
      dir === path.resolve(this.paths.snapshotsDir) ||
      !isPathInsideRoot(this.paths.snapshotsDir, dir) ||
      !/^snap-[A-Za-z0-9._-]+$/.test(path.basename(dir))
    ) {
      throw new MediaValidationError(
        "Snapshot must be a generated child of the snapshots directory.",
      );
    }
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new MediaValidationError("Snapshot directory cannot be a link.");
    }
    const [realRoot, realDir] = await Promise.all([
      fs.realpath(this.paths.snapshotsDir),
      fs.realpath(dir),
    ]);
    if (
      realDir === realRoot ||
      !isPathInsideRoot(realRoot, realDir)
    ) {
      throw new MediaValidationError(
        "Snapshot real path escaped the snapshots directory.",
      );
    }
  }

  /**
   * Import user media into a fresh staging tree and atomically promote it to
   * active. Returns the new manifest.
   */
  async commitImport(input: ApplyInput): Promise<BackgroundManifest> {
    return this.#withWriteLock(async () => {
      await this.init();
      const previous = await this.readActiveManifest();
      const generation = previous.generation + 1;

      const stagingDir = await this.#createStagingDir();
      try {
        let background: BackgroundMedia | null = null;

        if (input.type === "image") {
          const image = await validateImageFile(input.imagePath);
          // Keep extension from source when it's an allowed one.
          const basename = `poster${image.extension === ".jpeg" ? ".jpg" : image.extension}`;
          assertSafeBasename(basename, "image");
          await copyFileAtomic(image.filePath, path.join(stagingDir, basename));
          background = { type: "image", image: basename };
          const effects = normalizeBackgroundEffects(input.effects);
          if (effects) background.effects = effects;
        } else if (input.type === "video") {
          const video = await validateVideoFile(input.videoPath);
          assertSafeBasename(DEFAULT_VIDEO_BASENAME, "video");
          await copyFileAtomic(
            video.filePath,
            path.join(stagingDir, DEFAULT_VIDEO_BASENAME),
          );
          // Poster: explicit path → reuse active image → synthetic 1x1 PNG.
          let imageBasename: string;
          if (input.imagePath) {
            const image = await validateImageFile(input.imagePath);
            imageBasename = `poster${image.extension === ".jpeg" ? ".jpg" : image.extension}`;
            assertSafeBasename(imageBasename, "image");
            await copyFileAtomic(
              image.filePath,
              path.join(stagingDir, imageBasename),
            );
          } else if (previous.background?.image) {
            const prevImage = path.join(
              this.paths.activeDir,
              previous.background.image,
            );
            const image = await validateImageFile(prevImage);
            imageBasename = `poster${image.extension === ".jpeg" ? ".jpg" : image.extension}`;
            assertSafeBasename(imageBasename, "image");
            await copyFileAtomic(
              image.filePath,
              path.join(stagingDir, imageBasename),
            );
          } else {
            imageBasename = "poster.png";
            assertSafeBasename(imageBasename, "image");
            await fs.writeFile(
              path.join(stagingDir, imageBasename),
              SYNTHETIC_POSTER_PNG,
            );
          }
          background = {
            type: "video",
            image: imageBasename,
            video: DEFAULT_VIDEO_BASENAME,
          };
        } else {
          background = null;
        }

        const manifest: BackgroundManifest = {
          schema: SCHEMA_ID,
          generation,
          background,
          updatedAt: nowIso(),
        };
        await this.#writeJsonAtomic(
          path.join(stagingDir, MANIFEST_NAME),
          manifest,
        );

        // Validate staged tree as a whole before promote.
        await this.#validateTree(stagingDir, manifest);

        await this.#promoteStagingToActive(stagingDir);
        // Post-commit read must succeed.
        return this.readActiveManifest();
      } finally {
        await rmrf(stagingDir);
      }
    });
  }

  async restoreSnapshot(snapshot: BackgroundSnapshot): Promise<BackgroundManifest> {
    return this.#withWriteLock(async () => {
      await this.#assertSnapshotPath(snapshot);
      await this.init();
      const raw = await fs.readFile(path.join(snapshot.dir, MANIFEST_NAME), "utf8");
      const manifest = JSON.parse(raw) as BackgroundManifest;
      if (!isManifest(manifest)) {
        throw new MediaValidationError("Snapshot manifest is invalid.");
      }
      // Bump generation so host payloads cannot be confused with the failed attempt.
      const restored: BackgroundManifest = {
        ...manifest,
        generation: (await this.readActiveManifest()).generation + 1,
        updatedAt: nowIso(),
      };

      const stagingDir = await this.#createStagingDir();
      try {
        await this.#writeJsonAtomic(
          path.join(stagingDir, MANIFEST_NAME),
          restored,
        );
        if (restored.background) {
          await copyFileAtomic(
            path.join(snapshot.dir, restored.background.image),
            path.join(stagingDir, restored.background.image),
          );
          if (restored.background.video) {
            await copyFileAtomic(
              path.join(snapshot.dir, restored.background.video),
              path.join(stagingDir, restored.background.video),
            );
          }
        }
        await this.#validateTree(stagingDir, restored);
        await this.#promoteStagingToActive(stagingDir);
        return this.readActiveManifest();
      } finally {
        await rmrf(stagingDir);
      }
    });
  }

  async #validateTree(dir: string, manifest: BackgroundManifest): Promise<void> {
    if (!manifest.background) return;
    const imagePath = path.join(dir, manifest.background.image);
    await validateImageFile(imagePath);
    if (manifest.background.video) {
      const videoPath = path.join(dir, manifest.background.video);
      await validateVideoFile(videoPath);
    }
  }

  async #promoteStagingToActive(stagingDir: string): Promise<void> {
    if (
      stagingDir === this.paths.stagingDir ||
      !isPathInsideRoot(this.paths.stagingDir, stagingDir)
    ) {
      throw new MediaValidationError("Staging transaction escaped staging root.");
    }
    const token = `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
    const backupDir = path.join(this.paths.root, `active-backup-${token}`);
    const journal: CommitJournal = {
      version: 1,
      phase: "prepared",
      nextDir: path.basename(stagingDir),
      backupDir: path.basename(backupDir),
    };

    await fs.writeFile(this.#markerPath(), token, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await this.#writeJsonAtomic(this.#journalPath(), journal);
    try {
      await fs.rename(this.paths.activeDir, backupDir);
      journal.phase = "old-moved";
      await this.#writeJsonAtomic(this.#journalPath(), journal);

      await fs.rename(stagingDir, this.paths.activeDir);
      journal.phase = "new-active";
      await this.#writeJsonAtomic(this.#journalPath(), journal);

      if (!(await this.#hasValidManifest(this.paths.activeDir))) {
        throw new MediaValidationError("Promoted active manifest is invalid.");
      }
      await rmrf(backupDir);
      await fs.rm(this.#journalPath(), { force: true });
      await fs.rm(this.#markerPath(), { force: true });
    } catch (error) {
      await this.#recoverInterruptedCommit().catch(() => {});
      throw error;
    }
  }

  /**
   * Snapshot the current active image/video into saved/<id>/ so the user can
   * restore it later ("保存当前主题"). No-op-safe: refuses when background is clear.
   * Optional videoPositionSec is stored on video themes for resume-on-restore.
   */
  async saveCurrentTheme(
    name: string,
    opts: { videoPositionSec?: number | null } = {},
  ): Promise<SavedThemeInfo> {
    return this.#withWriteLock(async () => {
      await this.init();
      const trimmed = String(name ?? "").trim();
      if (!trimmed || trimmed.length > 80) {
        throw new MediaValidationError("Theme name must be 1–80 characters.");
      }
      if (/[<>:"/\|?*]/.test(trimmed) || Array.from(trimmed).some((ch) => ch.charCodeAt(0) < 32)) {
        throw new MediaValidationError("Theme name contains illegal characters.");
      }
      const manifest = await this.readActiveManifest();
      if (!manifest.background) {
        throw new MediaValidationError("No active background to save.");
      }
      const usage = await this.#savedThemeUsage();
      if (usage.count >= this.maxSavedThemes) {
        throw new MediaValidationError(
          `Saved theme limit reached (${this.maxSavedThemes}). Delete one before saving.`,
        );
      }
      let incomingBytes = (await fs.stat(
        path.join(this.paths.activeDir, manifest.background.image),
      )).size;
      if (manifest.background.video) {
        incomingBytes += (await fs.stat(
          path.join(this.paths.activeDir, manifest.background.video),
        )).size;
      }
      if (usage.bytes + incomingBytes > this.maxSavedBytes) {
        throw new MediaValidationError(
          `Saved theme storage limit exceeded (${this.maxSavedBytes} bytes). Delete a theme before saving.`,
        );
      }

      const id = slugThemeId(trimmed);
      const dir = path.join(this.paths.savedDir, id);
      if (!isPathInsideRoot(this.paths.savedDir, dir)) {
        throw new MediaValidationError("Saved theme path escaped saved root.");
      }
      const stagingDir = await this.#createStagingDir();
      try {
        const imageSrc = path.join(
          this.paths.activeDir,
          manifest.background.image,
        );
        await copyFileAtomic(
          imageSrc,
          path.join(stagingDir, manifest.background.image),
        );
        if (manifest.background.video) {
          await copyFileAtomic(
            path.join(this.paths.activeDir, manifest.background.video),
            path.join(stagingDir, manifest.background.video),
          );
        }

        // Persist media only — generation is assigned on restore.
        const savedManifest: BackgroundManifest = {
          schema: SCHEMA_ID,
          generation: 0,
          background: { ...manifest.background },
          updatedAt: nowIso(),
        };
        await this.#writeJsonAtomic(
          path.join(stagingDir, MANIFEST_NAME),
          savedManifest,
        );
        const meta: SavedThemeMeta = {
          id,
          name: trimmed,
          type: manifest.background.type,
          savedAt: nowIso(),
        };
        if (manifest.background.type === "video") {
          const pos = normalizeVideoPositionSec(opts.videoPositionSec);
          if (pos != null) {
            meta.videoPositionSec = pos;
            meta.videoPositionUpdatedAt = nowIso();
          }
        }
        await this.#writeJsonAtomic(
          path.join(stagingDir, SAVED_META_NAME),
          meta,
        );
        await this.#validateTree(stagingDir, savedManifest);
        // Same-volume directory rename makes a saved theme appear all at once.
        await fs.rename(stagingDir, dir);

        const info: SavedThemeInfo = {
          id,
          name: trimmed,
          type: manifest.background.type,
          path: dir,
          savedAt: meta.savedAt,
        };
        if (typeof meta.videoPositionSec === "number") {
          info.videoPositionSec = meta.videoPositionSec;
        }
        return info;
      } finally {
        await rmrf(stagingDir);
      }
    });
  }

  async listSavedThemes(): Promise<SavedThemeInfo[]> {
    await this.init();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.paths.savedDir);
    } catch {
      return [];
    }
    const out: SavedThemeInfo[] = [];
    for (const entry of entries) {
      const dir = path.join(this.paths.savedDir, entry);
      if (!isPathInsideRoot(this.paths.savedDir, dir)) continue;
      try {
        await this.#assertSafeSavedThemeDir(dir);
        const metaRaw = await fs.readFile(path.join(dir, SAVED_META_NAME), "utf8");
        const meta = JSON.parse(metaRaw) as SavedThemeMeta;
        if (!meta || typeof meta.name !== "string") {
          continue;
        }
        // Ensure media still present.
        const mRaw = await fs.readFile(path.join(dir, MANIFEST_NAME), "utf8");
        const m = JSON.parse(mRaw) as BackgroundManifest;
        if (!isManifest(m) || !m.background) continue;
        // Directory basename is the authoritative id (filesystem truth).
        // Older builds stored non-ASCII meta.id that useSavedTheme rejected.
        const pos = normalizeVideoPositionSec(meta.videoPositionSec);
        out.push({
          id: entry,
          name: meta.name,
          type: m.background.type,
          path: dir,
          savedAt: typeof meta.savedAt === "string" ? meta.savedAt : "",
          ...(pos != null && m.background.type === "video"
            ? { videoPositionSec: pos }
            : {}),
        });
      } catch {
        /* skip broken entries */
      }
    }
    const bundledIds = new Set(this.bundledThemes.map((spec) => spec.id));
    const disk = out.filter((theme) => !bundledIds.has(theme.id));
    const bundled = await this.#bundledThemeInfos();
    const listed = [...bundled, ...disk];
    listed.sort((a, b) => {
      const bundledRank = Number(Boolean(b.bundled)) - Number(Boolean(a.bundled));
      if (bundledRank !== 0) return bundledRank;
      return a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0;
    });
    return listed;
  }

  async deleteSavedTheme(themeId: string): Promise<boolean> {
    return this.#withWriteLock(async () => {
      await this.init();
      const id = String(themeId ?? "").trim();
      if (!isSafeThemeId(id)) {
        throw new MediaValidationError("Invalid saved theme id.");
      }
      if (this.#isBundledThemeId(id)) {
        throw new MediaValidationError("Built-in theme cannot be deleted.");
      }
      const dir = await this.#resolveSavedThemeDir(id);
      if (!dir) return false;
      await this.#assertSafeSavedThemeDir(dir);
      await rmrf(dir);
      return true;
    });
  }

  /**
   * Read saved theme resume position (seconds). Image themes / missing → null.
   * Invalid values → null (caller seeks to 0).
   */
  async getSavedThemeVideoPosition(themeId: string): Promise<number | null> {
    await this.init();
    const id = String(themeId ?? "").trim();
    if (!isSafeThemeId(id)) return null;
    const dir = await this.#resolveSavedThemeDir(id);
    if (!dir) return null;
    try {
      const metaRaw = await fs.readFile(path.join(dir, SAVED_META_NAME), "utf8");
      const meta = JSON.parse(metaRaw) as SavedThemeMeta;
      if (!meta || meta.type !== "video") return null;
      return normalizeVideoPositionSec(meta.videoPositionSec);
    } catch {
      return null;
    }
  }

  /**
   * Continuously update a video theme's resume position on disk.
   * Bound to that theme only. No-op / refuse for image themes or missing ids.
   * Skips rewrite when the rounded position is unchanged (reduces disk churn).
   */
  async updateSavedThemeVideoPosition(
    themeId: string,
    positionSec: number,
  ): Promise<{ ok: boolean; positionSec: number | null; error?: string }> {
    return this.#withWriteLock(async () => {
      await this.init();
      const id = String(themeId ?? "").trim();
      if (!isSafeThemeId(id)) {
        return { ok: false, positionSec: null, error: "Invalid saved theme id." };
      }
      const dir = await this.#resolveSavedThemeDir(id);
      if (!dir) {
        return { ok: false, positionSec: null, error: "Saved theme not found." };
      }
      const pos = normalizeVideoPositionSec(positionSec);
      if (pos == null) {
        // Explicit invalid → write 0 so corrupt live values recover to start.
        // Callers that want "leave alone" should filter first.
        return { ok: false, positionSec: null, error: "Invalid video position." };
      }
      let meta: SavedThemeMeta;
      try {
        const metaRaw = await fs.readFile(path.join(dir, SAVED_META_NAME), "utf8");
        meta = JSON.parse(metaRaw) as SavedThemeMeta;
      } catch {
        return { ok: false, positionSec: null, error: "Theme meta unreadable." };
      }
      if (!meta || typeof meta.name !== "string") {
        return { ok: false, positionSec: null, error: "Theme meta invalid." };
      }
      if (meta.type !== "video") {
        return { ok: false, positionSec: null, error: "Not a video theme." };
      }
      const prev = normalizeVideoPositionSec(meta.videoPositionSec);
      // Skip identical position (same ms) to avoid thrashing the disk every poll.
      if (prev != null && prev === pos) {
        return { ok: true, positionSec: pos };
      }
      const next: SavedThemeMeta = {
        ...meta,
        id: typeof meta.id === "string" ? meta.id : id,
        type: "video",
        videoPositionSec: pos,
        videoPositionUpdatedAt: nowIso(),
      };
      await this.#writeJsonAtomic(path.join(dir, SAVED_META_NAME), next);
      return { ok: true, positionSec: pos };
    });
  }

  /**
   * Resolve a saved theme to ordinary import paths without mutating active.
   * The caller can feed this into ApplyTransaction so host verify and rollback
   * cover saved-theme switches too.
   */
  async loadSavedTheme(
    themeId: string,
  ): Promise<{
    input: ApplyInput;
    videoPositionSec: number | null;
    themeId: string;
  }> {
    await this.init();
    const id = String(themeId ?? "").trim();
    if (!isSafeThemeId(id)) {
      throw new MediaValidationError("Invalid saved theme id.");
    }
    const bundled = this.#bundledThemeSpec(id);
    if (bundled) {
      await validateImageFile(bundled.imagePath);
      const input: Extract<ApplyInput, { type: "image" }> = {
        type: "image",
        imagePath: bundled.imagePath,
      };
      const effects = normalizeBackgroundEffects(bundled.effects);
      if (effects) input.effects = effects;
      return {
        input,
        videoPositionSec: null,
        themeId: id,
      };
    }
    const dir = await this.#resolveSavedThemeDir(id);
    if (!dir) {
      throw new MediaValidationError("Saved theme not found.");
    }
    await this.#assertSafeSavedThemeDir(dir);
    const raw = await fs.readFile(path.join(dir, MANIFEST_NAME), "utf8");
    const parsed = JSON.parse(raw) as BackgroundManifest;
    if (!isManifest(parsed) || !parsed.background) {
      throw new MediaValidationError("Saved theme manifest is invalid.");
    }
    await this.#validateTree(dir, parsed);

    const imagePath = path.join(dir, parsed.background.image);
    if (parsed.background.type === "image") {
      const input: Extract<ApplyInput, { type: "image" }> = {
        type: "image",
        imagePath,
      };
      const effects = normalizeBackgroundEffects(parsed.background.effects);
      if (effects) input.effects = effects;
      return {
        input,
        videoPositionSec: null,
        themeId: id,
      };
    }
    if (!parsed.background.video) {
      throw new MediaValidationError("Saved video theme has no video file.");
    }
    let videoPositionSec: number | null = null;
    try {
      const metaRaw = await fs.readFile(path.join(dir, SAVED_META_NAME), "utf8");
      const meta = JSON.parse(metaRaw) as SavedThemeMeta;
      videoPositionSec = normalizeVideoPositionSec(meta?.videoPositionSec);
    } catch {
      videoPositionSec = null;
    }
    const input: Extract<ApplyInput, { type: "video" }> = {
      type: "video",
      imagePath,
      videoPath: path.join(dir, parsed.background.video),
    };
    if (videoPositionSec != null && videoPositionSec > 0) {
      input.startAt = videoPositionSec;
    }
    return { input, videoPositionSec, themeId: id };
  }

  /**
   * Promote a previously saved theme into active (bumps generation).
   * Returns the new active manifest plus the resume position from theme meta
   * (video only; invalid/missing → null → start at 0).
   */
  async useSavedTheme(
    themeId: string,
  ): Promise<{ manifest: BackgroundManifest; videoPositionSec: number | null }> {
    return this.#withWriteLock(async () => {
      await this.init();
      const id = String(themeId ?? "").trim();
      if (!isSafeThemeId(id)) {
        throw new MediaValidationError("Invalid saved theme id.");
      }
      const bundled = this.#bundledThemeSpec(id);
      if (bundled) {
        const input: Extract<ApplyInput, { type: "image" }> = {
          type: "image",
          imagePath: bundled.imagePath,
        };
        const effects = normalizeBackgroundEffects(bundled.effects);
        if (effects) input.effects = effects;
        const manifest = await this.commitImport(input);
        return { manifest, videoPositionSec: null };
      }
      const dir = await this.#resolveSavedThemeDir(id);
      if (!dir) {
        throw new MediaValidationError("Saved theme not found.");
      }
      const raw = await fs.readFile(path.join(dir, MANIFEST_NAME), "utf8");
      const parsed = JSON.parse(raw) as BackgroundManifest;
      if (!isManifest(parsed) || !parsed.background) {
        throw new MediaValidationError("Saved theme manifest is invalid.");
      }
      await this.#validateTree(dir, parsed);

      let videoPositionSec: number | null = null;
      if (parsed.background.type === "video") {
        try {
          const metaRaw = await fs.readFile(path.join(dir, SAVED_META_NAME), "utf8");
          const meta = JSON.parse(metaRaw) as SavedThemeMeta;
          videoPositionSec = normalizeVideoPositionSec(meta?.videoPositionSec);
        } catch {
          videoPositionSec = null;
        }
      }

      const previous = await this.readActiveManifest();
      const restored: BackgroundManifest = {
        schema: SCHEMA_ID,
        generation: previous.generation + 1,
        background: { ...parsed.background },
        updatedAt: nowIso(),
      };

      const stagingDir = await this.#createStagingDir();
      try {
      await this.#writeJsonAtomic(
        path.join(stagingDir, MANIFEST_NAME),
        restored,
      );
      await copyFileAtomic(
        path.join(dir, restored.background!.image),
        path.join(stagingDir, restored.background!.image),
      );
      if (restored.background!.video) {
        await copyFileAtomic(
          path.join(dir, restored.background!.video),
          path.join(stagingDir, restored.background!.video),
        );
      }
      await this.#validateTree(stagingDir, restored);
      await this.#promoteStagingToActive(stagingDir);
      const manifest = await this.readActiveManifest();
      return { manifest, videoPositionSec };
      } finally {
        await rmrf(stagingDir);
      }
    });
  }

  /**
   * Resolve a saved theme directory by folder name (preferred) or legacy meta.id.
   */
  async #resolveSavedThemeDir(themeId: string): Promise<string | null> {
    const direct = path.join(this.paths.savedDir, themeId);
    if (isPathInsideRoot(this.paths.savedDir, direct)) {
      try {
        await this.#assertSafeSavedThemeDir(direct);
        await fs.access(path.join(direct, MANIFEST_NAME));
        return direct;
      } catch {
        /* fall through to meta.id scan */
      }
    }
    // Legacy: meta.id may differ from directory name (encoding / old slugger).
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.paths.savedDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const dir = path.join(this.paths.savedDir, entry);
      if (!isPathInsideRoot(this.paths.savedDir, dir)) continue;
      try {
        await this.#assertSafeSavedThemeDir(dir);
        const metaRaw = await fs.readFile(path.join(dir, SAVED_META_NAME), "utf8");
        const meta = JSON.parse(metaRaw) as SavedThemeMeta;
        if (meta && typeof meta.id === "string" && meta.id === themeId) {
          await fs.access(path.join(dir, MANIFEST_NAME));
          return dir;
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }

  async #assertSafeSavedThemeDir(dir: string): Promise<void> {
    if (!isPathInsideRoot(this.paths.savedDir, dir)) {
      throw new MediaValidationError("Saved theme path escaped saved root.");
    }
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new MediaValidationError("Saved theme directory cannot be a link.");
    }
    const [realRoot, realDir] = await Promise.all([
      fs.realpath(this.paths.savedDir),
      fs.realpath(dir),
    ]);
    if (!isPathInsideRoot(realRoot, realDir)) {
      throw new MediaValidationError("Saved theme real path escaped saved root.");
    }
  }

  #bundledThemeSpec(themeId: string): BundledThemeSpec | null {
    return this.bundledThemes.find((spec) => spec.id === themeId) ?? null;
  }

  #isBundledThemeId(themeId: string): boolean {
    return (
      themeId === BUNDLED_GALLERY_THEME_ID ||
      this.#bundledThemeSpec(themeId) != null
    );
  }

  async #bundledThemeInfos(): Promise<SavedThemeInfo[]> {
    const out: SavedThemeInfo[] = [];
    for (const spec of this.bundledThemes) {
      try {
        const st = await fs.stat(spec.imagePath);
        if (!st.isFile() || st.size <= 0) continue;
        out.push({
          id: spec.id,
          name: spec.name,
          type: "image",
          path: spec.imagePath,
          savedAt: "",
          bundled: true,
        });
      } catch {
        /* shipped asset missing in this checkout / install */
      }
    }
    return out;
  }

  async #savedThemeUsage(): Promise<{ count: number; bytes: number }> {
    const themes = await this.listSavedThemes();
    let count = 0;
    let bytes = 0;
    for (const theme of themes) {
      if (theme.bundled || this.#isBundledThemeId(theme.id)) continue;
      count += 1;
      try {
        await this.#assertSafeSavedThemeDir(theme.path);
        const raw = await fs.readFile(
          path.join(theme.path, MANIFEST_NAME),
          "utf8",
        );
        const manifest = JSON.parse(raw) as BackgroundManifest;
        if (!isManifest(manifest) || !manifest.background) continue;
        bytes += (await fs.stat(
          path.join(theme.path, manifest.background.image),
        )).size;
        if (manifest.background.video) {
          bytes += (await fs.stat(
            path.join(theme.path, manifest.background.video),
          )).size;
        }
      } catch {
        /* broken entries do not count as valid themes */
      }
    }
    return { count, bytes };
  }
}

export interface SavedThemeMeta {
  id: string;
  name: string;
  type: "image" | "video";
  savedAt: string;
  /** Last known playback position in seconds (video themes only). */
  videoPositionSec?: number;
  /** ISO timestamp of the last videoPositionSec write. */
  videoPositionUpdatedAt?: string;
}

export interface SavedThemeInfo {
  id: string;
  name: string;
  type: "image" | "video";
  path: string;
  savedAt: string;
  /** Last known playback position in seconds (video themes only). */
  videoPositionSec?: number;
  /** Plugin-shipped theme that cannot be deleted. */
  bundled?: boolean;
}

/** Normalize a playback position for theme meta. Invalid → null (caller treats as 0). */
export function normalizeVideoPositionSec(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // Cap absurd values so a corrupt meta cannot force huge seeks.
  if (n > 24 * 60 * 60) return null;
  // Millisecond-ish precision is enough for resume.
  return Math.round(n * 1000) / 1000;
}

/**
 * Stable ASCII folder id. Display name stays Unicode in theme.json;
 * Chinese (and other non-ASCII) must NOT appear in the id — useSavedTheme
 * and Windows path tooling previously rejected those with "Invalid theme id".
 */
function slugThemeId(_name: string): string {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomUUID().replaceAll("-", "");
  return `theme-${stamp}-${rand}`.slice(0, 80);
}

function normalizeBundledThemes(value: unknown): BundledThemeSpec[] {
  if (!Array.isArray(value)) return [];
  const out: BundledThemeSpec[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<BundledThemeSpec>;
    const id = String(raw.id ?? "").trim();
    const name = String(raw.name ?? "").trim();
    const imagePath = String(raw.imagePath ?? "").trim();
    if (!isSafeThemeId(id) || seen.has(id) || !name || name.length > 80 || !imagePath) {
      continue;
    }
    seen.add(id);
    const spec: BundledThemeSpec = { id, name, imagePath };
    const effects = normalizeBackgroundEffects(raw.effects);
    if (effects) spec.effects = effects;
    out.push(spec);
  }
  return out;
}

/** Path-segment safe theme id (no traversal). Allows legacy non-ASCII dirs. */
function isSafeThemeId(id: string): boolean {
  if (!id || id.length > 120) return false;
  if (id === "." || id === ".." || id.includes("\0")) return false;
  if (id.includes("/") || id.includes("\\")) return false;
  // Windows reserved device names
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) return false;
  return true;
}

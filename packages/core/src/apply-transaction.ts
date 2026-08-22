import fs from "node:fs/promises";
import path from "node:path";
import {
  BackgroundStore,
  type BackgroundSnapshot,
} from "./background-store.js";
import { MAX_INLINE_DATA_URL_BYTES } from "./constants.js";
import {
  MediaServerController,
  type MediaAssetHandle,
} from "./media-server.js";
import {
  isLocalBackgroundSource,
  resolveBackgroundImagePath,
  resolveBackgroundVideoPath,
} from "./media-source.js";
import { detectImageMime } from "./media-validation.js";
import type {
  ApplyInput,
  ApplyResult,
  AppliedSourceMode,
  ApplyTimings,
  BackgroundManifest,
  HostApplier,
  HostApplyPayload,
} from "./types.js";

export interface ApplyTransactionOptions {
  store: BackgroundStore;
  media: MediaServerController;
  host?: HostApplier | null;
  /** DSH uses the authenticated loopback image URL and does not need a data URL. */
  includeImageDataUrl?: boolean;
  /** Background-only CSS text injected with every apply. */
  cssText?: string;
  verifyDeadlineMs?: number;
  /** When true, skip host apply/verify (unit tests / offline stage). */
  offline?: boolean;
}

/**
 * Minimal baseline only — live Codex path injects packages/adapter-codex
 * renderer/background.css (full-window main-surface transparency).
 * Keep this minimal so offline unit tests still paint a stage.
 */
const DEFAULT_CSS = `/* beautiCode background stage baseline */
#beauticode-bg-stage{
  position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:transparent!important;
}
#beauticode-bg-stage::before{
  content:"";position:absolute;inset:0;z-index:3;pointer-events:none;background:transparent;
}
#beauticode-bg-stage img,#beauticode-bg-stage video{
  position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;
}
#beauticode-bg-stage img{z-index:1;}
#beauticode-bg-stage video{z-index:2;opacity:0;}
html[data-bc-active="true"][data-bc-media="video"][data-bc-video-ready="true"] #beauticode-bg-stage video{opacity:1;}
html[data-bc-active="true"][data-bc-media="video"][data-bc-video-ready="true"] #beauticode-bg-stage img{display:none!important;}
html[data-bc-active="true"][data-bc-media="video-pending"] #beauticode-bg-stage img{opacity:1;display:block;}
`;

export interface StagedMediaPair {
  image: MediaAssetHandle | null;
  video: MediaAssetHandle | null;
}

export interface ApplyTransactionHooks {
  /**
   * Runs after the renderer has acknowledged the new background and the media
   * handles have been promoted, but before the rollback snapshot is cleared.
   * Throwing keeps the whole apply recoverable.
   */
  beforeFinalize?: (manifest: BackgroundManifest) => Promise<void>;
  /** Best-effort cleanup for state created by beforeFinalize. */
  onRollback?: () => Promise<void>;
}

/**
 * Orchestrates snapshot → disk commit → media stage → host apply → verify →
 * finalize/rollback. Disk success is never treated as user-visible success when
 * a host applier is configured.
 *
 * Codex Desktop CSP blocks connect-src/img-src/media-src to http://127.0.0.1,
 * so live inject embeds media as data: URLs (CSP allows data: and blob:).
 * Loopback media hub remains staged for diagnostics / non-Codex hosts.
 */
export class ApplyTransaction {
  readonly store: BackgroundStore;
  readonly media: MediaServerController;
  readonly host: HostApplier | null;
  readonly cssText: string;
  readonly verifyDeadlineMs: number;
  readonly offline: boolean;
  readonly includeImageDataUrl: boolean;
  #busy = false;

  constructor(opts: ApplyTransactionOptions) {
    this.store = opts.store;
    this.media = opts.media;
    this.host = opts.host ?? null;
    this.cssText = opts.cssText ?? DEFAULT_CSS;
    this.verifyDeadlineMs = opts.verifyDeadlineMs ?? 30_000;
    this.offline = opts.offline ?? false;
    this.includeImageDataUrl = opts.includeImageDataUrl ?? true;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async run(
    input: ApplyInput,
    hooks: ApplyTransactionHooks = {},
  ): Promise<ApplyResult> {
    if (this.#busy) {
      return {
        ok: false,
        error: "Another background apply is already in progress.",
        rolledBack: false,
      };
    }
    this.#busy = true;
    try {
      return await this.store.withExclusiveMutation(() =>
        this.#runExclusive(input, hooks),
      );
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rolledBack: false,
      };
    } finally {
      this.#busy = false;
    }
  }

  async #runExclusive(
    input: ApplyInput,
    hooks: ApplyTransactionHooks,
  ): Promise<ApplyResult> {
    const startedAt = performance.now();
    const phases: Record<string, number> = {};
    const measure = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const phaseStartedAt = performance.now();
      try {
        return await work();
      } finally {
        phases[name] = Math.round((performance.now() - phaseStartedAt) * 10) / 10;
      }
    };
    const requestedSourceMode: AppliedSourceMode =
      input.type === "clear" ? "clear" : input.source ?? "managed";
    const timings = (): ApplyTimings => ({
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      phases: { ...phases },
    });
    let snapshot: BackgroundSnapshot | null = null;
    let staged: StagedMediaPair | null = null;
    let runtimeVideoPath: string | null = null;
    let finalizeStarted = false;
    try {
      await measure("initialize", () => this.store.init());
      snapshot = await measure("snapshot", () => this.store.snapshot());

      const manifest = await measure("commitImport", () => this.store.commitImport(input));
      const sourceMode: AppliedSourceMode = !manifest.background
        ? "clear"
        : isLocalBackgroundSource(manifest.background)
          ? "local"
          : "managed";
      if (requestedSourceMode === "local" && sourceMode !== "local") {
        throw new Error("Local import contract was not preserved by the media store.");
      }
      staged = await measure("stageMedia", () => this.#stageMediaFor(manifest));

      if (!this.offline && this.host) {
        const payload = await measure("buildPayload", () =>
          this.#buildPayload(
            manifest,
            staged,
            input.type === "video" ? input.startAt : undefined,
          ),
        );
        runtimeVideoPath = payload.video?.localPath ?? null;
        await measure("hostApply", () => this.host!.apply(payload));
        const verify = await measure("rendererVerify", () =>
          this.host!.verify(
            {
              generation: manifest.generation,
              media: manifest.background?.type ?? "clear",
            },
            { deadlineMs: this.verifyDeadlineMs },
          ),
        );
        if (verify.status !== "pass") {
          await measure("rollback", () => this.#rollback(snapshot!, staged));
          staged = null;
          snapshot = null;
          return {
            ok: false,
            error: `Live verify did not pass (${verify.status}): ${verify.reason}`,
            rolledBack: true,
            sourceMode,
            timings: timings(),
          };
        }
      }

      await measure("mediaCommit", () => this.media.commit(staged!));
      await measure("pruneRuntimeMedia", () => this.store.pruneRuntimeMedia(runtimeVideoPath));
      staged = null;
      if (hooks.beforeFinalize) {
        finalizeStarted = true;
        await measure("saveTheme", () => hooks.beforeFinalize!(manifest));
      }
      if (snapshot) {
        await measure("clearSnapshot", () => this.store.clearSnapshot(snapshot!));
        snapshot = null;
      }
      return {
        ok: true,
        generation: manifest.generation,
        mode: manifest.background?.type ?? "clear",
        sourceMode,
        timings: timings(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let rolledBack = false;
      if (snapshot) {
        try {
          await measure("rollback", () => this.#rollback(snapshot!, staged));
          staged = null;
          snapshot = null;
          rolledBack = true;
        } catch {
          await this.#abortPair(staged);
          staged = null;
        }
      } else {
        await this.#abortPair(staged);
        staged = null;
      }
      if (finalizeStarted && hooks.onRollback) {
        await measure("finalizeRollback", () => hooks.onRollback!()).catch(() => {});
      }
      return {
        ok: false,
        error: message,
        rolledBack,
        sourceMode: requestedSourceMode,
        timings: timings(),
      };
    }
  }

  async #stageMediaFor(manifest: BackgroundManifest): Promise<StagedMediaPair> {
    if (!manifest.background) {
      return { image: null, video: null };
    }

    const imagePath = resolveBackgroundImagePath(
      this.store.paths.activeDir,
      manifest.background,
    );
    if (!imagePath) throw new Error("Background has no image source.");
    const image = await this.media.stage(imagePath, {
      validation:
        manifest.background.type === "image" && isLocalBackgroundSource(manifest.background)
          ? "fast"
          : "full",
    });
    let video: MediaAssetHandle | null = null;
    if (manifest.background.type === "video") {
      // DSH streams this handle for the lifetime of the active <video>. On
      // Windows, serving active/background.mp4 directly keeps the active
      // directory open and the next atomic directory swap fails with EPERM.
      const runtimeVideoPath = await this.store.prepareRuntimeVideo(manifest);
      if (!runtimeVideoPath) {
        throw new Error("Video media staging requires a detached runtime copy.");
      }
      video = await this.media.stage(runtimeVideoPath, {
        validation: isLocalBackgroundSource(manifest.background) ? "fast" : "full",
      });
    }
    return { image, video };
  }

  async #buildPayload(
    manifest: BackgroundManifest,
    staged: StagedMediaPair | null,
    videoStartAt?: number,
  ): Promise<HostApplyPayload> {
    return buildHostApplyPayload(
      this.store,
      manifest,
      staged,
      this.cssText,
      videoStartAt,
      { includeImageDataUrl: this.includeImageDataUrl },
    );
  }

  async #abortPair(staged: StagedMediaPair | null): Promise<void> {
    if (!staged) return;
    await this.media.abort(staged.video);
    await this.media.abort(staged.image);
  }

  async #rollback(
    snapshot: BackgroundSnapshot,
    staged: StagedMediaPair | null,
  ): Promise<void> {
    await this.#abortPair(staged);
    const restored = await this.store.restoreSnapshot(snapshot);
    let restoredMedia: StagedMediaPair | null = null;
    try {
      restoredMedia = await this.#stageMediaFor(restored);
      let runtimeVideoPath: string | null = null;
      if (!this.offline && this.host) {
        const payload = await this.#buildPayload(restored, restoredMedia);
        runtimeVideoPath = payload.video?.localPath ?? null;
        try {
          await this.host.apply(payload);
          await this.host.verify(
            {
              generation: restored.generation,
              media: restored.background?.type ?? "clear",
            },
            { deadlineMs: Math.min(this.verifyDeadlineMs, 5_000) },
          );
        } catch {
          // Disk rollback is authoritative. A stopped/restarting host will be
          // healed from active on its next watch connection.
        }
      }
      await this.media.commit(restoredMedia);
      await this.store.pruneRuntimeMedia(runtimeVideoPath);
      restoredMedia = null;
      await this.store.clearSnapshot(snapshot);
    } finally {
      await this.#abortPair(restoredMedia);
    }
  }
}

export async function buildHostApplyPayload(
  store: BackgroundStore,
  manifest: BackgroundManifest,
  staged: StagedMediaPair | null,
  cssText: string,
  videoStartAt?: number,
  opts: { includeImageDataUrl?: boolean } = {},
): Promise<HostApplyPayload> {
  if (!manifest.background) {
    return {
      generation: manifest.generation,
      media: "clear",
      imageDataUrl: null,
      imageUrl: null,
      video: null,
      cssText,
    };
  }

  const imagePath = resolveBackgroundImagePath(
    store.paths.activeDir,
    manifest.background,
  );
  if (!imagePath) throw new Error("Background has no image source.");
  const imageDataUrl =
    opts.includeImageDataUrl === false ? null : await fileToDataUrl(imagePath);
  const imageUrl = staged?.image?.srcUrl ?? null;
  if (manifest.background.type === "image") {
    return {
      generation: manifest.generation,
      media: "image",
      imageDataUrl,
      imageUrl,
      video: null,
      cssText,
      atmosphere: manifest.background.effects ?? null,
    };
  }
  const videoPath = resolveBackgroundVideoPath(
    store.paths.activeDir,
    manifest.background,
  );
  if (!videoPath) throw new Error("Video background has no video source.");
  const runtimeVideoPath = await store.prepareRuntimeVideo(manifest);
  if (!runtimeVideoPath) {
    throw new Error("Video payload requires a detached runtime copy.");
  }
  const videoStat = await fs.stat(videoPath);
  const videoHandle = staged?.video;
  const video: NonNullable<HostApplyPayload["video"]> = {
    mode: "blob",
    localPath: runtimeVideoPath,
  };
  if (videoHandle?.url) video.url = videoHandle.url;
  if (videoHandle?.srcUrl) video.srcUrl = videoHandle.srcUrl;
  if (videoHandle?.token) video.token = videoHandle.token;
  if (
    typeof videoStartAt === "number" &&
    Number.isFinite(videoStartAt) &&
    videoStartAt > 0 &&
    videoStartAt <= 24 * 60 * 60
  ) {
    video.startAt = videoStartAt;
  }
  if (videoStat.size <= 256 * 1024) {
    video.dataUrl = await fileToDataUrl(videoPath, "video/mp4");
  }
  return {
    generation: manifest.generation,
    media: "video",
    imageDataUrl,
    imageUrl,
    video,
    cssText,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
};

/** Embed a local media file as a CSP-safe data: URL for host inject. */
export async function fileToDataUrl(
  filePath: string,
  mimeOverride?: string,
): Promise<string> {
  const bytes = await fs.readFile(filePath);
  if (bytes.byteLength > MAX_INLINE_DATA_URL_BYTES) {
    throw new Error(
      `Media file too large to embed as data URL (${bytes.byteLength} > ${MAX_INLINE_DATA_URL_BYTES}).`,
    );
  }
  const ext = path.extname(filePath).toLowerCase();
  const detectedImage =
    !mimeOverride && ext !== ".mp4"
      ? detectImageMime(bytes.subarray(0, 64), ext, bytes.byteLength)
      : null;
  const mime = mimeOverride ?? detectedImage?.mime ?? MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`Unsupported media extension for data URL: ${ext || "(none)"}`);
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

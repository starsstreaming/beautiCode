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
import { detectImageMime } from "./media-validation.js";
import type {
  ApplyInput,
  ApplyResult,
  BackgroundManifest,
  HostApplier,
  HostApplyPayload,
} from "./types.js";

export interface ApplyTransactionOptions {
  store: BackgroundStore;
  media: MediaServerController;
  host?: HostApplier | null;
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
  content:"";position:absolute;inset:0;z-index:3;pointer-events:none;background:rgba(0,0,0,.22);
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
  #busy = false;

  constructor(opts: ApplyTransactionOptions) {
    this.store = opts.store;
    this.media = opts.media;
    this.host = opts.host ?? null;
    this.cssText = opts.cssText ?? DEFAULT_CSS;
    this.verifyDeadlineMs = opts.verifyDeadlineMs ?? 30_000;
    this.offline = opts.offline ?? false;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async run(input: ApplyInput): Promise<ApplyResult> {
    if (this.#busy) {
      return {
        ok: false,
        error: "Another background apply is already in progress.",
        rolledBack: false,
      };
    }
    this.#busy = true;
    try {
      return await this.store.withExclusiveMutation(() => this.#runExclusive(input));
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

  async #runExclusive(input: ApplyInput): Promise<ApplyResult> {
    let snapshot: BackgroundSnapshot | null = null;
    let staged: StagedMediaPair | null = null;
    let runtimeVideoPath: string | null = null;
    try {
      await this.store.init();
      snapshot = await this.store.snapshot();

      const manifest = await this.store.commitImport(input);
      staged = await this.#stageMediaFor(manifest);

      if (!this.offline && this.host) {
        const payload = await this.#buildPayload(
          manifest,
          staged,
          input.type === "video" ? input.startAt : undefined,
        );
        runtimeVideoPath = payload.video?.localPath ?? null;
        await this.host.apply(payload);
        const verify = await this.host.verify(
          {
            generation: manifest.generation,
            media: manifest.background?.type ?? "clear",
          },
          { deadlineMs: this.verifyDeadlineMs },
        );
        if (verify.status !== "pass") {
          await this.#rollback(snapshot, staged);
          staged = null;
          snapshot = null;
          return {
            ok: false,
            error: `Live verify did not pass (${verify.status}): ${verify.reason}`,
            rolledBack: true,
          };
        }
      }

      await this.media.commit(staged);
      await this.store.pruneRuntimeMedia(runtimeVideoPath);
      staged = null;
      if (snapshot) {
        await this.store.clearSnapshot(snapshot);
        snapshot = null;
      }
      return {
        ok: true,
        generation: manifest.generation,
        mode: manifest.background?.type ?? "clear",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let rolledBack = false;
      if (snapshot) {
        try {
          await this.#rollback(snapshot, staged);
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
      return { ok: false, error: message, rolledBack };
    }
  }

  async #stageMediaFor(manifest: BackgroundManifest): Promise<StagedMediaPair> {
    if (!manifest.background) {
      return { image: null, video: null };
    }

    const imagePath = path.join(
      this.store.paths.activeDir,
      manifest.background.image,
    );
    const image = await this.media.stage(imagePath);
    let video: MediaAssetHandle | null = null;
    if (manifest.background.type === "video" && manifest.background.video) {
      const videoPath = path.join(
        this.store.paths.activeDir,
        manifest.background.video,
      );
      video = await this.media.stage(videoPath);
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

  const imagePath = path.join(
    store.paths.activeDir,
    manifest.background.image,
  );
  const imageDataUrl = await fileToDataUrl(imagePath);
  const imageUrl = staged?.image?.srcUrl ?? null;
  if (manifest.background.type === "image") {
    return {
      generation: manifest.generation,
      media: "image",
      imageDataUrl,
      imageUrl,
      video: null,
      cssText,
    };
  }
  if (!manifest.background.video) {
    throw new Error("Video background is missing a video basename.");
  }

  const videoPath = path.join(
    store.paths.activeDir,
    manifest.background.video,
  );
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

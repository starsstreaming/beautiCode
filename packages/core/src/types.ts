import { SCHEMA_ID } from "./constants.js";

export type BackgroundType = "image" | "video" | "clear";
export type BackgroundTone = "dark" | "light" | "auto";
export type HostKind = "codex" | "dsh";
export type MediaImportMode = "managed" | "local";
export type AppliedSourceMode = MediaImportMode | "clear";

export interface ApplyTimings {
  totalMs: number;
  phases: Record<string, number>;
}

export type MediaSource =
  | { kind: "managed"; file: string }
  | { kind: "local"; path: string };

export interface HostCapabilities {
  image: boolean;
  clear: boolean;
  reapply: boolean;
  savedThemes: boolean;
  video: boolean;
  fish: boolean;
  muted: boolean;
  tone: boolean;
}

/** Stable metadata used by the control plane instead of host-specific guesses. */
export interface HostDescriptor {
  kind: HostKind;
  displayName: string;
  capabilities: HostCapabilities;
}

export type AtmospherePreset = "internal" | "infernal" | "gallery";

export interface BackgroundEffects {
  preset: AtmospherePreset;
  rain: true;
  overlay: true;
  water: true;
}

export function normalizeBackgroundEffects(
  value: unknown,
): BackgroundEffects | null {
  if (!value || typeof value !== "object") return null;
  const preset = (value as { preset?: unknown }).preset;
  if (
    preset !== "internal" &&
    preset !== "infernal" &&
    preset !== "gallery"
  ) {
    return null;
  }
  return { preset, rain: true, overlay: true, water: true };
}

export function effectsForPreset(preset: AtmospherePreset): BackgroundEffects {
  return { preset, rain: true, overlay: true, water: true };
}

export interface BackgroundMedia {
  type: "image" | "video";
  /** Managed poster basename; required for video backgrounds. */
  image?: string;
  /** Legacy managed primary basename; required for managed videos. */
  video?: string;
  /** Primary source. Omitted means the legacy managed image/video fields apply. */
  source?: MediaSource;
  /** Optional live wallpaper (rain / overlay / water). Image themes only. */
  effects?: BackgroundEffects;
}

export interface BackgroundManifest {
  schema: typeof SCHEMA_ID;
  generation: number;
  background: BackgroundMedia | null;
  updatedAt: string;
}

export interface ValidatedImage {
  kind: "image";
  filePath: string;
  size: number;
  extension: string;
  mime: string;
  identity: string;
  device: number;
  inode: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ValidatedVideo {
  kind: "video";
  filePath: string;
  size: number;
  identity: string;
  device: number;
  inode: number;
  mtimeMs: number;
  ctimeMs: number;
}

export type ApplyInput =
  | {
      type: "image";
      imagePath: string;
      /** local avoids browser/upload and active-media copies; managed is legacy behavior. */
      source?: MediaImportMode;
      effects?: BackgroundEffects;
    }
  | {
      type: "video";
      /** Optional poster. When omitted, active poster is reused or a tiny PNG is staged. */
      imagePath?: string;
      videoPath: string;
      /** local references the source; managed copies it into the media store. */
      source?: MediaImportMode;
      /** Optional initial seek used by transactional saved-theme restore. */
      startAt?: number;
    }
  | { type: "clear" };

export type VerifyStatus = "pass" | "fail" | "inconclusive";

export interface VerifyExpectation {
  generation: number;
  media: BackgroundType;
}

export interface VerifyResult {
  status: VerifyStatus;
  reason: string;
  details?: Record<string, unknown>;
}

export interface HostApplier {
  apply(payload: HostApplyPayload): Promise<void>;
  /** Optional to keep custom/older host implementations source-compatible. */
  setBackgroundTone?(tone: BackgroundTone): Promise<{
    ok: boolean;
    tone: BackgroundTone;
    sessions: number;
    error?: string;
  }>;
  verify(
    expected: VerifyExpectation,
    opts: { deadlineMs: number },
  ): Promise<VerifyResult>;
}

export interface HostApplyPayload {
  generation: number;
  media: BackgroundType;
  /**
   * Primary image source for Codex: CSP allows data:/blob: only
   * (img-src has no http://127.0.0.1). Always prefer a real data URL live.
   */
  imageDataUrl: string | null;
  /**
   * Optional loopback http URL. Blocked by Codex CSP; kept for non-Codex
   * hosts / tests that allow connect-src to loopback.
   */
  imageUrl?: string | null;
  video: null | {
    /**
     * data = inline data URL (small files / tests)
     * blob = CDP DOM.setFileInputFiles → page File → blob: URL (Codex Desktop primary)
     * server = loopback fetch (non-Codex hosts; needs CSP allow)
     */
    mode: "data" | "server" | "blob";
    /** data:video/mp4;base64,... — small files / offline tests. */
    dataUrl?: string;
    /** Base media URL (no query). */
    url?: string;
    /** Prefer for <video src> — includes ?t= token. */
    srcUrl?: string;
    token?: string;
    /**
     * Host-only absolute path for CDP setFileInputFiles.
     * Stripped before Runtime.evaluate — never sent into the page.
     */
    localPath?: string;
    /**
     * Optional initial seek (seconds) for saved-theme restore.
     * Applied once when the video has metadata. Invalid / past end → 0.
     */
    startAt?: number;
  };
  cssText: string;
  /** Live wallpaper layers for Internal / Infernal presets. */
  atmosphere?: BackgroundEffects | null;
}

export type ApplyResult =
  | {
      ok: true;
      generation: number;
      mode: BackgroundType;
      /** Truthful source contract for UI/API callers. */
      sourceMode?: AppliedSourceMode;
      /** Monotonic phase durations collected by ApplyTransaction. */
      timings?: ApplyTimings;
    }
  | {
      ok: false;
      error: string;
      rolledBack: boolean;
      sourceMode?: AppliedSourceMode;
      timings?: ApplyTimings;
    };

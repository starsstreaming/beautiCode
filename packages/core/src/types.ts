import { SCHEMA_ID } from "./constants.js";

export type BackgroundType = "image" | "video" | "clear";
export type BackgroundTone = "dark" | "light" | "auto";

export interface BackgroundMedia {
  type: "image" | "video";
  /** Basename only, inside the active/staging directory. */
  image: string;
  /** Basename only; required when type === "video". */
  video?: string;
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
  | { type: "image"; imagePath: string }
  | {
      type: "video";
      /** Optional poster. When omitted, active poster is reused or a tiny PNG is staged. */
      imagePath?: string;
      videoPath: string;
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
}

export type ApplyResult =
  | {
      ok: true;
      generation: number;
      mode: BackgroundType;
    }
  | {
      ok: false;
      error: string;
      rolledBack: boolean;
    };

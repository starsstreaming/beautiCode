import path from "node:path";
import type { BackgroundMedia, MediaSource } from "./types.js";

/** Resolve a manifest source against the directory that owns managed files. */
export function resolveMediaSource(source: MediaSource, ownerDir: string): string {
  if (source.kind === "local") return path.resolve(source.path);
  return path.join(ownerDir, source.file);
}

/** Resolve the primary image source, including legacy v1 manifests. */
export function resolveBackgroundImagePath(
  ownerDir: string,
  background: BackgroundMedia,
): string | null {
  if (background.type === "image" && background.source) {
    return resolveMediaSource(background.source, ownerDir);
  }
  return background.image ? path.join(ownerDir, background.image) : null;
}

/** Resolve the primary video source, including legacy v1 manifests. */
export function resolveBackgroundVideoPath(
  ownerDir: string,
  background: BackgroundMedia,
): string | null {
  if (background.type !== "video") return null;
  if (background.source) return resolveMediaSource(background.source, ownerDir);
  return background.video ? path.join(ownerDir, background.video) : null;
}

export function isLocalBackgroundSource(background: BackgroundMedia): boolean {
  return background.source?.kind === "local";
}

/** Return the managed primary filename when a snapshot/theme must copy it. */
export function managedPrimaryFile(background: BackgroundMedia): string | null {
  if (background.source?.kind === "managed") return background.source.file;
  if (background.source?.kind === "local") return null;
  return background.type === "image"
    ? background.image ?? null
    : background.video ?? null;
}

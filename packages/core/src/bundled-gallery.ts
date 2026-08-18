import fs from "node:fs";
import path from "node:path";
import { effectsForPreset, type BackgroundEffects } from "./types.js";

export const BUNDLED_GALLERY_THEME_ID = "builtin-gallery";
export const BUNDLED_GALLERY_THEME_NAME = "画窗";

const GALLERY_FILES = ["bg-canvas-4k.png", "bg-canvas.png"] as const;

export interface BundledThemeSpec {
  id: string;
  name: string;
  imagePath: string;
  effects?: BackgroundEffects | null;
}

export function isBundledThemeId(id: string): boolean {
  return id === BUNDLED_GALLERY_THEME_ID;
}

export function bundledGalleryThemeSpec(imagePath: string): BundledThemeSpec {
  return {
    id: BUNDLED_GALLERY_THEME_ID,
    name: BUNDLED_GALLERY_THEME_NAME,
    imagePath,
    effects: effectsForPreset("gallery"),
  };
}

/** Locate the shipped 画窗 still. Prefer an explicit 4K file when present. */
export function resolveBundledGalleryImagePath(
  searchRoots: Iterable<string> = [],
): string | null {
  const env = process.env.BEAUTICODE_GALLERY_IMAGE?.trim();
  const candidates: string[] = [];
  if (env) candidates.push(env);
  for (const root of searchRoots) {
    if (!root) continue;
    const resolved = path.resolve(root);
    for (const file of GALLERY_FILES) {
      candidates.push(path.join(resolved, file));
      candidates.push(path.join(resolved, "themes", "internal-beyond", file));
      candidates.push(
        path.join(resolved, "assets", "themes", "internal-beyond", file),
      );
    }
  }
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return filePath;
      }
    } catch {
      /* skip unreadable candidates */
    }
  }
  return null;
}

export function resolveSessionBundledThemes(opts: {
  enabled?: boolean | undefined;
  imagePath?: string | null | undefined;
  searchRoots?: Iterable<string>;
} = {}): BundledThemeSpec[] {
  if (opts.enabled === false) return [];
  const explicit = opts.imagePath?.trim();
  const imagePath =
    explicit || resolveBundledGalleryImagePath(opts.searchRoots ?? []);
  return imagePath ? [bundledGalleryThemeSpec(imagePath)] : [];
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ATMOSPHERE_PRESETS = Object.freeze({
  internal: Object.freeze({
    id: "internal",
    name: "Internal",
    file: "bg-internal.jpg",
    tone: "light",
  }),
  infernal: Object.freeze({
    id: "infernal",
    name: "Infernal",
    file: "bg-infernal.jpg",
    tone: "dark",
  }),
});

export function normalizeAtmosphere(value) {
  if (!value || typeof value !== "object") return null;
  if (
    value.preset !== "internal" &&
    value.preset !== "infernal" &&
    value.preset !== "gallery"
  ) {
    return null;
  }
  return { preset: value.preset, rain: true, overlay: true, water: true };
}

export function effectsForPreset(id) {
  return normalizeAtmosphere({ preset: id });
}

export function themeAssetsDir() {
  const candidates = [
    path.join(here, "themes", "internal-beyond"),
    path.join(here, "..", "..", "assets", "themes", "internal-beyond"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "bg-internal.jpg"))) return dir;
  }
  return candidates[candidates.length - 1];
}

export function presetImagePath(id) {
  const preset = ATMOSPHERE_PRESETS[id];
  if (!preset) return null;
  const filePath = path.join(themeAssetsDir(), preset.file);
  return fs.existsSync(filePath) ? filePath : null;
}

export function canvasImagePath() {
  const dir = themeAssetsDir();
  const hi = path.join(dir, "bg-canvas-4k.png");
  if (fs.existsSync(hi)) return hi;
  const filePath = path.join(dir, "bg-canvas.png");
  return fs.existsSync(filePath) ? filePath : null;
}

export function iceFrostImagePath() {
  const filePath = path.join(themeAssetsDir(), "ice-frost.png");
  return fs.existsSync(filePath) ? filePath : null;
}

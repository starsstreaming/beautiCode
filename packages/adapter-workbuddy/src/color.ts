/**
 * Colour parsing helpers.
 *
 * Needed because `color-mix()` computes to the `color(srgb r g b / a)` form,
 * NOT `rgba()` — verified on WorkBuddy 5.5.6 / Chromium 138. Any code that reads
 * alpha (our verify, our sweeps, our diagnostics) must understand both shapes,
 * otherwise translucent layers look "unparseable".
 */

const RGB_RE = /^rgba?\(([^)]+)\)$/;
const COLOR_FN_RE = /^color\(\s*srgb\s+[\d.]+\s+[\d.]+\s+[\d.]+\s*(?:\/\s*([\d.]+))?\s*\)$/;
const HEX_RE = /^#[0-9a-f]{3,8}$/i;

/** Alpha of a CSS colour string, or null when it cannot be determined. */
export function parseColorAlpha(value: string | null | undefined): number | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (v === "") return null;
  if (v === "transparent") return 0;

  const rgb = RGB_RE.exec(v);
  if (rgb) {
    const captured = rgb[1];
    if (!captured) return null;
    const parts = captured.split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return parts.length > 3 ? parts[3]! : 1;
  }

  const fn = COLOR_FN_RE.exec(v);
  if (fn) return fn[1] === undefined ? 1 : Number(fn[1]);

  if (HEX_RE.test(v)) return 1;
  if (v.startsWith("hsl(") || v.startsWith("hsla(")) return 1;

  // var(...) and anything else: unknown
  return null;
}

/** Convenience: is this colour effectively opaque? */
export function isOpaqueColor(value: string | null | undefined): boolean {
  const alpha = parseColorAlpha(value);
  return alpha !== null && alpha >= 0.95;
}

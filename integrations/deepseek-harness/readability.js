(() => {
  "use strict";
  if (globalThis.BeauticodeReadableSurfaces) return;

  const STORAGE_KEY = "beauticode-readable-surfaces";
  // 0 = protection off (the host's own translucent surfaces), 100 = the
  // original fully-opaque plate. Anything between paints the plate at that
  // alpha, so a user can trade occlusion against the wallpaper reading through
  // instead of flipping one boolean.
  const DEFAULT_STRENGTH = 100;
  const root = document.documentElement;

  function clampStrength(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  // Older builds stored a boolean. An explicit "false" must keep meaning "off";
  // "true" and missing/corrupt storage keep full protection.
  function readStrength() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (raw == null || raw === "" || raw === "true") return DEFAULT_STRENGTH;
      if (raw === "false") return 0;
      return clampStrength(raw) ?? DEFAULT_STRENGTH;
    } catch {
      return DEFAULT_STRENGTH;
    }
  }

  let strength = readStrength();

  function writeStrength(value) {
    try {
      // 0 keeps the old "false" spelling so rolling back to a previous plugin
      // version still reads the opt-out instead of re-enabling protection.
      const stored = value === 0 ? "false" : String(value);
      globalThis.localStorage?.setItem(STORAGE_KEY, stored);
    } catch {
      // Storage can be denied; the current page still honors the selection.
    }
  }

  function applyPreference() {
    const protectedOn = strength > 0;
    root.dataset.bcReadableSurfaces = protectedOn ? "true" : "false";
    if (protectedOn) root.style?.setProperty?.("--bc-readable-strength", String(strength));
    else root.style?.removeProperty?.("--bc-readable-strength");
    globalThis.dispatchEvent?.(new CustomEvent("beauticode-readability-change"));
  }

  const style = document.createElement("style");
  style.dataset.beauticodeReadability = "true";
  style.textContent = `
html[data-bc-active="true"] body{
  --bc-readable-fill:color-mix(in srgb,var(--dsw-static-neutral-bluish-800,#232833) calc(var(--bc-readable-strength,100) * 1%),transparent);
  --bc-text-halo:#000;
}
html[data-bc-active="true"][data-bc-resolved-tone="light"] body{
  --bc-readable-fill:color-mix(in srgb,var(--dsw-static-neutral-bluish-00,#fff) calc(var(--bc-readable-strength,100) * 1%),transparent);
  --bc-text-halo:#fff;
}
/* DSH settings are body portals; its sticky composer sits over the transcript.
   Protect the actual surface, rather than keying readability to a conversation
   phase or dim preference. Local aliases also beat gallery's body overrides.
   Semantic roles and data-composer-card are shipped DSH contracts, not hashes. */
html[data-bc-active="true"]:not([data-bc-readable-surfaces="false"]) :is(
  [role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],
  [role="tooltip"],[data-composer-card],
  /* DSH pending-interaction panels — user questions, plan review and approval —
     are NOT dialogs. Each is a transparent flex frame wrapping an inner card
     that paints var(--dsw-specific-input-major), the very token this bridge
     re-expresses as translucent, so the transcript bled through the question
     card. Target the inner card by the stable data-* key on its frame (the
     class names are CSS-module hashes and must not be relied on): painting the
     frame instead would produce a solid bar across its side padding. */
  [data-question-key] > section,
  [data-plan-review-key] > section,
  [data-approval-key] > div
){
  --dsw-alias-bg-base:var(--bc-readable-fill);
  --dsw-alias-bg-layer-1:var(--bc-readable-fill);
  --dsw-alias-bg-layer-2:var(--bc-readable-fill);
  --dsw-alias-bg-layer-3:var(--bc-readable-fill);
  --dsw-alias-bg-overlay:var(--bc-readable-fill);
  --dsw-specific-input-major:var(--bc-readable-fill);
  --dsw-specific-menu:var(--bc-readable-fill);
  --dsw-alias-tooltip-bg:var(--bc-readable-fill);
  background-color:var(--bc-readable-fill);
}
/* The plugin page is a page, not a panel: DSH lays it out full-bleed like the
   automation-tasks page, so it keeps the translucent surfaces client.js
   publishes (--bc-surface-mix, --dsw-alias-bg-base:rgba(17,20,27,.10), ...) and
   the wallpaper reads through. Painting it opaque turned every group and row
   into a slab - and, because a host row carries margin:0 -8px with radius-xl,
   the painted rows' 8px overhang showed up as rounded scallops of wallpaper.
   Leave host geometry, radii and surfaces alone. Keep only the two legibility
   aids: captions come up one tier, and a soft halo keeps 13px copy readable
   over a busy photo without covering the picture. */
html[data-bc-active="true"]:not([data-bc-readable-surfaces="false"]) [data-plugin-panel]{
  --dsw-alias-label-tertiary:var(--dsw-alias-label-secondary);
  --dsw-alias-label-caption:var(--dsw-alias-label-secondary);
  text-shadow:0 1px 2px color-mix(in srgb, var(--bc-text-halo) 45%, transparent);
}
`;
  document.head.append(style);
  applyPreference();

  globalThis.BeauticodeReadableSurfaces = {
    // 0-100. 0 turns protection off and restores the host's translucent
    // surfaces; 100 is the original opaque plate. Boolean values are accepted
    // for callers of the old switch.
    get: () => strength,
    set(value) {
      const next = typeof value === "boolean"
        ? (value ? DEFAULT_STRENGTH : 0)
        : clampStrength(value);
      if (next == null) return strength;
      strength = next;
      writeStrength(strength);
      applyPreference();
      return strength;
    },
  };
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    strength = readStrength();
    applyPreference();
  });
})();

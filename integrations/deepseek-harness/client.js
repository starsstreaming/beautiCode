(() => {
  "use strict";
  if (window.__beauticodeBridgeLoaded) return;
  window.__beauticodeBridgeLoaded = true;
  window.__beauticodeBridgeVersion = 4;

  const clientId =
    globalThis.crypto?.randomUUID?.() ||
    `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const desiredModes = { fish: false, muted: true, tone: "auto" };
  // The DSH host owns a hard 10-second verification boundary. Keep the browser
  // transaction inside it so failures remain phase-specific instead of turning
  // into a generic host timeout.
  const CLIENT_APPLY_DEADLINE_MS = 8_000;
  const IMAGE_LOAD_TIMEOUT_MS = CLIENT_APPLY_DEADLINE_MS;
  const IMAGE_ATTEMPT_TIMEOUT_MS = 3_000;
  const IMAGE_MAX_ATTEMPTS = 2;
  const VIDEO_STARTUP_TIMEOUT_MS = CLIENT_APPLY_DEADLINE_MS;
  const VIDEO_PROBE_TIMEOUT_MS = 2_000;
  // Phase-one playback acceptance window. A muted play() that is still pending
  // after this only means the decoder is warming; the settle phase owns it.
  const PLAY_ACCEPT_TIMEOUT_MS = 1_500;
  // Phase-two budget for the committed video to present its first frame. It is
  // deliberately far beyond any host deadline: a poster already committed, so
  // slow first frames upgrade in place instead of failing the transaction.
  const VIDEO_SETTLE_TIMEOUT_MS = 60_000;
  const DSH_STRUCTURE_TIMEOUT_MS = CLIENT_APPLY_DEADLINE_MS;
  const FRAME_FALLBACK_MS = 120;
  const VIDEO_FIRST_FRAME_PROGRESS_SEC = 0.03;
  const VIDEO_STABLE_FRAMES = 3;
  const VIDEO_STABLE_PROGRESS_SEC = 0.18;
  const CROSSFADE_MS = 180;
  // A 1486-byte H.264 black frame (faststart). Playing it once on init makes
  // Chromium build its media pipeline before the user's first real import.
  const WARMUP_VIDEO_DATA_URI = `data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMQbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAH0AAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjp0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAH0AAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB9AAAAAAABAAAAAAGybWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAR1zdGJsAAAAuXN0c2QAAAAAAAAAAQAAAKlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAN/+EAF2dCwA3ZBCbARAAAAwAEAAADAEA8UKkgAQAFaMuDyyAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAACjgAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAQAACAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAACjgAAAAEAAAAUc3RjbwAAAAAAAAABAAADQAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAyAAAACGZyZWUAAAKWbWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjMgMDQ4MGNiMCAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHl6ZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49OCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDBAIAAAAAWZYiEDvJigAC+/JycnXXXXXXXXXXXXg==`;
  let activePayload = null;
  let committedPayload = null;
  let renderPhase = "idle";
  let playbackBlocked = false;
  let currentSlot = null;
  let applyController = null;
  let videoSettleController = null;
  const systemDarkMedia = globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const reducedMotionMedia =
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  let themeSyncQueued = false;

  const style = document.createElement("style");
  style.dataset.beauticodeBridge = "true";
  style.textContent = `
html[data-bc-active="true"],html[data-bc-active="true"] body{background:transparent!important}
/* Every surface DSH ships opaque is re-expressed as its own static palette
   color at an alpha tier, so the whole UI is one translucent material instead
   of a few translucent panels around solid blocks. Two knobs, both percentages:
   --bc-surface-mix for chrome (columns, composer card, dropdowns, popovers,
   chips) and --bc-content-mix for transcript content (user bubble, the colored
   highlight blocks, code and diff blocks). A token declared here recomputes
   whenever a phase / dim block below re-aliases its tier, so nothing has to be
   repeated per state. */
html[data-bc-active="true"] body{
  --bc-surface-mix:36%;
  --bc-content-mix:36%;
  --dsw-alias-bg-base:rgba(17,20,27,.10);
  --dsw-alias-bg-layer-1:rgba(26,30,39,.28);
  --dsw-alias-bg-layer-2:rgba(35,40,51,.32);
  --dsw-alias-bg-overlay:rgba(17,20,27,.12);
  --dsw-specific-sidebar-fill:color-mix(in srgb,var(--dsw-static-neutral-bluish-900) var(--bc-surface-mix),transparent);
  --dsw-specific-input-major:var(--dsw-specific-sidebar-fill);
  --dsw-alias-bg-layer-3:color-mix(in srgb,var(--dsw-static-neutral-bluish-800) var(--bc-surface-mix),transparent);
  --dsw-specific-tip:color-mix(in srgb,var(--dsw-static-neutral-bluish-800) var(--bc-surface-mix),transparent);
  --dsw-alias-bg-module-platform:color-mix(in srgb,var(--dsw-static-neutral-bluish-800) var(--bc-surface-mix),transparent);
  --dsw-specific-selector:color-mix(in srgb,var(--dsw-static-neutral-bluish-800) var(--bc-surface-mix),transparent);
  --dsw-alias-interactive-bg-hover-solid:color-mix(in srgb,var(--dsw-static-neutral-bluish-800) var(--bc-surface-mix),transparent);
  --dsw-alias-tooltip-bg:color-mix(in srgb,var(--dsw-static-neutral-bluish-750) var(--bc-surface-mix),transparent);
  --dsw-alias-toast-bg:color-mix(in srgb,var(--dsw-static-neutral-bluish-750) var(--bc-surface-mix),transparent);
  --dsw-alias-button-floating-fill:color-mix(in srgb,var(--dsw-static-neutral-bluish-850) var(--bc-surface-mix),transparent);
  --dsw-specific-bubble:color-mix(in srgb,var(--dsw-static-neutral-bluish-850) var(--bc-content-mix),transparent);
  --dsw-specific-bubble-highlight:color-mix(in srgb,var(--dsw-static-neutral-bluish-750) var(--bc-content-mix),transparent);
  --dsw-alias-state-warn-tertiary:color-mix(in srgb,var(--dsw-static-amber-900) var(--bc-content-mix),transparent);
  --dsw-alias-state-success-tertiary:color-mix(in srgb,var(--dsw-static-green-900) var(--bc-content-mix),transparent);
  --dsw-alias-state-business-tertiary:color-mix(in srgb,var(--dsw-static-deepseek-800) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-code-block:color-mix(in srgb,var(--dsw-static-neutral-bluish-900) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-code-block-banner:color-mix(in srgb,var(--dsw-static-neutral-bluish-850) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-inline-code:color-mix(in srgb,var(--dsw-static-neutral-800) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-tag:color-mix(in srgb,var(--dsw-static-neutral-bluish-850) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-citation:color-mix(in srgb,var(--dsw-static-neutral-bluish-800) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-placeholder:color-mix(in srgb,var(--dsw-static-neutral-bluish-850) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-code-segment-selected:color-mix(in srgb,var(--dsw-static-neutral-bluish-800) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-code-segment-unselected:color-mix(in srgb,var(--dsw-static-neutral-bluish-900) var(--bc-content-mix),transparent);
}
html[data-bc-resolved-tone="light"][data-bc-active="true"] body{
  --dsw-alias-bg-base:rgba(248,250,252,.12);
  --dsw-alias-bg-layer-1:rgba(255,255,255,.28);
  --dsw-alias-bg-layer-2:rgba(248,250,252,.32);
  --dsw-alias-bg-overlay:rgba(255,255,255,.14);
  --dsw-specific-sidebar-fill:color-mix(in srgb,var(--dsw-static-neutral-bluish-50) var(--bc-surface-mix),transparent);
  --dsw-alias-bg-layer-3:color-mix(in srgb,var(--dsw-static-neutral-bluish-00) var(--bc-surface-mix),transparent);
  --dsw-specific-tip:color-mix(in srgb,var(--dsw-static-neutral-bluish-60) var(--bc-surface-mix),transparent);
  --dsw-alias-bg-module-platform:color-mix(in srgb,var(--dsw-static-neutral-bluish-60) var(--bc-surface-mix),transparent);
  --dsw-specific-selector:color-mix(in srgb,var(--dsw-static-neutral-bluish-60) var(--bc-surface-mix),transparent);
  --dsw-alias-interactive-bg-hover-solid:color-mix(in srgb,var(--dsw-static-neutral-bluish-75) var(--bc-surface-mix),transparent);
  --dsw-alias-tooltip-bg:color-mix(in srgb,var(--dsw-static-neutral-bluish-850) var(--bc-surface-mix),transparent);
  --dsw-alias-toast-bg:color-mix(in srgb,var(--dsw-static-neutral-bluish-800) var(--bc-surface-mix),transparent);
  --dsw-alias-button-floating-fill:color-mix(in srgb,var(--dsw-static-neutral-bluish-00) var(--bc-surface-mix),transparent);
  --dsw-specific-bubble:color-mix(in srgb,var(--dsw-static-deepseek-50) var(--bc-content-mix),transparent);
  --dsw-specific-bubble-highlight:color-mix(in srgb,var(--dsw-static-deepseek-200) var(--bc-content-mix),transparent);
  --dsw-alias-state-warn-tertiary:color-mix(in srgb,var(--dsw-static-amber-100) var(--bc-content-mix),transparent);
  --dsw-alias-state-success-tertiary:color-mix(in srgb,var(--dsw-static-green-100) var(--bc-content-mix),transparent);
  --dsw-alias-state-business-tertiary:color-mix(in srgb,var(--dsw-static-deepseek-100) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-code-block:color-mix(in srgb,var(--dsw-static-neutral-bluish-50) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-code-block-banner:color-mix(in srgb,var(--dsw-static-neutral-bluish-50) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-inline-code:color-mix(in srgb,var(--dsw-static-neutral-50) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-tag:color-mix(in srgb,var(--dsw-static-neutral-bluish-75) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-citation:color-mix(in srgb,var(--dsw-static-neutral-bluish-100) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-placeholder:color-mix(in srgb,var(--dsw-static-neutral-bluish-60) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-code-segment-selected:color-mix(in srgb,var(--dsw-static-neutral-bluish-00) var(--bc-content-mix),transparent);
  --dsw-alias-markdown-code-segment-unselected:color-mix(in srgb,var(--dsw-static-neutral-bluish-75) var(--bc-content-mix),transparent);
}
/* The cards listed under 本轮文件改动 (the deliverables grid) do not read an
   alias token: the module root derives its own --deliverable-fill /
   --deliverable-hover pair from the static palette, so no body-level override
   reaches them. Declaring the pair on the card element itself wins over the
   value it would otherwise inherit from that root. */
html[data-bc-active="true"] [data-presented-file]{
  --deliverable-fill:color-mix(in srgb,var(--dsw-static-neutral-850) var(--bc-content-mix),transparent);
  --deliverable-hover:color-mix(in srgb,var(--dsw-static-neutral-800) var(--bc-content-mix),transparent);
}
html[data-bc-resolved-tone="light"][data-bc-active="true"] [data-presented-file]{
  --deliverable-fill:color-mix(in srgb,var(--dsw-static-neutral-50) var(--bc-content-mix),transparent);
  --deliverable-hover:color-mix(in srgb,var(--dsw-static-neutral-100) var(--bc-content-mix),transparent);
}
/* DSH renders the dropdown menus through --dsw-specific-menu, which it defines
   as var(--dsw-alias-bg-layer-3), so the layer override above already carries
   them onto the same tier. */
html[data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --bc-surface-mix:86%;
  --bc-content-mix:72%;
  --dsw-alias-bg-base:rgba(17,20,27,.42);
  --dsw-alias-bg-layer-1:rgba(26,30,39,.72);
  --dsw-alias-bg-layer-2:rgba(35,40,51,.80);
  --dsw-alias-bg-overlay:rgba(17,20,27,.86);
}
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --dsw-alias-bg-base:rgba(248,250,252,.48);
  --dsw-alias-bg-layer-1:rgba(255,255,255,.74);
  --dsw-alias-bg-layer-2:rgba(248,250,252,.82);
  --dsw-alias-bg-overlay:rgba(255,255,255,.86);
}
#beauticode-bg-stage{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:#11141b}
#beauticode-bg-stage::after{content:"";position:absolute;inset:0;z-index:3;background:transparent;pointer-events:none}
html[data-bc-resolved-tone="light"] #beauticode-bg-stage{background:#f8fafc}
/* The background shadow defaults to zero, so the wallpaper keeps its own
   brightness until someone moves the 背景阴影 slider — that writes --bc-dim and
   takes over through the data-bc-dim-user rules below. */
html[data-bc-active="true"]:has(#root [data-phase="active"]) #beauticode-bg-stage::after,
html[data-bc-active="true"]:has(#root [data-phase="settling"]) #beauticode-bg-stage::after{background:rgba(0,0,0,0)}
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="active"]) #beauticode-bg-stage::after,
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="settling"]) #beauticode-bg-stage::after{background:rgba(255,255,255,0)}
html[data-bc-dim-user="true"][data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-dim-user="true"][data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --dsw-alias-bg-base:rgba(17,20,27,.10);
  --dsw-alias-bg-layer-1:rgba(26,30,39,.28);
  --dsw-alias-bg-layer-2:rgba(35,40,51,.32);
  --dsw-alias-bg-overlay:rgba(17,20,27,.12);
  --bc-surface-mix:36%;
  --bc-content-mix:36%;
}
html[data-bc-resolved-tone="light"][data-bc-dim-user="true"][data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-resolved-tone="light"][data-bc-dim-user="true"][data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --dsw-alias-bg-base:rgba(248,250,252,.12);
  --dsw-alias-bg-layer-1:rgba(255,255,255,.28);
  --dsw-alias-bg-layer-2:rgba(248,250,252,.32);
  --dsw-alias-bg-overlay:rgba(255,255,255,.14);
}
html[data-bc-dim-user="true"][data-bc-active="true"] #beauticode-bg-stage::after{background:rgba(0,0,0,var(--bc-dim))!important}
html[data-bc-resolved-tone="light"][data-bc-dim-user="true"][data-bc-active="true"] #beauticode-bg-stage::after{background:rgba(255,255,255,var(--bc-dim))!important}
html[data-bc-fish="true"] #beauticode-bg-stage::after{background:transparent!important}
#beauticode-bg-stage .beauticode-media-slot{position:absolute;inset:0;z-index:0;opacity:1;overflow:hidden;pointer-events:none;transition:opacity ${CROSSFADE_MS}ms ease;will-change:opacity}
#beauticode-bg-stage .beauticode-media-slot[data-bc-role="current"]{z-index:1;opacity:1}
#beauticode-bg-stage .beauticode-media-slot[data-bc-role="candidate"]{z-index:2;opacity:1}
#beauticode-bg-stage[data-bc-empty="true"] .beauticode-media-slot[data-bc-role="candidate"]{z-index:1}
#beauticode-bg-stage[data-bc-transitioning="true"] .beauticode-media-slot[data-bc-role="current"]{opacity:0}
#beauticode-bg-stage[data-bc-transitioning="true"] .beauticode-media-slot[data-bc-role="candidate"]{opacity:1}
#beauticode-bg-stage .beauticode-media-slot img,#beauticode-bg-stage .beauticode-media-slot video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;transition:opacity 120ms ease}
#beauticode-bg-stage .beauticode-media-slot img{z-index:2;opacity:1}
/* Keep cold candidate video paintable. Chromium may defer decoding media that
   is nearly transparent, which deadlocks the first-frame gate. The poster
   covers it until data-bc-video-ready is committed. */
#beauticode-bg-stage .beauticode-media-slot video{z-index:1;opacity:1}
#beauticode-bg-stage .beauticode-media-slot[data-bc-video-ready="true"] img{opacity:0}
#beauticode-bg-stage .beauticode-media-slot[data-bc-video-ready="true"] video{opacity:1}
/* Background blur (磨砂). Applied to the background media element itself with a
   plain CSS filter, never to the stage or the app:

     - no backdrop-filter  -> no containing block, so settings dialog and every
                              fixed/absolute control keeps its position
     - no extra DOM node   -> nothing to stack, nothing to isolate

   The media is NOT scaled: an earlier revision grew it slightly to hide the soft
   border a blur leaves at the viewport edge, but a growing picture is a worse
   artefact than the soft edge, so the picture keeps its framing. */
html[data-bc-bg-blur="true"] #beauticode-bg-stage .beauticode-media-slot img,
html[data-bc-bg-blur="true"] #beauticode-bg-stage .beauticode-media-slot video{
  filter:blur(var(--bc-bg-blur,0px));
}
@media (prefers-reduced-motion:reduce){#beauticode-bg-stage .beauticode-media-slot,#beauticode-bg-stage .beauticode-media-slot img,#beauticode-bg-stage .beauticode-media-slot video{transition:none!important}}
html[data-bc-active="true"] #root{position:relative;z-index:1;background:transparent!important}
html[data-bc-active="true"] [class*="_fade"]{display:none!important}
html[data-bc-fish="true"] #root{opacity:0!important;visibility:hidden!important;pointer-events:none!important}
`;
  document.head.append(style);

  const DIM_STORAGE_KEY = "beauticode-dim";
  let userDim = null;

  function clampDim(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) return null;
    return n;
  }

  function readStoredDim() {
    try {
      const raw = globalThis.localStorage?.getItem(DIM_STORAGE_KEY);
      if (raw == null || raw === "") return null;
      return clampDim(raw);
    } catch {
      return null;
    }
  }

  function writeStoredDim(value) {
    try {
      if (value == null) globalThis.localStorage?.removeItem(DIM_STORAGE_KEY);
      else globalThis.localStorage?.setItem(DIM_STORAGE_KEY, String(value));
    } catch {
      /* private mode / quota */
    }
  }

  function applyUserDim(value) {
    const root = document.documentElement;
    if (value == null) {
      delete root.dataset.bcDimUser;
      root.removeAttribute("data-bc-dim-user");
      root.style.removeProperty?.("--bc-dim");
      return null;
    }
    root.dataset.bcDimUser = "true";
    root.style.setProperty?.("--bc-dim", String(value));
    return value;
  }

  function getUserDim() {
    return userDim;
  }

  function setUserDim(value) {
    const next = clampDim(value);
    if (next == null) return userDim;
    userDim = next;
    writeStoredDim(next);
    applyUserDim(next);
    return next;
  }

  function clearUserDim() {
    userDim = null;
    writeStoredDim(null);
    applyUserDim(null);
    return null;
  }

  userDim = readStoredDim();
  if (userDim != null) applyUserDim(userDim);
  globalThis.BeauticodeBackgroundDim = {
    get: getUserDim,
    set: setUserDim,
    clear: clearUserDim,
  };


  // ---------------------------------------------------------------------------
  // Background blur (磨砂程度, 0-100%).
  //
  // Publishes a percentage and writes two things on <html>: the --bc-bg-blur
  // length the stylesheet applies to the media, and a data attribute so the rule
  // only matches while the value is above zero. 0% therefore means "no rule
  // matches at all", which is exactly the previous appearance.
  // ---------------------------------------------------------------------------
  const BG_BLUR_KEY = "beauticode-bg-blur";
  // 100% on the slider maps to this radius. Chosen from the rendered result:
  // the previous 30px cap was already heavy at 30%, so 9px is the new ceiling.
  const BG_BLUR_MAX_PX = 9;
  let bgBlurPercent = 0;

  function clampBlurPercent(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  function applyBgBlur() {
    const root = document.documentElement;
    if (!root?.dataset || !root.style) return;
    const setVar = typeof root.style.setProperty === "function"
      ? root.style.setProperty.bind(root.style)
      : null;
    const px = (bgBlurPercent / 100) * BG_BLUR_MAX_PX;
    setVar?.("--bc-bg-blur", `${px.toFixed(2)}px`);
    if (bgBlurPercent > 0) root.dataset.bcBgBlur = "true";
    else if (root.dataset) delete root.dataset.bcBgBlur;
  }

  function getBgBlur() {
    return bgBlurPercent;
  }

  function setBgBlur(value) {
    const percent = clampBlurPercent(value);
    if (percent == null) return bgBlurPercent;
    bgBlurPercent = percent;
    try {
      globalThis.localStorage?.setItem(BG_BLUR_KEY, String(percent));
    } catch {
      /* private mode / quota */
    }
    applyBgBlur();
    return percent;
  }

  try {
    const stored = clampBlurPercent(globalThis.localStorage?.getItem(BG_BLUR_KEY));
    if (stored != null) bgBlurPercent = stored;
  } catch {
    /* private mode */
  }
  globalThis.BeauticodeBackgroundBlur = { get: getBgBlur, set: setBgBlur };
  try {
    applyBgBlur();
  } catch {
    /* a cosmetic extra must never take the background down with it */
  }

  // Chromium builds its media stack lazily; the first <video> of a fresh
  // profile pays decoder/GPU/audio init inside the first import's verify
  // deadline. One muted playback of the bundled frame pays that cost early.
  // Everything is best-effort: a warmup failure must never affect the page.
  function warmUpMediaStack() {
    try {
      const mount = document.documentElement;
      if (typeof mount?.append !== "function") return;
      if (mount.dataset.bcMediaWarmup === "done") return;
      mount.dataset.bcMediaWarmup = "running";
      const video = document.createElement("video");
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timer);
        try {
          video.removeAttribute("src");
          video.load();
        } catch {}
        video.remove?.();
        mount.dataset.bcMediaWarmup = "done";
      };
      const timer = setTimeout(cleanup, 15_000);
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.setAttribute?.("muted", "");
      video.setAttribute?.("disablepictureinpicture", "");
      video.setAttribute?.("aria-hidden", "true");
      video.tabIndex = -1;
      // Nearly transparent or hidden media can be decode-deferred (see the
      // first-frame fix); a 4x4 fully painted square under every layer is
      // imperceptible while remaining decodable.
      video.style.cssText =
        "position:fixed;left:0;top:0;width:4px;height:4px;opacity:1;pointer-events:none;z-index:-2147483647;border:0;margin:0;padding:0";
      video.addEventListener?.("ended", cleanup, { once: true });
      video.addEventListener?.("error", cleanup, { once: true });
      video.src = WARMUP_VIDEO_DATA_URI;
      mount.append(video);
      const playback = video.play?.();
      playback?.catch?.(() => {});
    } catch {
      try {
        document.documentElement.dataset.bcMediaWarmup = "done";
      } catch {}
    }
  }
  warmUpMediaStack();

  function dshAppearance() {
    const body = document.body;
    if (body?.hasAttribute("data-ds-dark-theme")) return "dark";
    const scheme = document.documentElement.style.colorScheme;
    if (scheme === "dark" || scheme === "light") return scheme;
    return systemDarkMedia?.matches ? "dark" : "light";
  }

  function resolvedTone() {
    return dshAppearance();
  }

  function isDshThemeSynced(tone = resolvedTone()) {
    return document.documentElement.dataset.bcResolvedTone === tone;
  }

  function syncDshTheme() {
    const tone = resolvedTone();
    document.documentElement.dataset.bcResolvedTone = tone;
    return isDshThemeSynced(tone);
  }

  function scheduleDshThemeSync() {
    if (themeSyncQueued) return;
    themeSyncQueued = true;
    queueMicrotask(() => {
      themeSyncQueued = false;
      syncDshTheme();
    });
  }

  const themeObserver = new MutationObserver(scheduleDshThemeSync);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });
  if (document.body) {
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-ds-dark-theme"],
    });
  }
  systemDarkMedia?.addEventListener("change", () => {
    if (desiredModes.tone === "auto") {
      syncDshTheme();
      void acknowledgeMode().catch(() => {});
    }
  });
  syncDshTheme();

  function stage() {
    let node = document.getElementById("beauticode-bg-stage");
    if (!node) {
      node = document.createElement("div");
      node.id = "beauticode-bg-stage";
      document.body.prepend(node);
    }
    return node;
  }

  /**
   * Fail closed on DSH DOM drift: the injected CSS depends on `#root`.
   * If the shell no longer exposes it, report a clear error through the
   * render ack instead of silently painting a broken page.
   */
  function dshStructureIssue() {
    if (!document.getElementById("root")) {
      return "DSH 页面结构不兼容：未找到 #root。";
    }
    return null;
  }

  function waitForDshStructure(signal, timeoutMs = DSH_STRUCTURE_TIMEOUT_MS) {
    if (!dshStructureIssue()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const startedAt = performance.now();
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        signal?.removeEventListener?.("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(abortError());
      const timer = setInterval(() => {
        const issue = dshStructureIssue();
        if (!issue) {
          finish();
        } else if (performance.now() - startedAt >= timeoutMs) {
          finish(new Error(issue));
        }
      }, 50);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function mountedCurrentSlot() {
    const node = document.getElementById("beauticode-bg-stage");
    if (
      !currentSlot ||
      currentSlot.isConnected !== true ||
      currentSlot.parentElement !== node ||
      currentSlot.dataset.bcRole !== "current"
    ) {
      currentSlot = null;
      committedPayload = null;
      return null;
    }
    return currentSlot;
  }

  function activeVideo() {
    const video = mountedCurrentSlot()?.querySelector?.("video") ?? null;
    return video instanceof HTMLVideoElement ? video : null;
  }

  function pendingVideo() {
    const node = document.getElementById("beauticode-bg-stage");
    const video = node?.querySelector?.(
      '.beauticode-media-slot[data-bc-role="candidate"] video',
    );
    return video instanceof HTMLVideoElement ? video : null;
  }

  // Same-origin receipt only — NOT an authenticated control API. clientId is
  // a client-generated correlation id (see top of file), not a credential.
  // The server enforces same-origin and binds this to a live SSE session for
  // the clientId; it intentionally does not use authorized()/tokenFile,
  // which is reserved for /apply, /mode, /status.
  async function postAck(body) {
    await fetch("/__beauticode/ack", {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, ...body }),
    }).catch(() => {});
  }

  function playbackSnapshot(video) {
    if (!(video instanceof HTMLVideoElement)) return null;
    return {
      currentTime: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
      duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
      hasVideo: true,
      muted: video.muted,
      paused: video.paused,
      blocked: playbackBlocked,
    };
  }

  async function acknowledgeRender(payload, ok, visible, error = null, extra = {}) {
    if (activePayload === payload) {
      renderPhase = ok ? "ready" : "failed";
    }
    // A committed video apply may still be settling: ok=true with
    // videoReady=false means the poster is live and the first frame upgrades
    // in place. Only ok=false is a renderer verdict the host will act on.
    const videoReady = extra.videoReady !== false;
    await postAck({
      kind: "render",
      generation: payload.generation,
      media: payload.media,
      ok,
      visible,
      error,
      ...(payload.media === "video" ? { videoReady } : {}),
      playback:
        ok && committedPayload === payload && payload.media === "video" && videoReady
          ? playbackSnapshot(activeVideo())
          : null,
    });
  }

  async function acknowledgeMode() {
    const video = activeVideo();
    const effectiveTone = resolvedTone();
    await postAck({
      kind: "mode",
      fish: document.documentElement.dataset.bcFish === "true",
      muted: video instanceof HTMLVideoElement ? video.muted : desiredModes.muted,
      tone: document.documentElement.dataset.bcTone || "dark",
      resolvedTone: effectiveTone,
      themeSynced: isDshThemeSynced(effectiveTone),
      blocked: playbackBlocked,
    });
  }

  function abortError() {
    try {
      return new DOMException("Background apply superseded", "AbortError");
    } catch {
      const error = new Error("Background apply superseded");
      error.name = "AbortError";
      return error;
    }
  }

  function isAbortError(error) {
    return error?.name === "AbortError";
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }

  function releaseImage(image, { remove = false } = {}) {
    if (!image) return;
    image.onload = null;
    image.onerror = null;
    try {
      image.removeAttribute?.("src");
    } catch {
      image.src = "";
    }
    if (remove) image.remove?.();
  }

  function imageAttemptUrl(url, attempt) {
    if (attempt === 0) return url;
    try {
      const retryUrl = new URL(url, globalThis.location?.href);
      retryUrl.searchParams.set(
        "bcImageRetry",
        `${clientId}-${attempt}-${Date.now().toString(36)}`,
      );
      return retryUrl.href;
    } catch {
      return url;
    }
  }

  function waitForImageAttempt(image, url, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let decodeStarted = false;
      let decodeFallback = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (decodeFallback) clearTimeout(decodeFallback);
        signal?.removeEventListener?.("abort", aborted);
        image.onload = null;
        image.onerror = null;
      };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const acceptLoaded = () => {
        if (!(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)) {
          if (image.complete) finish(new Error("图片尺寸无效"));
          return;
        }
        if (!decodeStarted && typeof image.decode === "function") {
          decodeStarted = true;
          // decode() is a second readiness signal, but the per-attempt timer
          // remains authoritative. A loaded image is still accepted after a
          // short decode grace period if Chromium leaves decode() pending.
          decodeFallback = setTimeout(() => {
            if (
              image.isConnected === true &&
              image.complete &&
              image.naturalWidth > 0 &&
              image.naturalHeight > 0
            ) {
              finish();
            } else {
              finish(new Error("图片解码未完成"));
            }
          }, 750);
          let decodePromise;
          try {
            decodePromise = image.decode();
          } catch {
            finish(new Error("图片解码失败"));
            return;
          }
          Promise.resolve(decodePromise).then(
            () => finish(),
            () => finish(new Error("图片解码失败")),
          );
          return;
        }
        finish();
      };
      const failed = () => finish(new Error("图片请求失败"));
      const aborted = () => finish(abortError());
      const timer = setTimeout(
        () => finish(new Error("等待图片请求或解码超时")),
        timeoutMs,
      );
      image.onload = acceptLoaded;
      image.onerror = failed;
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) {
        aborted();
        return;
      }
      image.src = url;
      if (image.complete) queueMicrotask(acceptLoaded);
    });
  }

  function waitForRetryWindow(signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(abortError());
      const timer = setTimeout(() => finish(), timeoutMs);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  async function loadImage(slot, url, signal, timeoutMs = IMAGE_LOAD_TIMEOUT_MS) {
    const deadline = performance.now() + timeoutMs;
    const attempts = [];
    let lastError = null;

    const startAttempt = (attempt) => {
      throwIfAborted(signal);
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new Error("等待图片请求或解码超时");
      const controller = new AbortController();
      const parentAborted = () => controller.abort();
      signal?.addEventListener?.("abort", parentAborted, { once: true });
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      image.className = "beauticode-media-poster";
      slot.prepend(image);
      const promise = waitForImageAttempt(
        image,
        imageAttemptUrl(url, attempt),
        controller.signal,
        Math.max(1, remainingMs),
      )
        .then(() => image)
        .finally(() => signal?.removeEventListener?.("abort", parentAborted));
      const record = { controller, image, promise };
      attempts.push(record);
      return record;
    };

    const cleanupAttempts = (winner = null) => {
      for (const attempt of attempts) {
        if (attempt.image === winner) continue;
        attempt.controller.abort();
        releaseImage(attempt.image, { remove: true });
      }
    };

    try {
      const first = startAttempt(0);
      const firstWindow = await Promise.race([
        first.promise.then(
          (image) => ({ image }),
          (error) => ({ error }),
        ),
        waitForRetryWindow(
          signal,
          Math.max(1, Math.min(IMAGE_ATTEMPT_TIMEOUT_MS, deadline - performance.now())),
        ).then(() => ({ retry: true })),
      ]);
      if (firstWindow.image) {
        cleanupAttempts(firstWindow.image);
        return firstWindow.image;
      }
      if (isAbortError(firstWindow.error) || signal?.aborted) throw abortError();
      lastError = firstWindow.error ?? lastError;

      // Keep the original request alive. The cache-busted retry runs beside it
      // so a merely slow cold decode is never destroyed to recover a hung one.
      if (IMAGE_MAX_ATTEMPTS > 1) startAttempt(1);
      let winner;
      try {
        winner = await Promise.any(attempts.map((attempt) => attempt.promise));
      } catch (error) {
        const errors = Array.isArray(error?.errors) ? error.errors : [];
        lastError = errors.at(-1) ?? lastError ?? error;
        throw lastError;
      }
      cleanupAttempts(winner);
      return winner;
    } catch (error) {
      cleanupAttempts();
      if (isAbortError(error) || signal?.aborted) throw abortError();
      lastError = error ?? lastError;
      const visibility = document.visibilityState || "unknown";
      const online = globalThis.navigator?.onLine === false ? "offline" : "online";
      const phase = lastError?.message || "unknown";
      const summary =
        phase === "图片请求失败"
          ? "图片加载失败"
          : phase.includes("超时")
            ? "等待图片加载超时"
            : "图片校验失败";
      throw new Error(
        `${summary}（已尝试 ${attempts.length} 次；页面=${visibility}；网络=${online}；最后阶段=${phase}）`,
      );
    }
  }

  function safeOrigin(value) {
    try {
      return new URL(value, globalThis.location?.href).origin;
    } catch {
      return "unknown";
    }
  }

  function videoRequestContext(url) {
    return `页面Origin=${safeOrigin(globalThis.location?.href)}；媒体Origin=${safeOrigin(url)}；页面=${document.visibilityState || "unknown"}`;
  }

  async function probeVideoSource(url, signal, timeoutMs = VIDEO_PROBE_TIMEOUT_MS) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const parentAborted = () => controller.abort();
    signal?.addEventListener?.("abort", parentAborted, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, timeoutMs));
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-1" },
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        signal: controller.signal,
      });
      if (response.status !== 206) {
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        throw new Error(`视频媒体 Range 探针返回 HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== 2) {
        throw new Error(`视频媒体 Range 探针返回 ${bytes.byteLength} 字节`);
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const context = videoRequestContext(url);
      if (timedOut || isAbortError(error)) {
        throw new Error(`视频媒体 Range 探针超时；${context}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError) {
        throw new Error(`视频媒体不可达或被 CORS 拒绝；${context}；${detail}`);
      }
      throw new Error(`${detail}；${context}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", parentAborted);
    }
  }

  const videoEventLog = new WeakMap();
  const VIDEO_DIAGNOSTIC_EVENTS = [
    "loadstart",
    "durationchange",
    "loadedmetadata",
    "loadeddata",
    "progress",
    "canplay",
    "canplaythrough",
    "playing",
    "waiting",
    "stalled",
    "suspend",
    "emptied",
    "error",
    "abort",
  ];

  // Field reports only used to show the final readyState. Recording when
  // each media event fired turns a bare timeout into a stage timeline: no
  // events at all means the request never started, loadstart-then-nothing
  // means the first range reads stalled (antivirus / cold cache).
  function trackVideoDiagnostics(video) {
    if (!video || typeof video.addEventListener !== "function") return;
    if (videoEventLog.has(video)) return;
    const log = [];
    videoEventLog.set(video, log);
    for (const name of VIDEO_DIAGNOSTIC_EVENTS) {
      video.addEventListener(name, () => {
        log.push(`${name}@${Math.round(performance.now())}ms`);
        if (log.length > 14) log.splice(0, log.length - 14);
      });
    }
  }

  function describeVideoDiagnostics(video) {
    const log = videoEventLog.get(video);
    if (!Array.isArray(log) || log.length === 0) {
      return "媒体事件=无（媒体请求未开始）";
    }
    return `媒体事件=${log.join("，")}`;
  }

  function describeVideoState(video, phase) {
    const mediaErrorNames = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
    };
    const code = Number(video?.error?.code) || 0;
    const mediaError = code ? mediaErrorNames[code] || `MEDIA_ERR_${code}` : "none";
    const src = video?.currentSrc || video?.src || "";
    return `${phase}；mediaError=${mediaError}；readyState=${video?.readyState ?? -1}；networkState=${video?.networkState ?? -1}；paused=${Boolean(video?.paused)}；${videoRequestContext(src)}；${describeVideoDiagnostics(video)}`;
  }

  function waitForVideo(video, signal, timeoutMs = VIDEO_STARTUP_TIMEOUT_MS) {
    const frameReadyState = HTMLMediaElement.HAVE_CURRENT_DATA ?? 2;
    if (video.readyState >= frameReadyState) return Promise.resolve();
    // A decoder error may fire before this waiter attaches — most notably
    // between the poster commit's crossfade and the settle start. Honoring an
    // already-set error keeps the settle phase from waiting out its full
    // budget on media that has already failed.
    if (video.error) {
      return Promise.reject(new Error(describeVideoState(video, "视频加载或解码失败")));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => finish();
      const check = () => {
        if (video.readyState >= frameReadyState) done();
      };
      const failed = () => {
        finish(new Error(describeVideoState(video, "视频加载或解码失败")));
      };
      const aborted = () => {
        finish(signal?.aborted ? abortError() : new Error(describeVideoState(video, "视频加载已中止")));
      };
      const timer = setTimeout(() => {
        finish(new Error(describeVideoState(video, "等待视频首帧超时")));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", check);
        video.removeEventListener("canplay", done);
        video.removeEventListener("error", failed);
        video.removeEventListener("abort", aborted);
        signal?.removeEventListener?.("abort", aborted);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      video.addEventListener("loadeddata", check);
      video.addEventListener("canplay", done, { once: true });
      video.addEventListener("error", failed, { once: true });
      video.addEventListener("abort", aborted, { once: true });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function waitForSeek(video, signal, timeoutMs) {
    if (!video.seeking) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", done);
        video.removeEventListener("error", failed);
        signal?.removeEventListener?.("abort", aborted);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const done = () => finish();
      const failed = () => finish(new Error(describeVideoState(video, "视频跳转失败")));
      const aborted = () => finish(abortError());
      const timer = setTimeout(
        () => finish(new Error(describeVideoState(video, "等待视频跳转超时"))),
        timeoutMs,
      );
      video.addEventListener("seeked", done, { once: true });
      video.addEventListener("error", failed, { once: true });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function waitForPresentedFrame(video, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const initialTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      let frameSeen = false;
      let playingSeen =
        !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      let settled = false;
      let frameRequest = null;
      const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";

      const cleanup = () => {
        clearInterval(timer);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("timeupdate", check);
        video.removeEventListener("loadeddata", check);
        video.removeEventListener("canplay", check);
        video.removeEventListener("error", failed);
        video.removeEventListener("abort", aborted);
        signal?.removeEventListener?.("abort", aborted);
        if (frameRequest != null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(frameRequest);
        }
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const failed = () => {
        finish(new Error(describeVideoState(video, "视频解码器报告失败")));
      };
      const aborted = () => {
        finish(signal?.aborted ? abortError() : new Error(describeVideoState(video, "视频播放已中止")));
      };
      const check = () => {
        if (settled) return;
        if (video.error) {
          failed();
          return;
        }
        if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          playingSeen = true;
        }
        const current = Number.isFinite(video.currentTime) ? video.currentTime : initialTime;
        const progressed = current >= initialTime + VIDEO_FIRST_FRAME_PROGRESS_SEC;
        if (
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          !video.paused &&
          playingSeen &&
          (frameSeen || progressed)
        ) {
          finish();
          return;
        }
        if (performance.now() - startedAt >= timeoutMs) {
          finish(new Error(describeVideoState(video, "视频未在首帧窗口内完成呈现")));
        }
      };
      const onPlaying = () => {
        playingSeen = true;
        check();
      };
      const onFrame = () => {
        frameSeen = true;
        check();
      };
      const timer = setInterval(check, 80);
      video.addEventListener("playing", onPlaying);
      video.addEventListener("timeupdate", check);
      video.addEventListener("loadeddata", check);
      video.addEventListener("canplay", check);
      video.addEventListener("error", failed, { once: true });
      video.addEventListener("abort", aborted, { once: true });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (hasFrameCallback) frameRequest = video.requestVideoFrameCallback(onFrame);
      if (signal?.aborted) aborted();
      check();
    });
  }

  function waitForStablePlayback(video, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      let lastTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      let accumulatedProgress = 0;
      let advancingSamples = 0;
      let stableFrames = 0;
      let lastFrameTime = null;
      let playingSeen =
        !video.paused &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      let settled = false;
      let frameRequest = null;
      const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";

      const cleanup = () => {
        clearInterval(timer);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("timeupdate", check);
        video.removeEventListener("waiting", resetStableWindow);
        video.removeEventListener("stalled", resetStableWindow);
        video.removeEventListener("pause", resetStableWindow);
        video.removeEventListener("seeking", resetStableWindow);
        video.removeEventListener("error", failed);
        video.removeEventListener("abort", aborted);
        signal?.removeEventListener?.("abort", aborted);
        if (frameRequest != null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(frameRequest);
        }
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const failed = () => {
        finish(new Error(describeVideoState(video, "视频解码器报告失败")));
      };
      const aborted = () => {
        finish(signal?.aborted ? abortError() : new Error(describeVideoState(video, "视频播放已中止")));
      };
      const observeProgress = () => {
        const current = Number.isFinite(video.currentTime) ? video.currentTime : lastTime;
        let delta = current - lastTime;
        if (
          delta < 0 &&
          Number.isFinite(video.duration) &&
          video.duration > 0 &&
          lastTime > video.duration - 1 &&
          current < 1
        ) {
          delta = video.duration - lastTime + current;
        }
        if (delta > 0.003 && delta < 2) {
          accumulatedProgress += delta;
          advancingSamples += 1;
        }
        lastTime = current;
      };
      const resetStableWindow = () => {
        playingSeen = false;
        stableFrames = 0;
        advancingSamples = 0;
        accumulatedProgress = 0;
        lastTime = Number.isFinite(video.currentTime) ? video.currentTime : lastTime;
      };
      const check = () => {
        if (settled) return;
        if (video.error) {
          failed();
          return;
        }
        observeProgress();
        if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          playingSeen = true;
        }
        const framesReady = hasFrameCallback
          ? stableFrames >= VIDEO_STABLE_FRAMES
          : advancingSamples >= VIDEO_STABLE_FRAMES;
        if (
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          !video.paused &&
          playingSeen &&
          framesReady &&
          accumulatedProgress >= VIDEO_STABLE_PROGRESS_SEC
        ) {
          finish();
          return;
        }
        if (performance.now() - startedAt >= timeoutMs) {
          finish(new Error(describeVideoState(video, "视频未在稳定窗口内输出首帧")));
        }
      };
      const onPlaying = () => {
        playingSeen = true;
        check();
      };
      const onFrame = (_now, metadata) => {
        if (settled) return;
        const mediaTime = Number.isFinite(metadata?.mediaTime)
          ? metadata.mediaTime
          : video.currentTime;
        if (lastFrameTime == null || mediaTime > lastFrameTime + 0.001) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        lastFrameTime = mediaTime;
        check();
        if (!settled) frameRequest = video.requestVideoFrameCallback(onFrame);
      };
      const timer = setInterval(check, 80);
      video.addEventListener("playing", onPlaying);
      video.addEventListener("timeupdate", check);
      video.addEventListener("waiting", resetStableWindow);
      video.addEventListener("stalled", resetStableWindow);
      video.addEventListener("pause", resetStableWindow);
      video.addEventListener("seeking", resetStableWindow);
      video.addEventListener("error", failed, { once: true });
      video.addEventListener("abort", aborted, { once: true });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (hasFrameCallback) frameRequest = video.requestVideoFrameCallback(onFrame);
      if (signal?.aborted) aborted();
      check();
    });
  }

  function seekVideo(video, value) {
    const requested = Number(value);
    const duration = Number(video.duration);
    const safe =
      Number.isFinite(requested) &&
      requested >= 0 &&
      (!Number.isFinite(duration) || duration <= 0 || requested < duration)
        ? requested
        : 0;
    try {
      video.currentTime = safe;
    } catch {
      video.currentTime = 0;
    }
    return safe;
  }

  async function playWithPreference(video, signal = null) {
    throwIfAborted(signal);
    const requestedMuted = desiredModes.muted;
    let blocked = false;
    video.muted = requestedMuted;
    try {
      await video.play();
    } catch (error) {
      throwIfAborted(signal);
      if (requestedMuted) throw error;
      blocked = true;
      video.muted = true;
      await video.play();
    }
    throwIfAborted(signal);
    video.dataset.bcPlaybackBlocked = blocked ? "true" : "false";
    return blocked;
  }

  // Phase one only needs playback initiated. On a cold machine the muted
  // play() promise can stay pending well past the apply deadline while the
  // decoder warms; that is not a failure — the poster-first commit tolerates
  // it and the settle phase owns the eventual outcome. Only an outright
  // rejection (autoplay policy, detached element) fails the apply.
  async function startCandidatePlayback(video, signal, timeoutMs) {
    const playbackController = new AbortController();
    const parentAborted = () => playbackController.abort();
    signal?.addEventListener?.("abort", parentAborted, { once: true });
    let acceptTimer = null;
    let abortListener = null;
    const accepted = new Promise((resolve) => {
      acceptTimer = setTimeout(() => resolve("accepted"), Math.max(1, timeoutMs));
      abortListener = () => resolve("aborted");
      playbackController.signal.addEventListener("abort", abortListener, { once: true });
    });
    if (signal?.aborted) parentAborted();
    const playback = playWithPreference(video, playbackController.signal);
    // The settle phase owns late outcomes of an accepted-but-unresolved play().
    void playback.catch?.(() => {});
    try {
      const outcome = await Promise.race([playback.then(() => "started"), accepted]);
      if (outcome === "aborted") throw abortError();
      return outcome;
    } finally {
      clearTimeout(acceptTimer);
      signal?.removeEventListener?.("abort", parentAborted);
      if (abortListener) {
        playbackController.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  function disposeVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    try {
      video.pause();
    } catch {
      /* best effort */
    }
    const objectUrl = video.dataset?.bcObjectUrl;
    if (
      objectUrl &&
      typeof URL !== "undefined" &&
      typeof URL.revokeObjectURL === "function"
    ) {
      URL.revokeObjectURL(objectUrl);
    }
    try {
      video.removeAttribute("src");
      video.srcObject = null;
      video.load();
    } catch {
      /* detached or already released */
    }
  }

  function disposeSlot(slot) {
    if (!slot) return;
    for (const video of slot.querySelectorAll?.("video") ?? []) disposeVideo(video);
    for (const image of slot.querySelectorAll?.("img") ?? []) {
      releaseImage(image);
    }
    slot.remove?.();
  }

  function createSlot(payload, video = null) {
    const slot = document.createElement("div");
    slot.className = "beauticode-media-slot";
    slot.dataset.bcRole = "candidate";
    slot.dataset.bcMedia = payload.media;
    slot.dataset.bcGeneration = String(payload.generation);
    slot.dataset.bcImageUrl = payload.imageUrl;
    if (payload.videoUrl) slot.dataset.bcVideoUrl = payload.videoUrl;
    if (payload.media === "video") {
      const startAt = Number(payload.startAt);
      slot.dataset.bcStartAt = String(Number.isFinite(startAt) && startAt >= 0 ? startAt : 0);
    }
    if (video) {
      video.className = "beauticode-media-video";
      slot.append(video);
    }
    return slot;
  }

  function slotMatchesPayload(slot, payload) {
    if (!slot || slot !== mountedCurrentSlot() || slot.dataset.bcMedia !== payload.media) {
      return false;
    }
    if (payload.media !== "video") {
      if (slot.dataset.bcImageUrl !== payload.imageUrl) return false;
      const image = slot.querySelector?.("img");
      return Boolean(
        image?.isConnected === true &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0,
      );
    }
    if (slot.dataset.bcVideoUrl !== payload.videoUrl) return false;
    const video = slot.querySelector?.("video");
    if (
      !(video instanceof HTMLVideoElement) ||
      video.error ||
      video.ended ||
      video.paused ||
      video.seeking ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return false;
    }
    // A local re-import can keep the exact same video handle while producing a
    // new poster token and resetting startAt. Reuse the live decoder; the
    // caller updates the poster metadata and seeks in place when needed.
    return true;
  }

  function updateCommittedDom(payload, videoReady = true) {
    document.documentElement.dataset.bcGeneration = String(payload.generation);
    document.documentElement.removeAttribute("data-bc-pending-generation");
    if (payload.media === "clear") {
      document.documentElement.removeAttribute("data-bc-active");
      document.documentElement.removeAttribute("data-bc-media");
      document.documentElement.removeAttribute("data-bc-video-ready");
      return;
    }
    document.documentElement.dataset.bcActive = "true";
    document.documentElement.dataset.bcMedia = payload.media;
    if (payload.media === "video") {
      // "false" keeps the poster as the committed visual until the settle
      // phase flips it after the first presented frame.
      document.documentElement.dataset.bcVideoReady = videoReady ? "true" : "false";
    } else {
      document.documentElement.removeAttribute("data-bc-video-ready");
    }
  }

  function discardCandidates() {
    const node = document.getElementById("beauticode-bg-stage");
    if (!node) return;
    node.removeAttribute("data-bc-transitioning");
    node.removeAttribute("data-bc-empty");
    for (const slot of
      node.querySelectorAll?.('.beauticode-media-slot[data-bc-role="candidate"]') ?? []) {
      disposeSlot(slot);
    }
  }

  function attachCandidate(slot, payload) {
    const node = stage();
    discardCandidates();
    const previous = mountedCurrentSlot();
    slot.dataset.bcRole = "candidate";
    node.append(slot);
    if (!previous) {
      node.dataset.bcEmpty = "true";
      document.documentElement.dataset.bcActive = "true";
      document.documentElement.dataset.bcMedia =
        payload.media === "video" ? "video-pending" : payload.media;
      document.documentElement.removeAttribute("data-bc-video-ready");
    }
  }

  function nextFrame(signal) {
    if (typeof requestAnimationFrame !== "function") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let request = null;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (request != null && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(request);
        }
        signal?.removeEventListener?.("abort", aborted);
      };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => {
        finish(abortError());
      };
      request = requestAnimationFrame(() => {
        request = null;
        if (signal?.aborted) finish(abortError());
        else finish();
      });
      // Background or power-saved Chromium pages may suspend rAF entirely.
      // A short timer keeps the transaction bounded without skipping aborts.
      timer = setTimeout(() => finish(), FRAME_FALLBACK_MS);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function waitForCrossfade(slot, signal) {
    if (reducedMotionMedia?.matches) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        slot.removeEventListener("transitionend", ended);
        signal?.removeEventListener?.("abort", aborted);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const ended = (event) => {
        if (event.target === slot && (!event.propertyName || event.propertyName === "opacity")) finish();
      };
      const aborted = () => finish(abortError());
      const timer = setTimeout(() => finish(), CROSSFADE_MS + 80);
      slot.addEventListener("transitionend", ended);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  async function commitCandidate(payload, slot, signal, remainingMs = () => Infinity) {
    throwIfAborted(signal);
    const node = stage();
    const previous = mountedCurrentSlot();
    const canAnimate =
      previous &&
      reducedMotionMedia?.matches !== true &&
      document.visibilityState === "visible" &&
      remainingMs() > CROSSFADE_MS + FRAME_FALLBACK_MS * 2 + 250;
    if (canAnimate) {
      await nextFrame(signal);
      await nextFrame(signal);
      throwIfAborted(signal);
      node.dataset.bcTransitioning = "true";
      await waitForCrossfade(previous, signal);
    }
    throwIfAborted(signal);
    if (previous && previous !== slot) disposeSlot(previous);
    slot.dataset.bcRole = "current";
    node.removeAttribute("data-bc-transitioning");
    node.removeAttribute("data-bc-empty");
    currentSlot = slot;
    committedPayload = payload;
    const video = activeVideo();
    playbackBlocked = video?.dataset?.bcPlaybackBlocked === "true";
    updateCommittedDom(payload, slot.dataset.bcVideoReady === "true");
    syncGallery(payload);
  }

  function restoreCommittedDom() {
    const node = document.getElementById("beauticode-bg-stage");
    node?.removeAttribute("data-bc-transitioning");
    node?.removeAttribute("data-bc-empty");
    if (committedPayload && mountedCurrentSlot()) {
      updateCommittedDom(committedPayload, currentSlot.dataset.bcVideoReady === "true");
      playbackBlocked = activeVideo()?.dataset?.bcPlaybackBlocked === "true";
      return;
    }
    node?.remove();
    document.documentElement.removeAttribute("data-bc-active");
    document.documentElement.removeAttribute("data-bc-media");
    document.documentElement.removeAttribute("data-bc-video-ready");
  }

  function syncGallery(payload) {
    const on = payload?.atmosphere?.preset === "gallery";
    try {
      const sync = globalThis.BeauticodeAtmosphere?.setWindowMode?.(on ? "on" : "closed");
      if (sync && typeof sync.then === "function") void sync.catch(() => {});
    } catch {
      /* Atmosphere is optional and must never invalidate a rendered background. */
    }
  }

  async function applyBackground(payload, signal) {
    throwIfAborted(signal);
    const applyDeadline = performance.now() + CLIENT_APPLY_DEADLINE_MS;
    const remaining = () => Math.max(1, applyDeadline - performance.now());
    if (payload.media === "clear") {
      desiredModes.fish = false;
      playbackBlocked = false;
      document.documentElement.removeAttribute("data-bc-fish");
      discardCandidates();
      disposeSlot(currentSlot);
      currentSlot = null;
      committedPayload = payload;
      document.getElementById("beauticode-bg-stage")?.remove();
      updateCommittedDom(payload);
      syncGallery(payload);
      if (document.documentElement.dataset.bcGallery === "true") {
        document.documentElement.dataset.bcActive = "true";
      }
      await acknowledgeRender(payload, true, false);
      await acknowledgeMode();
      return;
    }
    if (typeof payload.imageUrl !== "string" || payload.imageUrl.length === 0) {
      await acknowledgeRender(payload, false, Boolean(mountedCurrentSlot()), "图片载荷无效");
      return;
    }
    let reusable = slotMatchesPayload(currentSlot, payload);
    if (reusable && payload.media === "video") {
      try {
        const reusableVideo = activeVideo();
        trackVideoDiagnostics(reusableVideo);
        const requestedStartAt = Number(payload.startAt);
        const normalizedStartAt =
          Number.isFinite(requestedStartAt) && requestedStartAt >= 0 ? requestedStartAt : 0;
        const appliedStartAt = Number(currentSlot.dataset.bcStartAt);
        if (
          !Number.isFinite(appliedStartAt) ||
          Math.abs(appliedStartAt - normalizedStartAt) >= 0.25
        ) {
          const nextStartAt = seekVideo(reusableVideo, normalizedStartAt);
          currentSlot.dataset.bcStartAt = String(nextStartAt);
          await waitForSeek(reusableVideo, signal, remaining());
          await waitForVideo(reusableVideo, signal, remaining());
          await waitForPresentedFrame(reusableVideo, signal, remaining());
        } else {
          await waitForStablePlayback(reusableVideo, signal, Math.min(750, remaining()));
        }
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        reusable = false;
      }
    }
    if (reusable) {
      committedPayload = payload;
      currentSlot.dataset.bcGeneration = String(payload.generation);
      currentSlot.dataset.bcImageUrl = payload.imageUrl;
      if (payload.videoUrl) currentSlot.dataset.bcVideoUrl = payload.videoUrl;
      updateCommittedDom(payload);
      syncGallery(payload);
      await acknowledgeRender(payload, true, true);
      await acknowledgeMode();
      return;
    }
    let candidate = null;
    let candidateVideo = null;
    let committed = false;
    try {
      await waitForDshStructure(signal, remaining());
      if (payload.media === "image") {
        candidate = createSlot(payload);
        attachCandidate(candidate, payload);
        const image = await loadImage(candidate, payload.imageUrl, signal, remaining());
        throwIfAborted(signal);
        if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) throw new Error("图片尺寸无效");
        await commitCandidate(payload, candidate, signal, remaining);
        committed = true;
        await acknowledgeRender(payload, true, true);
        await acknowledgeMode();
        return;
      }
      if (payload.media !== "video" || typeof payload.videoUrl !== "string") {
        throw new Error("视频载荷无效");
      }
      const video = document.createElement("video");
      trackVideoDiagnostics(video);
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      // Set mute before src so Chromium may start the request immediately
      // without waiting for an audible autoplay decision.
      video.defaultMuted = true;
      video.muted = desiredModes.muted;
      video.setAttribute("muted", "");
      candidate = createSlot(payload, video);
      attachCandidate(candidate, payload);
      candidateVideo = video;
      video.src = payload.videoUrl;
      video.load();
      // Phase one gates only what the poster commit needs: the media source
      // answers Range requests, the poster decodes, and playback was
      // initiated. A cold decoder no longer fails the transaction here — the
      // video upgrades from the committed poster in the settle phase, so a
      // fresh machine that merely loads slowly can never time out.
      const sourceProbe = probeVideoSource(
        payload.videoUrl,
        signal,
        Math.min(VIDEO_PROBE_TIMEOUT_MS, remaining()),
      );
      const imageReady = loadImage(candidate, payload.imageUrl, signal, remaining());
      await Promise.all([
        sourceProbe,
        imageReady,
        startCandidatePlayback(video, signal, Math.min(PLAY_ACCEPT_TIMEOUT_MS, remaining())),
      ]);
      throwIfAborted(signal);
      await commitCandidate(payload, candidate, signal, remaining);
      committed = true;
      await acknowledgeRender(payload, true, true, null, { videoReady: false });
      await acknowledgeMode();
      settleCommittedVideo(video, candidate, payload);
      return;
    } catch (error) {
      if (candidateVideo && candidateVideo.parentElement !== candidate) {
        disposeVideo(candidateVideo);
        candidateVideo.remove?.();
      }
      if (candidate && !committed) disposeSlot(candidate);
      if (isAbortError(error) || signal?.aborted || activePayload !== payload) return;
      restoreCommittedDom();
      await acknowledgeRender(
        payload,
        false,
        Boolean(currentSlot),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Phase two of a video apply. The poster is already committed and acked, so
  // nothing here can roll the transaction back: a decoder that needs longer
  // than any host deadline simply keeps the poster until the first frame
  // presents, then upgrades the committed slot in place without a flash.
  function settleCommittedVideo(video, slot, payload) {
    videoSettleController?.abort();
    const controller = new AbortController();
    videoSettleController = controller;
    const stillSettling = () => !controller.signal.aborted && mountedCurrentSlot() === slot;
    void (async () => {
      try {
        await waitForVideo(video, controller.signal, VIDEO_SETTLE_TIMEOUT_MS);
        throwIfAborted(controller.signal);
        if (!stillSettling()) return;
        const appliedStartAt = seekVideo(video, payload.startAt);
        slot.dataset.bcStartAt = String(appliedStartAt);
        await waitForSeek(video, controller.signal, VIDEO_SETTLE_TIMEOUT_MS);
        await waitForVideo(video, controller.signal, VIDEO_SETTLE_TIMEOUT_MS);
        await waitForPresentedFrame(video, controller.signal, VIDEO_SETTLE_TIMEOUT_MS);
        if (!stillSettling()) return;
        slot.dataset.bcVideoReady = "true";
        updateCommittedDom(payload, true);
        playbackBlocked = video.dataset?.bcPlaybackBlocked === "true";
        await acknowledgeRender(payload, true, true, null, { videoReady: true });
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || !stillSettling()) return;
        // Keep the committed poster; drop the stalled decoder so a later apply
        // or re-import starts from a clean media element.
        disposeVideo(video);
        video.remove?.();
        slot.removeAttribute("data-bc-video-ready");
        await acknowledgeRender(
          payload,
          true,
          true,
          `视频预热未完成（已保留封面）：${error instanceof Error ? error.message : String(error)}`,
          { videoReady: false },
        );
      }
    })();
  }

  function scheduleBackground(payload) {
    if (!Number.isSafeInteger(payload?.generation)) return;
    // EventSource reconnects can replay the current frame while its first
    // render is still in flight. Restarting the same generation would discard
    // a healthy cold media request and move its deadline indefinitely.
    if (
      applyController &&
      activePayload?.generation === payload.generation &&
      activePayload?.media === payload.media
    ) {
      return;
    }
    if (
      Number.isSafeInteger(activePayload?.generation) &&
      payload.generation < activePayload.generation
    ) {
      return;
    }
    applyController?.abort();
    videoSettleController?.abort();
    videoSettleController = null;
    discardCandidates();
    const controller = new AbortController();
    applyController = controller;
    activePayload = payload;
    renderPhase = "pending";
    document.documentElement.dataset.bcPendingGeneration = String(payload.generation);
    void applyBackground(payload, controller.signal)
      .catch(async (error) => {
        if (isAbortError(error) || controller.signal.aborted || activePayload !== payload) return;
        restoreCommittedDom();
        await acknowledgeRender(
          payload,
          false,
          Boolean(mountedCurrentSlot()),
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (applyController !== controller) return;
        applyController = null;
        document.documentElement.removeAttribute("data-bc-pending-generation");
      })
      .catch(() => {});
  }

  async function applyModes(payload) {
    if (typeof payload.fish === "boolean") desiredModes.fish = payload.fish;
    if (typeof payload.muted === "boolean") desiredModes.muted = payload.muted;
    if (["dark", "light", "auto"].includes(payload.tone)) desiredModes.tone = payload.tone;
    document.documentElement.dataset.bcTone = desiredModes.tone;
    syncDshTheme();
    if (desiredModes.fish && document.documentElement.dataset.bcActive === "true") {
      document.documentElement.dataset.bcFish = "true";
    } else {
      document.documentElement.removeAttribute("data-bc-fish");
    }
    const video = activeVideo();
    const candidate = pendingVideo();
    if (candidate instanceof HTMLVideoElement) candidate.muted = desiredModes.muted;
    if (video instanceof HTMLVideoElement) {
      try {
        playbackBlocked = await playWithPreference(video);
      } catch {
        playbackBlocked = desiredModes.muted === false;
      }
      if (
        committedPayload?.media === "video" &&
        activePayload === committedPayload &&
        renderPhase === "ready"
      ) {
        await acknowledgeRender(committedPayload, true, true, null, {
          videoReady: mountedCurrentSlot()?.dataset.bcVideoReady === "true",
        });
      }
    } else {
      playbackBlocked = false;
    }
    await acknowledgeMode();
  }

  const events = new EventSource(
    `/__beauticode/events?clientId=${encodeURIComponent(clientId)}`,
  );
  events.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === "mode") void applyModes(payload).catch(() => {});
      else if (payload?.type === "apply") scheduleBackground(payload);
    } catch {
      /* EventSource will continue with the next valid frame. */
    }
  };

  setInterval(() => {
    if (
      !committedPayload ||
      activePayload !== committedPayload ||
      renderPhase !== "ready"
    ) {
      return;
    }
    if (committedPayload.media === "clear") {
      void acknowledgeRender(committedPayload, true, false).catch(() => {});
      return;
    }
    const slot = mountedCurrentSlot();
    if (!slot) return;
    if (committedPayload.media === "image") {
      const image = slot.querySelector?.("img");
      if (
        image?.isConnected === true &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.naturalHeight > 0
      ) {
        void acknowledgeRender(committedPayload, true, true).catch(() => {});
      }
      return;
    }
    const video = activeVideo();
    if (
      committedPayload.media === "video" &&
      video instanceof HTMLVideoElement
    ) {
      // A heartbeat is observational, not a second render verdict. Playback can
      // briefly pause while Chromium changes modes or refills an 8K buffer; do
      // not downgrade an already-rendered generation or fail a pending one.
      // Report the real first-frame state: a committed video that still only
      // shows its poster must not be acked as video-ready (see settleCommittedVideo).
      void acknowledgeRender(committedPayload, true, true, null, {
        videoReady: slot.dataset.bcVideoReady === "true",
      }).catch(() => {});
    }
  }, 1_000);

  // Fullscreen by default. A browser only grants fullscreen from inside a user
  // gesture, so a page cannot open in it; the closest honest reading of
  // "starts fullscreen" is the first click after load. Typing in the composer
  // must not count: DSH's main action is a keydown. Escape or the settings row
  // still exits, and an exit is not fought — the listener is spent on its first
  // call, so a page load enters at most once.
  function armFullscreenDefault() {
    const root = document.documentElement;
    if (typeof root?.requestFullscreen !== "function" &&
        typeof root?.webkitRequestFullscreen !== "function") {
      return;
    }
    let spent = false;
    const enter = () => {
      if (spent) return;
      spent = true;
      document.removeEventListener?.("pointerdown", enter, true);
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      for (const name of ["requestFullscreen", "webkitRequestFullscreen"]) {
        const request = root?.[name];
        if (typeof request !== "function") continue;
        const started = request.call(root);
        started?.catch?.(() => {});
        return;
      }
    };
    document.addEventListener?.("pointerdown", enter, { capture: true, once: true });
  }

  armFullscreenDefault();
})();

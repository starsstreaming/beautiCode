import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("fish mode CSS and runtime expose data-bc-fish helpers", async () => {
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const css = await fs.readFile(
    path.join(here, "../src/renderer/background.css"),
    "utf8",
  );
  const {loadRendererSource}=await import("../dist/payload.js");
  const {runtimeIife:runtime}=await loadRendererSource();
  assert.match(css, /data-bc-fish/);
  assert.match(css, /filter:\s*none/);
  assert.match(runtime, /setFishMode/);
  assert.match(runtime, /isFishMode/);
  assert.match(runtime, /data-bc-fish/);
  assert.match(runtime, /setMuted/);
  assert.match(runtime, /isMuted/);
  assert.match(runtime, /applyMutePreference/);
  assert.match(css, /data-bc-tone/);
  assert.match(css, /prefers-color-scheme: light/);
  // Codex's main-surface class is CSS-module hashed and changes between builds.
  assert.match(css, /body > #root main/);
  assert.match(
    css,
    /body > #root main \{\s*position:\s*relative !important;\s*background-color:\s*transparent !important;/,
  );
  assert.doesNotMatch(css, /main\.main-surface/);
  // Current Codex builds use a CSS-module hash for the main viewport's
  // otherwise opaque top fade; keep the stable component-name fragment.
  assert.match(css, /\[class\*="_MainContentTopFade_"\]/);
  assert.match(css, /\[class\*="token-main-surface"\]/);
  assert.doesNotMatch(css, /--bc-panel:/);
  assert.doesNotMatch(css, /--bc-working-main/);
  assert.match(
    css,
    /aside\.app-shell-left-panel[\s\S]{0,200}background:\s*transparent !important;/,
  );
  // New Codex scopes its 65%-opaque wash on a child, not the aside/nav.
  assert.match(css, /#app-shell-sidebar \.sidebar-navigation\s*\{[^}]*background-color:\s*transparent !important;/);
  assert.match(css, /backdrop-filter:\s*none !important;/);
  assert.doesNotMatch(css, /backdrop-filter:\s*blur\(/);
  assert.match(css, /data-bc-dim-user/);
  assert.match(
    css,
    /\[data-bc-dim-user="true"\]\[data-bc-active="true"\] #beauticode-bg-stage::after/,
  );
  assert.match(css, /\[class\*="MainSurface"\]/);
  assert.match(
    css,
    /\[data-bc-video-ready="true"\][\s\S]{0,80}#beauticode-bg-stage[\s\S]{0,40}video \{[\s\S]{0,40}opacity:\s*1 !important;/,
  );
  assert.match(runtime, /if \(videoReady\) \{\s*revealVideo\(\);/);
  assert.match(
    runtime,
    /#beauticode-bg-stage video[\s\S]{0,80}v\.style\.opacity = ""/,
  );
  assert.match(runtime, /setBackgroundTone/);
  assert.match(runtime, /data-bc-tone/);
  assert.match(runtime, /getPlaybackPosition/);
  assert.match(runtime, /seekTo/);
  assert.match(runtime, /startAt/);
  assert.match(runtime, /pendingStartAt/);
  assert.match(runtime, /isTaskOrProjectView/);
  assert.match(runtime, /detectWorking/);
  // Inject must finish apply() before returning; otherwise CDP blob attach
  // races the stage rebuild and every video import fails verify.
  assert.match(runtime, /window\.__BEAUTICODE_BG__ = api;/);
  assert.match(runtime, /return Promise\.resolve\(\)\s*\.then\(apply\)/);
  assert.match(runtime, /beauticode-image-input/);
  assert.match(runtime, /wantImageBlob/);
  assert.match(runtime, /getVideo\(\)\.style\.opacity = ""/);
  assert.match(runtime, /Promise\.resolve\(getVideo\(\)\.play\?\.\(\)\)/);
  assert.match(runtime, /const imageReady =/);
  assert.match(runtime, /const mediaReady = videoEnabled/);
  assert.match(runtime, /waitForImageReady/);
  assert.match(runtime, /Never make the host transparent while a replacement is still decoding/);
  assert.doesNotMatch(
    runtime,
    /Promise\.resolve\(\)\s*\.then\(apply\)\s*\.catch\([\s\S]{0,240}\)\s*;\s*return \{ installed: true/,
  );
  assert.doesNotMatch(runtime, /isAgentBusy/);
  assert.match(css, /#beauticode-bg-stage::before/);
  assert.match(
    css,
    /#beauticode-bg-stage::before \{[\s\S]*?background:\s*none;[\s\S]*?opacity:\s*0;/,
  );
  assert.doesNotMatch(
    css,
    /html\[data-bc-active="true"\]\[data-bc-media="video"\]\s+#beauticode-bg-stage::before/,
  );
  // Light handling must not hinge on theme.js: CSS also matches the host's own
  // appearance attribute, because a stale/missing marker left near-black text on
  // an untreated wallpaper (measured 1.07:1 contrast).
  assert.match(
    css,
    /\[data-bc-resolved-tone="light"\], \[data-theme="light"\], \.light/,
  );
  // No :has() fallback: the tone attribute lives on <html> in every observed
  // Codex build, and document-wide selectors are re-evaluated on each swap.
  assert.doesNotMatch(css, /:has\(> body\[data-theme="light"\]/);
  // Light readability rides on the veil, never on a panel plate: a plate on top
  // of a veil double-dips and hides the wallpaper the user chose, so the reading
  // surfaces carry no fill rule at all.
  assert.match(css, /--bc-scrim-val:\s*var\(--bc-dim, 0\.48\)/);
  assert.doesNotMatch(css, /--bc-reading-min/);
  assert.doesNotMatch(css, /--bc-surface-alpha-pct/);
  assert.doesNotMatch(css, /body > #root main,[\s\S]{0,320}background-color: color-mix/);
  assert.match(css, /--bc-scrim-rgb:\s*255, 255, 255/);
  assert.match(css, /\[data-composer-body\]/);
  // beautiCode's own surfaces carry role=dialog too; the reader must not paint
  // them — by id for already-mounted UI, and by marker for future surfaces.
  assert.match(css, /:not\(\[data-bc-ui\], \[data-bc-ui\] \*,/);
  assert.match(css, /#beauticode-gallery, #beauticode-gallery \*/);
  assert.match(css, /#beauticode-console-pop, #beauticode-console-pop \*/);
  assert.match(css, /--bc-bg-blur/);
  // Blur stays behind an opt-in attribute: a blur filter on the full-window
  // media is a per-frame convolution and must never sit on the default path.
  assert.match(
    css,
    /\[data-bc-blur-user="true"\] #beauticode-bg-stage img[\s\S]{0,240}filter:\s*blur\(var\(--bc-bg-blur\)\)/,
  );
  // Blur must not move or resize the media: an inset offset with a width that
  // cannot follow it shifted the picture and left a bare strip on the right.
  assert.doesNotMatch(css, /\[data-bc-blur-user="true"\][\s\S]{0,200}inset:\s*-/);
  assert.doesNotMatch(css, /\[data-bc-blur-user="true"\][\s\S]{0,200}width:\s*calc\(100% \+/);
  assert.match(css, /--bc-stage-fallback/);
  // The default media path keeps the plain tone filter.
  assert.match(css, /border:\s*0;\s*filter:\s*var\(--bc-video-filter\);/);
  assert.doesNotMatch(css, /rgba\(255,255,255,\.82\)/);
});


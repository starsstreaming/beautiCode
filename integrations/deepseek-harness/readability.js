(() => {
  "use strict";
  // One ordered client entry point (index.mjs concatenates readability.js before
  // client.js); a second evaluation must not append a second stylesheet or reset
  // the live preference. See ADR 0011 for the layered-material contract.
  if (globalThis.BeauticodeReadableSurfaces) return;

  // ---------------------------------------------------------------------------
  // Preferences. Two independent channels plus four advanced steps:
  //
  //   page   页面材质        0-100, default 30   -> [data-global-panel] column
  //   panel  功能面板不透明  0-100, default 100  -> ARIA overlays / composer /
  //                                                pending-interaction cards
  //
  // The panel key is the pre-ADR-0011 `beauticode-readable-surfaces` key; it
  // keeps its old boolean spellings so a user who rolls the plugin back still
  // reads "false" as off. The page and material keys are new; old builds ignore
  // unknown keys.
  // ---------------------------------------------------------------------------
  const STORAGE_KEYS = Object.freeze({
    page: "beauticode-page-material",
    pageBlur: "beauticode-page-blur",
    panel: "beauticode-readable-surfaces",
    alphaStep: "beauticode-material-alpha-step",
    blurStep: "beauticode-material-blur-step",
    maxBlur: "beauticode-material-max-blur",
  });
  const DEFAULTS = Object.freeze({
    page: 30,
    // The page backplate is the default now (t17); only the literal "false"
    // opts out. Pausing while a page-internal overlay is visible is separate.
    pageBlur: true,
    panel: 60,
    alphaStep: 8,
    blurStep: 2,
    maxBlur: 8,
  });
  const KNOWN_KEYS = new Set(Object.values(STORAGE_KEYS));

  const ROOT_ATTR = "data-bc-material-root";
  const LAYER_ATTR = "data-bc-material-layer";
  const LEVEL_ATTR = "data-bc-material-level";
  const DEPTH_ATTR = "data-bc-material-depth";
  const BLUR_ATTR = "data-bc-material-blur";
  const CHAIN_SELECTOR = `[${ROOT_ATTR}],[${LAYER_ATTR}]`;
  const PAGE_SELECTOR = "[data-global-panel]";
  // Host contracts only: semantic roles, data-composer-card, and the inner card
  // of the three pending-interaction panels. Build-generated class hashes are
  // never used. `[data-question-key] > section` paints the inner card, not the
  // transparent frame that owns the side padding.
  //
  // role="tooltip" is deliberately absent: it keeps the host's own tooltip
  // token, background, colour and positioning. Treating it as a page nested
  // layer painted a 38% light plate and rewrote --dsw-alias-tooltip-bg, which
  // produced white-on-white tooltips in the plugin market page.
  const CANDIDATE_SELECTORS = Object.freeze([
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="listbox"]',
    "[data-composer-card]",
    "[data-question-key] > section",
    "[data-plan-review-key] > section",
    "[data-approval-key] > div",
  ]);
  const CANDIDATE_SELECTOR = CANDIDATE_SELECTORS.join(",");
  // Page-internal overlays that must pause the page backplate. Tooltips are
  // included here even though they are not material layers: their absolute
  // positioning and stacking must not be affected by the page root's
  // position:relative/isolation.
  const PAGE_OVERLAY_SELECTOR = [
    '[role="tooltip"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="dialog"]',
    '[role="alertdialog"]',
  ].join(",");
  const PAGE_BLUR_PAUSED_ATTR = "data-bc-page-blur-paused";

  const root = document.documentElement;

  function clampNumber(value, min, max) {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function readNumber(key, min, max, fallback) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return clampNumber(raw, min, max) ?? fallback;
    } catch {
      return fallback;
    }
  }

  // Older builds stored a boolean. "false" must keep meaning "off"; "true" and
  // missing/corrupt storage fall back to the new 60% default. Existing numeric
  // values (for example 35) are preserved, not migrated.
  function readPanelStrength() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEYS.panel);
      if (raw == null || raw === "" || raw === "true") return DEFAULTS.panel;
      if (raw === "false") return 0;
      return clampNumber(raw, 0, 100) ?? DEFAULTS.panel;
    } catch {
      return DEFAULTS.panel;
    }
  }

  // Page blur is on by default. Missing and invalid values read as true; only
  // the literal "false" opts out.
  function readPageBlur() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEYS.pageBlur);
      if (raw === "false") return false;
      return true;
    } catch {
      return true;
    }
  }

  const state = {
    page: readNumber(STORAGE_KEYS.page, 0, 100, DEFAULTS.page),
    pageBlur: readPageBlur(),
    panel: readPanelStrength(),
    alphaStep: readNumber(STORAGE_KEYS.alphaStep, 0, 30, DEFAULTS.alphaStep),
    blurStep: readNumber(STORAGE_KEYS.blurStep, 0, 8, DEFAULTS.blurStep),
    maxBlur: readNumber(STORAGE_KEYS.maxBlur, 0, 16, DEFAULTS.maxBlur),
  };

  function writeValue(key, value) {
    try {
      globalThis.localStorage?.setItem(key, String(value));
    } catch {
      // Storage can be denied; the current page still honors the selection.
    }
  }

  function writePanel(value) {
    // 0 keeps the old "false" spelling so rolling back to a previous plugin
    // version still reads the opt-out instead of re-enabling the plate.
    writeValue(STORAGE_KEYS.panel, value === 0 ? "false" : value);
  }

  function emit(name) {
    if (typeof globalThis.dispatchEvent !== "function") return;
    const CustomEventCtor = globalThis.CustomEvent;
    globalThis.dispatchEvent(
      typeof CustomEventCtor === "function" ? new CustomEventCtor(name) : { type: name },
    );
  }

  // ---------------------------------------------------------------------------
  // Stylesheet. Shape is frozen by ADR 0011 §3.2: the page root only paints a
  // base fill (it must NOT rewrite the surface tokens, or every card on the
  // page would paint its own 30% plate); panel roots and nested layers rewrite
  // the tokens so the whole overlay shares one material. No material root gets
  // a backdrop-filter on itself: the page blur lives on a same-root ::before
  // backplate and only while no page-internal overlay is visible, panels keep
  // their own filter, and nested layers never get one (the outermost filter is
  // the only one the compositor honors; a nested filter would also smuggle blur
  // past maxBlur:0 / 0% - fixture A).
  // ---------------------------------------------------------------------------
  const style = document.createElement("style");
  style.dataset.beauticodeReadability = "true";
  style.textContent = `
html[data-bc-active="true"] body{
  --bc-material-base:var(--dsw-static-neutral-bluish-800,#232833);
  --bc-text-halo:#000;
}
html[data-bc-active="true"][data-bc-resolved-tone="light"] body{
  --bc-material-base:var(--dsw-static-neutral-bluish-00,#fff);
  --bc-text-halo:#fff;
}
/* CSS defaults mirror the storage defaults; JS overrides --bc-material-alpha
   inline with the computed value (page strength, panel strength, or the nested
   step). */
html[data-bc-active="true"] [data-bc-material-root="page"]{--bc-material-alpha:.3;}
html[data-bc-active="true"] [data-bc-material-root="panel"]{--bc-material-alpha:.6;}

/* Page root and nested layers both paint a material fill. A nested layer inside
   a page root is page-channel material, so it must not get its own
   backdrop-filter either. */
html[data-bc-active="true"] [data-bc-material-root],
html[data-bc-active="true"] [data-bc-material-layer]{
  --bc-material-fill:color-mix(in srgb,var(--bc-material-base,#232833) calc(var(--bc-material-alpha,1) * 100%),transparent);
  background-color:var(--bc-material-fill);
}

/* Panel roots and nested layers repaint the seven surface tokens so menus,
   lists and inputs inside the overlay share the same material instead of
   letting the transcript read through. --dsw-alias-tooltip-bg is deliberately
   NOT rewritten: a tooltip must keep the host's tooltip token even when it is
   nested inside a material panel. */
html[data-bc-active="true"] [data-bc-material-root="panel"],
html[data-bc-active="true"] [data-bc-material-layer]{
  --dsw-alias-bg-base:var(--bc-material-fill);
  --dsw-alias-bg-layer-1:var(--bc-material-fill);
  --dsw-alias-bg-layer-2:var(--bc-material-fill);
  --dsw-alias-bg-layer-3:var(--bc-material-fill);
  --dsw-alias-bg-overlay:var(--bc-material-fill);
  --dsw-specific-input-major:var(--bc-material-fill);
  --dsw-specific-menu:var(--bc-material-fill);
}

/* Exactly one backdrop-filter per independent root. Nested layers never match:
   they carry [data-bc-material-layer], not [data-bc-material-root]. */
html[data-bc-active="true"] [data-bc-material-root][data-bc-material-blur="on"]{
  -webkit-backdrop-filter:blur(var(--bc-material-blur,0px));
  backdrop-filter:blur(var(--bc-material-blur,0px));
}
/* The page root itself never owns a backdrop-filter (that would create a fixed
   containing block, V3). It clears the generic panel filter rule; the single
   page blur lives on ::before while the page-backplate rules below match and no
   page-internal overlay has paused it. */
html[data-bc-active="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]{
  -webkit-backdrop-filter:none;
  backdrop-filter:none;
}

/* The page backplate is on by default now. It re-opens the documented side
   effects:
     - position:relative makes the page root the containing block for absolute
       descendants (V9);
     - isolation:isolate traps page-internal high z-index layers under outside
       siblings (V10);
     - the absolute inset:0 backplate scrolls with a scrollable page column and
       stops blurring its last rows (V11).
   The pause flag is the mitigation: JS adds [data-bc-page-blur-paused] to the
   page root while a visible tooltip/menu/listbox/dialog/alertdialog exists
   inside it. The :not() below then drops position/isolation and the pseudo
   element while the 30% alpha fill stays. Both the html flag and the page
   root's [data-bc-material-blur] are required, so page 0%, maxBlur 0 or a
   paused page leave no position/isolation and no pseudo-element behind. Only
   the page root is affected; panel rules are unchanged. */
html[data-bc-active="true"][data-bc-page-blur="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]:not([data-bc-page-blur-paused]){
  position:relative;
  isolation:isolate;
}
html[data-bc-active="true"][data-bc-page-blur="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]:not([data-bc-page-blur-paused])::before{
  content:"";
  position:absolute;
  inset:0;
  z-index:-1;
  pointer-events:none;
  -webkit-backdrop-filter:blur(var(--bc-material-blur,0px));
  backdrop-filter:blur(var(--bc-material-blur,0px));
}

/* Page legibility aids are gated by the page channel, not the panel channel.
   The plugin page is a page: it keeps the translucent surfaces client.js
   publishes, gets the page plate from its [data-global-panel] column, and keeps
   only a tone-aware halo plus one lifted caption tier. Painting the page itself
   reproduced issue #92's slab, so this rule must never regain a fill. */
html[data-bc-active="true"][data-bc-page-material="true"] [data-plugin-panel]{
  --dsw-alias-label-tertiary:var(--dsw-alias-label-secondary);
  --dsw-alias-label-caption:var(--dsw-alias-label-secondary);
  text-shadow:0 1px 2px color-mix(in srgb, var(--bc-text-halo) 45%, transparent);
}
`;
  document.head.append(style);

  // ---------------------------------------------------------------------------
  // DOM helpers. Every write is diffed first: MutationObserver + React churn
  // rescan often, and rewriting an identical attribute/style would both waste
  // work and wake the observer again.
  // ---------------------------------------------------------------------------
  function selectAll(selector) {
    return typeof document.querySelectorAll === "function"
      ? Array.from(document.querySelectorAll(selector))
      : [];
  }

  function setAttribute(element, name, value) {
    if (typeof element?.setAttribute !== "function") return;
    if (value == null) {
      if (typeof element.hasAttribute === "function" && element.hasAttribute(name)) {
        element.removeAttribute(name);
      }
      return;
    }
    const text = String(value);
    if (typeof element.getAttribute === "function" && element.getAttribute(name) === text) return;
    element.setAttribute(name, text);
  }

  function readStyleVar(element, name) {
    return typeof element?.style?.getPropertyValue === "function"
      ? element.style.getPropertyValue(name)
      : null;
  }

  function setStyleVar(element, name, value) {
    if (typeof element?.style?.setProperty !== "function") return;
    if (readStyleVar(element, name) === value) return;
    element.style.setProperty(name, value);
  }

  function removeStyleVar(element, name) {
    if (typeof element?.style?.removeProperty !== "function") return;
    if (readStyleVar(element, name) === "") return;
    element.style.removeProperty(name);
  }

  function idOf(element) {
    return String(element?.id || element?.getAttribute?.("id") || "");
  }

  // beautiCode's own UI never becomes a material layer. The console page lives
  // inside the host settings dialog (which is a normal panel root); the name
  // dialog and gallery chrome must stay out of the candidate set.
  function isOwnUi(element) {
    for (let node = element; node; node = node.parentElement ?? null) {
      if (idOf(node).startsWith("beauticode-")) return true;
    }
    return false;
  }

  // A root only gets a backdrop-filter when it actually covers something. The
  // unit harness has no layout, so a missing rect API reads as visible.
  function isVisuallyCovering(element) {
    if (element?.hidden) return false;
    if (element?.getAttribute?.("aria-hidden") === "true") return false;
    if (typeof element?.getBoundingClientRect !== "function") return true;
    try {
      const rect = element.getBoundingClientRect();
      if (rect && rect.width <= 0 && rect.height <= 0) return false;
    } catch {
      // A detached/hostile node cannot be measured; fail open, CSS still gates.
    }
    return true;
  }

  function clearMaterial(element) {
    setAttribute(element, ROOT_ATTR, null);
    setAttribute(element, LAYER_ATTR, null);
    setAttribute(element, LEVEL_ATTR, null);
    setAttribute(element, DEPTH_ATTR, null);
    setAttribute(element, BLUR_ATTR, null);
    setAttribute(element, PAGE_BLUR_PAUSED_ATTR, null);
    removeStyleVar(element, "--bc-material-alpha");
    removeStyleVar(element, "--bc-material-blur");
  }

  function formatAlpha(value) {
    return String(Number(value.toFixed(4)));
  }

  function formatPx(value) {
    return String(Number(value.toFixed(2)));
  }

  // ---------------------------------------------------------------------------
  // Layering model (ADR 0011 §3.1-§3.4).
  //
  //   page root:  [data-global-panel], level 1, depth 1, panel channel off.
  //   panel root: any candidate with no marked ancestor, level 2, depth 1.
  //   nested:     nearest marked ancestor + 1 level/depth, alpha step only.
  //
  // Desired state is computed first and diffed, so a role change, a portal move
  // or a strength change never leaves a stale mark behind.
  // ---------------------------------------------------------------------------
  let lastBlur = { page: 0, panel: 0 };

  // Ownership is resolved against the desired set, not the live attributes: on
  // the very first scan the page root has not been written yet, and after a role
  // or channel change a stale attribute must not freeze a child at the wrong
  // depth. Walking the parent chain is O(depth) and only runs for candidates.
  function nearestDesiredAncestor(element, desired) {
    for (let node = element.parentElement ?? null; node; node = node.parentElement ?? null) {
      if (desired.has(node)) return node;
    }
    return null;
  }

  function desiredLayers() {
    const desired = new Map();
    if (root.dataset?.bcActive !== "true") return desired;

    if (state.page > 0) {
      for (const element of selectAll(PAGE_SELECTOR)) {
        if (!isVisuallyCovering(element)) continue;
        desired.set(element, { kind: "page", root: true, level: 1, depth: 1 });
      }
    }

    if (state.panel > 0) {
      for (const element of selectAll(CANDIDATE_SELECTOR)) {
        if (desired.has(element)) continue;
        // The shell.overlay container is a sibling layer of the page column,
        // not a material root; its role children are still judged normally.
        if (element.hasAttribute?.("data-shell-overlay")) continue;
        if (isOwnUi(element)) continue;
        const owner = nearestDesiredAncestor(element, desired);
        if (!owner) {
          desired.set(element, { kind: "panel", root: true, level: 2, depth: 1, pageInternal: false });
          continue;
        }
        const ownerInfo = desired.get(owner);
        // A standard role inside the page column is a panel, not a page nested
        // layer: it must use the panel strength (default 60%) and must never
        // inherit page alpha. It is alpha-only (no backdrop-filter), so a menu
        // or dialog inside a page cannot pick up another containing block.
        if (ownerInfo.kind === "page") {
          desired.set(element, { kind: "panel", root: true, level: 2, depth: 1, pageInternal: true });
          continue;
        }
        desired.set(element, {
          kind: ownerInfo.kind,
          root: false,
          level: ownerInfo.level + 1,
          depth: ownerInfo.depth + 1,
          pageInternal: ownerInfo.pageInternal === true,
        });
      }
    }

    return desired;
  }

  /** True when a visible standard overlay lives inside the page column. */
  function pageHasVisibleOverlay(pageRoot) {
    if (typeof pageRoot.querySelectorAll !== "function") return false;
    for (const overlay of pageRoot.querySelectorAll(PAGE_OVERLAY_SELECTOR)) {
      if (isOwnUi(overlay)) continue;
      if (isVisuallyCovering(overlay)) return true;
    }
    return false;
  }

  function applyMaterial(element, info, pageBlur, panelBlur) {
    const baseAlpha = (info.kind === "page" ? state.page : state.panel) / 100;
    // The ramp is fixed: each deeper level is more opaque (越上层越实). There
    // is no direction preference any more; the old storage key is ignored.
    let alpha = baseAlpha;
    if (!info.root) {
      alpha = baseAlpha + ((info.depth - 1) * state.alphaStep) / 100;
    }
    alpha = Math.min(1, Math.max(0, alpha));

    setAttribute(element, ROOT_ATTR, info.root ? info.kind : null);
    setAttribute(element, LAYER_ATTR, info.root ? null : "");
    setAttribute(element, LEVEL_ATTR, info.level);
    setAttribute(element, DEPTH_ATTR, info.depth);
    setStyleVar(element, "--bc-material-alpha", formatAlpha(alpha));

    // The page blur is on by default; the pause flag (not this marker) switches
    // the CSS side effects off while a page-internal overlay is visible.
    const pageBlurActive = info.kind === "page" && state.pageBlur;
    const blur = info.root
      ? (info.kind === "page" ? (pageBlurActive ? pageBlur : 0) : (info.pageInternal ? 0 : panelBlur))
      : 0;
    if (info.root && blur > 0 && isVisuallyCovering(element)) {
      setAttribute(element, BLUR_ATTR, "on");
      setStyleVar(element, "--bc-material-blur", `${formatPx(blur)}px`);
    } else {
      setAttribute(element, BLUR_ATTR, null);
      removeStyleVar(element, "--bc-material-blur");
    }
  }

  function scan() {
    let desired = desiredLayers();

    // Clear stale marks first, then recompute once: a stale root/layer would
    // otherwise be picked up as the owner of a still-visible child and freeze
    // the wrong depth. The second pass is nearly free and only runs when
    // something was actually removed.
    let cleared = 0;
    for (const element of selectAll(CHAIN_SELECTOR)) {
      if (desired.has(element)) continue;
      clearMaterial(element);
      cleared += 1;
    }
    if (cleared > 0) desired = desiredLayers();

    // Page-internal tooltips/menus/lists/dialogs pause the page backplate: the
    // position:relative/isolation pair would otherwise move or trap them. The
    // pause flag lives on the page root; panel roots stay materialized.
    const pageRoots = [];
    for (const [element, info] of desired) {
      if (info.kind === "page" && info.root) pageRoots.push(element);
    }
    const pausedRoots = new Set();
    for (const pageRoot of pageRoots) {
      const paused = state.pageBlur && state.page > 0 && pageHasVisibleOverlay(pageRoot);
      setAttribute(pageRoot, PAGE_BLUR_PAUSED_ATTR, paused ? "" : null);
      if (paused) pausedRoots.add(pageRoot);
    }

    // The page-strength scale I feeds the panel's sqrt radius independently of
    // whether the page blur is actually painted. getBlur().page reports only
    // the radius actually applied (0 when off, page 0% or paused).
    const pageRooted = pageRoots.length > 0;
    const base = pageRooted ? (state.page / 100) * state.maxBlur : 0;
    const pageBlur = pageRooted ? base : 0;
    const target = Math.min(state.maxBlur, base + state.blurStep);
    // Cross-root composition is sqrt(s1^2 + s2^2) = target (fixture B), so the
    // panel's own radius is sqrt(target^2 - base^2), not target - base.
    const panelBlur = Math.max(0, Math.sqrt(Math.max(0, target * target - base * base)));
    const appliedPageBlur = pageRooted && state.pageBlur
      && pageRoots.some((pageRootEl) => !pausedRoots.has(pageRootEl))
      ? pageBlur
      : 0;
    lastBlur = { page: Number(appliedPageBlur.toFixed(2)), panel: Number(panelBlur.toFixed(2)) };

    for (const [element, info] of desired) {
      applyMaterial(element, info, pageBlur, panelBlur);
    }
    return desired;
  }

  function publishFlags() {
    if (root.dataset) {
      root.dataset.bcReadableSurfaces = state.panel > 0 ? "true" : "false";
      if (state.page > 0) root.dataset.bcPageMaterial = "true";
      else delete root.dataset.bcPageMaterial;
      // Page blur is on by default; the CSS also requires the page root's blur
      // marker, so page 0% or maxBlur 0 never leave position/isolation behind.
      if (state.pageBlur && state.page > 0) root.dataset.bcPageBlur = "true";
      else delete root.dataset.bcPageBlur;
    }
    if (state.panel > 0) setStyleVar(root, "--bc-readable-strength", String(state.panel));
    else removeStyleVar(root, "--bc-readable-strength");
    // Published even at 0 so the console and tests read the same value the
    // material actually used; the data-* flags above gate the CSS.
    setStyleVar(root, "--bc-page-material-strength", String(state.page));
    setStyleVar(root, "--bc-material-alpha-step", String(state.alphaStep));
    setStyleVar(root, "--bc-material-blur-step", String(state.blurStep));
    setStyleVar(root, "--bc-material-max-blur", String(state.maxBlur));
  }

  function apply(options = {}) {
    const { panelChanged = false, notify = true } = options;
    publishFlags();
    scan();
    if (!notify) return;
    emit("beauticode-material-change");
    if (panelChanged) emit("beauticode-readability-change");
  }

  // ---------------------------------------------------------------------------
  // MutationObserver. Scans are coalesced into one animation frame and ignore
  // our own attribute/style writes, so marking the DOM cannot feed itself.
  // ---------------------------------------------------------------------------
  let scanQueued = false;

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    const run = () => {
      scanQueued = false;
      scan();
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(run);
      return;
    }
    if (typeof globalThis.setTimeout === "function") {
      globalThis.setTimeout(run, 0);
      return;
    }
    run();
  }

  const MutationObserverCtor = globalThis.MutationObserver;
  if (typeof MutationObserverCtor === "function" && root) {
    const observer = new MutationObserverCtor((records) => {
      for (const record of records) {
        // data-bc-material-* and style are never in attributeFilter; keep this
        // guard for hosts that widen it. Everything else may change the layer
        // model (role, anchors, mounting, background activation).
        if (record?.type === "attributes") {
          const name = record.attributeName || "";
          if (name.startsWith("data-bc-material-") || name === "style") continue;
        }
        scheduleScan();
        return;
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "role",
        "data-global-panel",
        "data-composer-card",
        "data-question-key",
        "data-plan-review-key",
        "data-approval-key",
        "data-shell-overlay",
        "data-bc-active",
        "hidden",
        "aria-hidden",
      ],
    });
  }

  apply({ panelChanged: true });

  function materialSnapshot() {
    return {
      alphaStep: state.alphaStep,
      blurStep: state.blurStep,
      maxBlur: state.maxBlur,
    };
  }

  function refresh() {
    publishFlags();
    scan();
    return { page: lastBlur.page, panel: lastBlur.panel };
  }

  // Public surface shared with console.js (t3) and the tests. Panel strength
  // keeps the historical get/set names; everything else is additive.
  globalThis.BeauticodeReadableSurfaces = {
    defaults: DEFAULTS,
    storageKeys: STORAGE_KEYS,
    // Panel material strength, 0-100. Booleans are accepted for the old switch.
    get: () => state.panel,
    set(value) {
      const next = typeof value === "boolean"
        ? (value ? DEFAULTS.panel : 0)
        : clampNumber(value, 0, 100);
      if (next == null) return state.panel;
      state.panel = next;
      writePanel(next);
      apply({ panelChanged: true });
      return state.panel;
    },
    // Page material strength, 0-100. 0 is written as "0" (new key, no legacy).
    getPage: () => state.page,
    setPage(value) {
      const next = clampNumber(value, 0, 100);
      if (next == null) return state.page;
      state.page = next;
      writeValue(STORAGE_KEYS.page, next);
      apply();
      return state.page;
    },
    getMaterial: materialSnapshot,
    // Page backplate, on by default. Missing/invalid storage reads as true;
    // only the literal "false" switches it off. Page-internal overlays pause it
    // through [data-bc-page-blur-paused] without changing this preference.
    getPageBlur: () => state.pageBlur,
    setPageBlur(value) {
      const next = value === true || value === "true";
      state.pageBlur = next;
      writeValue(STORAGE_KEYS.pageBlur, next ? "true" : "false");
      apply();
      return state.pageBlur;
    },
    // Partial update: {alphaStep?, blurStep?, maxBlur?}. Invalid numbers keep
    // the current value. Unknown keys (including the retired "direction" and
    // the old "beauticode-material-direction" storage key) are ignored.
    setMaterial(patch) {
      if (!patch || typeof patch !== "object") return materialSnapshot();
      if (patch.alphaStep !== undefined) {
        const next = clampNumber(patch.alphaStep, 0, 30);
        if (next != null) {
          state.alphaStep = next;
          writeValue(STORAGE_KEYS.alphaStep, next);
        }
      }
      if (patch.blurStep !== undefined) {
        const next = clampNumber(patch.blurStep, 0, 8);
        if (next != null) {
          state.blurStep = next;
          writeValue(STORAGE_KEYS.blurStep, next);
        }
      }
      if (patch.maxBlur !== undefined) {
        const next = clampNumber(patch.maxBlur, 0, 16);
        if (next != null) {
          state.maxBlur = next;
          writeValue(STORAGE_KEYS.maxBlur, next);
        }
      }
      apply();
      return materialSnapshot();
    },
    // Radii actually applied, in px. page is 0 by default (alpha-only) and 2.4
    // only while the opt-in page blur is on; panel is the independent-overlay
    // radius (3.69 on a page, 2 in the main conversation).
    getBlur: () => ({ page: lastBlur.page, panel: lastBlur.panel }),
    // Synchronous rescan, no events: for hosts that reparent outside the
    // observed attribute set.
    refresh,
  };

  globalThis.addEventListener?.("storage", (event) => {
    const key = event?.key;
    if (key != null && !KNOWN_KEYS.has(key)) return;
    const previousPanel = state.panel;
    state.page = readNumber(STORAGE_KEYS.page, 0, 100, DEFAULTS.page);
    state.pageBlur = readPageBlur();
    state.panel = readPanelStrength();
    state.alphaStep = readNumber(STORAGE_KEYS.alphaStep, 0, 30, DEFAULTS.alphaStep);
    state.blurStep = readNumber(STORAGE_KEYS.blurStep, 0, 8, DEFAULTS.blurStep);
    state.maxBlur = readNumber(STORAGE_KEYS.maxBlur, 0, 16, DEFAULTS.maxBlur);
    apply({ panelChanged: state.panel !== previousPanel });
  });
})();

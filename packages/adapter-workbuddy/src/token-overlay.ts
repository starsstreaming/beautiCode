/**
 * Token-layer unification.
 *
 * WorkBuddy paints its surfaces through SEVERAL token families — `--wb-*`
 * (shell), `--cb-*` (legacy chat), `--cr-*` (conversation renderer), `--sk-*`
 * (an embedded sub-app) — referenced by ~2370 style rules. Enumerating those
 * selectors is hopeless, so we unify at the token layer instead: read each
 * surface token's base colour out of the live stylesheets (light and dark) and
 * re-declare it as a translucent derivative of itself.
 *
 * This is the same mechanism the official skin system uses, which is why it is
 * safe: we key the override on the theme selectors the host itself uses, so a
 * theme switch selects the matching block instead of fighting our values.
 *
 * Measured on WorkBuddy 5.5.6: 148 light + 88 dark token overrides cover the
 * whole UI, leaving only hard-coded colours (see FLATTEN_SELECTORS for those).
 *
 * Re-measured on WorkBuddy 5.6.2: the host moved its theme token declarations
 * from `html` down to `body` (`body[data-vscode-theme-name="…"]`, `body.dark`,
 * plain `body`). Custom properties resolve to the NEAREST declaration, so an
 * html-level override loses for everything in the body subtree no matter how
 * important it is — measured flip point is exactly the BODY→HTML boundary
 * (`--cb-sidebar-bg`: html = color-mix 45%, body = #1f1f1f). The overlay therefore
 * mirrors every block at body scope too (see DEFAULT_*_SELECTOR).
 */

import { parseColorAlpha } from "./color.js";

/**
 * Surface tokens we want. Kept as a source string so the page-side scan reuses it.
 *
 * Coverage MUST include `--vscode-*`: WorkBuddy is VS Code-derived and most of
 * its feature pages (新建任务 / 助理 / 项目 / 专家 / 定时任务 / 资料库) paint with
 * VS Code design tokens, not with `--wb-*`. `--qad-*` and `--ic-*` are two more
 * families found by the static sweep. The trailing alternative catches any other
 * prefix whose name itself ends in a surface word.
 *
 * 5.6.2 adds `--sc-*` (declared on `:root[data-sc-color-scheme="dark"]`, e.g.
 * `--sc-bg-grey_background: #3a3a3a`): same surface role, so the family joins
 * the include list — measured painting the industry-template switcher button
 * and, through it, parts of the sidebar that stayed opaque after the body-scope
 * fix.
 */
export const TOKEN_INCLUDE_PATTERN =
  "(^--(vscode|wb|cb|cr|sk|dui|qad|ic|sc)-[a-z0-9-]*(bg|background|surface|panel|card|modal|elevated|bubble)|^--[a-z0-9-]+-(bg|background|surface)$|^--[a-z0-9-]*(bg|background)-[a-z0-9-]*$)";

/**
 * Interaction states, chrome, non-colour tokens AND paired foreground colours
 * must keep their official values.
 *
 * The `fg`/`foreground`/`icon` entries matter a lot: tokens like
 * `--wb-bg-primary-fg` are TEXT colours that merely share the `bg` prefix. Making
 * them translucent would render the text invisible — caught by a unit test.
 *
 * `button-primary` excludes brand/primary button colours. Neutral button
 * backgrounds join the overlay: 5.6.2 paints them opaque and they are plain
 * surfaces (measured leaks: `--wb-button-secondary-bg` #262626 on
 * `wb-button--secondary`, `--cb-input-button-background` #3a3a3a on the same
 * button — its rule is `.cb-button--secondary`, not the `--wb-*` token).
 * Saturated accents stay protected by the overlay's opaque-base rule.
 *
 * NOTE — `hover` / `active` / `selected` / `open` are deliberately NOT excluded:
 * the host uses tokens such as `--wb-bg-hover-light` as the *resting* background
 * of real panels (measured on `.artifact-slot-panel__card`), so excluding them
 * left those panels solid. A hover tint rendered translucent over a translucent
 * surface still reads as a tint.
 */
export const TOKEN_EXCLUDE_PATTERN =
  "disabled|focus|scrollbar|thumb|border|shadow|text|color-|brand|progress|button-primary|foreground|inverse|mask|z-index|width|height|radius|gap|padding|font|size|weight|line|opacity|track|(^|-)(fg|icon|label|placeholder)($|-)|(^|-)on-";

/**
 * Every token override is emitted with `!important`.
 *
 * Without it the host's own, more specifically scoped declaration wins on the
 * element: `--cr-bg-elevated` is redefined closer to the composer, so a plain
 * `html:root` override left the composer solid white while the token *looked*
 * overridden when read at the root.
 */
export const TOKEN_IMPORTANT = true;

export interface TokenSurfaceRow {
  token: string;
  /** Base value as declared for the light theme. */
  lightValue: string;
  /** Base value as declared for the dark theme, when present. */
  darkValue: string | null;
}

export interface TokenOverlayOptions {
  /** Shared opacity for every surface token. */
  alpha?: number;
  /** Override the light-theme selector list (defaults to `:root`). */
  lightSelector?: string;
  /** Override the dark-theme selector list. */
  darkSelector?: string;
}

export const DEFAULT_TOKEN_ALPHA = 0.82;

/** id of the injected token-overlay <style>, needed by the style keeper. */
export const TOKEN_OVERLAY_STYLE_ID = "beauticode-token-overlay";

/**
 * The host injects its theme sheet dynamically, so an override that merely ties
 * on specificity can lose when the theme sheet lands after ours. `html:root`
 * (0,1,1) beats a bare `:root`/`.light` (0,1,0) regardless of order, and
 * `html:root.dark` (0,2,1) beats everything the host uses for dark.
 *
 * Since 5.6.2 the host ALSO declares at body level, which html-level rules can
 * never out-reach (inheritance picks the nearest declaration). The body-scope
 * mirrors are gated on the same html theme classes we already key everything
 * else to, so light/dark stay mutually exclusive:
 * - dark  : `html.dark body` (0,1,2) > host `body[data-vscode-theme-name=…]` (0,1,1)
 * - light : `html:not(.dark):not(.cb-dark) body` (0,2,2) > host light/neutral body
 * Both carry !important, and neither can ever match at the same time.
 */
const DEFAULT_LIGHT_SELECTOR =
  "html:root,html:not(.dark):not(.cb-dark) body";
const DEFAULT_DARK_SELECTOR =
  'html:root.dark,html:root.cb-dark,html.dark,html.cb-dark,body[data-theme="dark"],[data-theme="dark"],html.dark body,html.cb-dark body';

/**
 * Build the overlay CSS from a token scan.
 *
 * Only tokens whose base colour is opaque are overridden: an already-translucent
 * base (a hover tint, a 5% wash) must stay as authored, otherwise repeated
 * application would keep fading it.
 */
export function buildTokenOverlayCss(
  rows: readonly TokenSurfaceRow[],
  options: TokenOverlayOptions = {},
): string {
  const alpha = options.alpha ?? DEFAULT_TOKEN_ALPHA;
  const pct = Math.round(alpha * 1000) / 10;
  const lightSelector = options.lightSelector ?? DEFAULT_LIGHT_SELECTOR;
  const darkSelector = options.darkSelector ?? DEFAULT_DARK_SELECTOR;

  const light: string[] = [];
  const dark: string[] = [];
  const bang = TOKEN_IMPORTANT ? " !important" : "";
  for (const row of rows) {
    if (!row.token.startsWith("--")) continue;
    if (parseColorAlpha(row.lightValue) === 1) {
      light.push(`${row.token}:color-mix(in srgb, ${row.lightValue} ${pct}%, transparent)${bang};`);
    }
    if (row.darkValue !== null && parseColorAlpha(row.darkValue) === 1) {
      dark.push(`${row.token}:color-mix(in srgb, ${row.darkValue} ${pct}%, transparent)${bang};`);
    }
  }

  const parts: string[] = [];
  if (light.length) parts.push(`${lightSelector}{${light.join("")}}`);
  if (dark.length) parts.push(`${darkSelector}{${dark.join("")}}`);
  return parts.join("");
}

/**
 * Page-side scan, shipped as a string because it runs inside the host page.
 * Returns JSON: `{ rows, theme, lightCount, darkCount }`.
 *
 * Three hard-won lessons are baked in here:
 *
 * 1. **Read the CURRENT computed value, not the stylesheet declaration.**
 *    Several families (`--cr-*`) are dark-first: their `:root` declaration holds
 *    a dark colour that is only correct in the dark theme. Deriving the light
 *    overlay from declared values therefore produced dark-tinted "light"
 *    surfaces. `getComputedStyle` always yields the value for the ACTIVE theme,
 *    so the overlay is regenerated on a theme switch instead of shipping two
 *    baked blocks.
 *
 * 2. **Aliases must be followed.** The semantic layer is almost entirely aliases
 *    (`--wb-bg-primary: var(--wb-palette-white-100)`); a scan that only accepts
 *    literals skips whole families — that is how the settings dialog stayed
 *    solid through the first attempt. Computed values resolve the chain for us.
 *
 * 3. **Never touch foreground tokens.** `--wb-bg-primary-fg` merely has `bg` in
 *    its name; overriding it makes text invisible. Guarded by unit test.
 */
export const TOKEN_SCAN_EXPRESSION = `(() => {
  const INCLUDE = new RegExp(${JSON.stringify(TOKEN_INCLUDE_PATTERN)}, "i");
  const EXCLUDE = new RegExp(${JSON.stringify(TOKEN_EXCLUDE_PATTERN)}, "i");
  const LITERAL = /^(#|rgb|hsl|color\\(|white$|black$)/i;
  const VAR_RE = /^var\\(\\s*(--[a-z0-9-]+)\\s*(?:,\\s*([^)]*))?\\)$/i;

  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  const isDarkTheme = /(^|\\s)(dark|cb-dark)(\\s|$)/.test(root.className);

  // Buckets by selector intent. The neutral bucket holds theme-agnostic
  // declarations (":root", "body"); several families such as --cr-* are
  // DARK-FIRST there, so a neutral value must never outrank a matching
  // light/dark declaration.
  const lightOnly = new Map();
  const darkOnly = new Map();
  const neutral = new Map();
  const names = new Set();

  for (const sheet of document.styleSheets) {
    // NEVER read our own sheets: a re-apply would otherwise consume the overlay
    // it wrote last time, re-mixing color-mix values and drifting on every run.
    const ownerId = sheet.ownerNode && sheet.ownerNode.id ? String(sheet.ownerNode.id) : "";
    if (ownerId.startsWith("beauticode")) continue;
    let list = null;
    try { list = sheet.cssRules; } catch { continue; }
    // 5.6.2 nests palettes inside @layer / @media / @supports and inside nested
    // style rules; a top-level-only walk missed whole families
    // (--wb-button-secondary-bg was measured missing). Walk recursively.
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.style) {
          const sel = rule.selectorText || "";
          const hasLight = /light/i.test(sel);
          const hasDark = /(dark|cb-dark)/i.test(sel);
          const bucket = hasLight && !hasDark ? lightOnly : hasDark && !hasLight ? darkOnly : neutral;
          for (const prop of rule.style) {
            if (!prop.startsWith("--")) continue;
            names.add(prop);
            const value = rule.style.getPropertyValue(prop).trim();
            if (value && !bucket.has(prop)) bucket.set(prop, value);
          }
        }
        if (rule.cssRules) { try { visit(rule.cssRules); } catch { /* opaque sheet */ } }
      }
    };
    visit(list);
  }

  const ORDER = {
    light: [lightOnly, neutral, darkOnly],
    dark: [darkOnly, neutral, lightOnly],
  };

  const resolve = (name, order, depth) => {
    if (depth > 8) return null;
    let declared;
    for (const map of order) {
      if (map.has(name)) { declared = map.get(name); break; }
    }
    if (declared === undefined) return null;
    const asVar = VAR_RE.exec(declared);
    if (!asVar) return LITERAL.test(declared) ? declared : null;
    const viaAlias = resolve(asVar[1], order, depth + 1);
    if (viaAlias !== null) return viaAlias;
    const fallback = asVar[2] ? asVar[2].trim() : "";
    return fallback && LITERAL.test(fallback) ? fallback : null;
  };

  // BOTH themes are emitted, so a theme switch needs no re-injection
  // (the host's own <html class> picks the right block).
  const currentPref = isDarkTheme ? "dark" : "light";
  const rows = [];
  let unresolved = 0;
  let viaComputed = 0;
  for (const token of names) {
    if (!INCLUDE.test(token) || EXCLUDE.test(token)) continue;
    // The computed value at :root is authoritative for the ACTIVE theme and has
    // aliases resolved; use it for the block we are actually in.
    const computed = rootStyle.getPropertyValue(token).trim();
    const useComputed = computed && LITERAL.test(computed);
    const lightValue = currentPref === "light" && useComputed
      ? computed
      : resolve(token, ORDER.light, 0);
    const darkValue = currentPref === "dark" && useComputed
      ? computed
      : resolve(token, ORDER.dark, 0);
    if (useComputed && currentPref === "light") viaComputed++;
    if (lightValue === null && darkValue === null) { unresolved++; continue; }
    rows.push({
      token,
      lightValue: lightValue ?? darkValue,
      darkValue: darkValue ?? null,
    });
  }
  return JSON.stringify({
    rows,
    theme: root.className,
    isDarkTheme,
    lightCount: rows.length,
    darkResolved: rows.filter((r) => r.darkValue !== null).length,
    viaComputed,
    unresolved,
    totalNames: names.size,
  });
})()`;

/* ------------------------------------------------------------------ *
 * Hard-coded surfaces — the part a token overlay can never reach
 * ------------------------------------------------------------------ */

/**
 * 67 opaque surface rules on 5.5.6 declare a literal colour instead of a token,
 * so no token override can reach them (they are what kept the feature pages
 * solid). Most are *neutral* greys/whites — panel chrome that should simply look
 * like the app surface at our alpha. The rest are saturated brand colours
 * (buttons, logos, category swatches, QR codes, the terminal) and MUST keep
 * their colour: turning them translucent destroys meaning.
 *
 * So the sweep keeps only NEUTRAL hard-coded surfaces and rewrites them to a
 * translucent derivative of an official surface token, which stays theme-aware.
 */
export const HARDCODED_NEUTRAL_MAX_CHROMA = 24;

/** Never neutralise these: they carry identity or semantics. */
export const HARDCODED_SURFACE_SKIP_SELECTOR =
  "button|btn|logo|qr|avatar|swatch|dot|tag|chip|badge|fab|xterm|terminal|hljs|markdown-preview|brand|primary|danger|error|success|warning|selected|active|hover|focus|overlay|scrim|caret";

/** Base token the neutralised panels are derived from (theme-aware). */
export const HARDCODED_SURFACE_BASE_TOKEN = "--wb-bg-primary";
export const HARDCODED_SURFACE_BASE_FALLBACK = "#ffffff";

export interface HardcodedSurfaceOptions {
  alpha?: number;
  baseToken?: string;
  baseFallback?: string;
}

/**
 * Emit one rule for a list of hard-coded surface selectors. Grouped on purpose:
 * one declaration list, N selectors, so the injected sheet stays small.
 */
export function buildHardcodedSurfaceCss(
  selectors: readonly string[],
  options: HardcodedSurfaceOptions = {},
): string {
  const clean = [...new Set(selectors.map((s) => s.trim()).filter((s) => s.length > 0))];
  if (!clean.length) return "";
  const alpha = options.alpha ?? DEFAULT_TOKEN_ALPHA;
  const pct = Math.round(alpha * 1000) / 10;
  const token = options.baseToken ?? HARDCODED_SURFACE_BASE_TOKEN;
  const fallback = options.baseFallback ?? HARDCODED_SURFACE_BASE_FALLBACK;
  return `${clean.join(",")}{background-color:color-mix(in srgb, var(${token}, ${fallback}) ${pct}%, transparent) !important;}`;
}

/**
 * Page-side sweep for hard-coded neutral surfaces. Returns
 * `{ selectors: string[], skippedSaturated: number }`.
 */
export const HARDCODED_SURFACE_SCAN_EXPRESSION = `(() => {
  const SKIP = new RegExp(${JSON.stringify(HARDCODED_SURFACE_SKIP_SELECTOR)}, "i");
  const LITERAL = /^(#[0-9a-f]{3,8}|rgba?\\(|hsla?\\()/i;
  // We no longer require the selector to look like a "panel": the feature pages
  // use arbitrary route/page/feature class names, and a missed name means a
  // solid white page. Safety comes from SKIP plus the chroma test instead.
  const NEVER = /^(html|body|#root)$|::|::-webkit|scrollbar/i;

  const chromaOf = (value) => {
    let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
    if (m) {
      const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
      return Math.max(r, g, b) - Math.min(r, g, b);
    }
    m = /^rgba?\\(([^)]+)\\)$/.exec(value.trim());
    if (m) {
      const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
      if (p.length >= 3) return Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
    }
    return null;
  };
  const alphaOf = (value) => {
    const m = /^rgba\\(([^)]+)\\)$/i.exec(value.trim());
    if (!m) return 1;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return p.length > 3 ? p[3] : 1;
  };

  const selectors = [];
  let skippedSaturated = 0;
  let skippedNever = 0;
  const seen = new Set();

  for (const sheet of document.styleSheets) {
    const ownerId = sheet.ownerNode && sheet.ownerNode.id ? String(sheet.ownerNode.id) : "";
    if (ownerId.startsWith("beauticode")) continue; // never consume our own sheet
    let list = null; try { list = sheet.cssRules; } catch { continue; }
    // Same nested walk as the token scan, and the value comes from cssText:
    // declarations like "background: var(--x)" serialise to "" through
    // getPropertyValue on 5.6.2 (measured), which hid whole surfaces.
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText && rule.style) {
          const sel = rule.selectorText;
          if (NEVER.test(sel) || SKIP.test(sel)) skippedNever++;
          else {
            const mVal = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(rule.style.cssText || "");
            const raw = mVal ? mVal[1].trim() : "";
            if (raw && LITERAL.test(raw) && alphaOf(raw) >= 0.95) {
              const chroma = chromaOf(raw);
              if (chroma === null || chroma > ${HARDCODED_NEUTRAL_MAX_CHROMA}) skippedSaturated++;
              else if (!seen.has(sel)) { seen.add(sel); selectors.push(sel); }
            }
          }
        }
        if (rule.cssRules) { try { visit(rule.cssRules); } catch { /* opaque sheet */ } }
      }
    };
    visit(list);
  }
  return JSON.stringify({ selectors, skippedSaturated, skippedNever });
})()`;

/* ------------------------------------------------------------------ *
 * Style keeper
 * ------------------------------------------------------------------ */

/**
 * The host appends `<style>` / `<link rel="stylesheet">` nodes to `<head>` at
 * runtime (328 children measured, 97 of them after our first style node). At
 * equal specificity and importance, the LATER declaration wins, so our sheet
 * must stay at the end or the host quietly takes the cascade back — that is how
 * feature pages stayed solid while the injection was demonstrably present.
 *
 * This keeps our nodes last, moving them only when a stylesheet actually lands
 * after ours (so it cannot loop by fighting its own move).
 */
export function buildStyleKeeperExpression(ids: readonly string[]): string {
  return `(() => {
  const ids = ${JSON.stringify(ids)};
  const KEY = "__bcKeepStylesLast";
  window[KEY]?.stop?.();
  const isSheetNode = (el) =>
    el.tagName === "STYLE" || (el.tagName === "LINK" && (el.rel || "").toLowerCase() === "stylesheet");
  const keep = () => {
    const head = document.head;
    if (!head) return 0;
    const kids = [...head.children];
    const nodes = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!nodes.length) return 0;
    const last = nodes[nodes.length - 1];
    const after = kids.slice(kids.indexOf(last) + 1).filter(isSheetNode);
    if (!after.length) return 0;
    for (const node of nodes) head.appendChild(node);
    return after.length;
  };
  let timer = 0;
  let moved = 0;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => { moved += keep(); }, 120);
  });
  observer.observe(document.head, { childList: true });
  moved += keep();
  window[KEY] = { keep, stop: () => { observer.disconnect(); clearTimeout(timer); }, moved: () => moved };
  return "keeper-installed";
})()`;
}

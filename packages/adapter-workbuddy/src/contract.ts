/**
 * The WorkBuddy CSS/DOM contract, as data.
 *
 * Everything here was measured against WorkBuddy 5.5.6 / Chromium 138 on macOS.
 * See docs/host-adapter-workbuddy.md §4 and §5.
 *
 * Division of labour (decided 2026-09-18, "rule B"):
 *   the official appearance owns COLOURS; beautiCode owns TRANSPARENCY and
 *   CONTRAST. We therefore never override theme variables — we only decide
 *   whether a surface is opaque, and how much scrim sits over the media.
 *
 * Style rule (decided 2026-09-18, after the user reported a mixed look):
 *   every floating layer shares ONE opacity; a visual group carries its alpha on
 *   its outermost container and nothing inside it draws a fill of its own.
 *   Two alpha layers stacked read as solid, which is exactly the "container is
 *   translucent but its content is opaque" mess we had.
 */

export const STAGE_ID = "beauticode-bg-stage";
export const STYLE_ID = "beauticode-contract-style";
export const SCRIM_VAR = "--bc-scrim";
export const SURFACE_ALPHA_VAR = "--bc-surface-alpha";
/** Our own neutral base colour for explicit surface rules. */
export const SURFACE_BASE_VAR = "--bc-surface-base";

/**
 * Neutral base per theme, measured from the host's own surfaces. Explicit rules
 * derive their translucency from THIS (an opaque value we own) instead of from a
 * host token — that is what keeps one alpha layer from compounding into
 * 0.82 × 0.82 ≈ 0.67 on surfaces the token overlay also touches.
 */
export const SURFACE_BASE_BY_THEME: Readonly<Record<"dark" | "light", string>> = Object.freeze({
  light: "#ffffff",
  dark: "#1f1f1f",
});

/**
 * One opacity for every floating surface — sidebar, composer, cards, bubbles,
 * right-hand panel. Measured to stay readable for dense text over a mid-tone
 * wallpaper while still showing it through.
 */
export const SURFACE_ALPHA = 0.82;

/** Wallpaper area: fully transparent so the media is unobstructed. */
export const BACKDROP_SELECTORS = Object.freeze([
  // 100% — outermost shell
  ".teams-container",
  // 77% — conversation main area
  ".conversation-shell",
  // centre view item (the sidebar one is re-opaqued by SURFACE_RULES below)
  '[class*="_gridViewItem_"]',
  '[class*="_gridView_"]',
  '[class*="_grid_"]',
  ".teams-content-wrapper",
  ".teams-main-content",
  ".teams-grid-scroll-content",
  ".conversation-page-chrome",
  // sidebar list body: the sidebar PANEL carries the alpha
  ".conversation-list",
]);

/**
 * Floating surfaces and the official token each one reads. Tokens must stay
 * per-entry: `.cr-code-like-box` and `.cr-tool-exp__content` do not read the
 * same variable, so a shared token would repaint one of them.
 */
export interface SurfaceRule {
  selector: string;
  token: string;
  fallback: string;
  note: string;
}

export const SURFACE_RULES: readonly SurfaceRule[] = Object.freeze([
  {
    // The sidebar is a panel: it keeps the unified alpha.
    selector: '.teams-container [data-view-id="sidebar"]',
    token: "--wb-home-bg-primary",
    fallback: "#f2f2f2",
    note: "左侧会话栏（面板）",
  },
  {
    selector: ".cr-input-container",
    token: "--cr-bg-elevated",
    fallback: "#ffffff",
    note: "输入区",
  },
  {
    selector: ".cr-code-like-box",
    token: "--cr-bg-primary",
    fallback: "#ffffff",
    note: "代码块",
  },
  {
    selector: ".cr-tool-exp__content",
    token: "--cr-bg-primary-default",
    fallback: "#2a2c31",
    note: "工具卡（兜底色是深色）",
  },
  {
    selector: ".cr-widget-card",
    token: "--cr-bg-primary",
    fallback: "#ffffff",
    note: "组件卡",
  },
  {
    selector: ".cr-self-bubble",
    token: "--cr-user-bubble-bg",
    fallback: "#f2f2f2",
    note: "用户气泡",
  },
  {
    selector: ".artifact-slot-panel__card",
    token: "--cr-bg-primary",
    fallback: "#ffffff",
    note: "右侧产出面板的卡片",
  },
]);

/**
 * Sub-surfaces inside a floating layer: forced transparent so the group shows
 * exactly one alpha layer. Without this, container + child stack to ~97% and
 * look solid again.
 */
export const FLATTEN_SELECTORS = Object.freeze([
  ".cr-code-like-box__header",
  ".cr-code-like-box__body",
  ".cr-tool-write__body",
  ".cr-tool-diff",
  ".cr-tool-diff__viewport",
  ".cr-tool-exp__body",
  ".cr-tool-exp__header",
  // composer internals (toolbar / model picker / chips)
  '[class*="cr-input-toolbar"]',
  // right-hand panel internals
  ".artifact-slot-panel__grid",
  ".artifact-slot-panel__card-main",
  ".artifact-slot-panel__card-text",
  // table headers paint a hard-coded colour, so the token overlay cannot reach
  // them; the surrounding card already carries the alpha.
  "th",
]);

/**
 * Sidebar internals. The host sets these with COMPOUND class selectors, whose
 * specificity beats a single attribute selector — so they are scoped under the
 * sidebar to reach (0,3,0) and actually win.
 */
export const SIDEBAR_FLATTEN_SELECTORS = Object.freeze([
  '.teams-container [data-view-id="sidebar"] [class*="conversation-section-label"]',
  '.teams-container [data-view-id="sidebar"] [class*="cb-agent-card"]',
  '.teams-container [data-view-id="sidebar"] [class*="_header_1h739"]',
]);

/**
 * Deliberately NOT flattened: diff add/remove rows paint a semantic tint that
 * carries meaning. Turning them transparent would delete the add/remove signal.
 */
export const SEMANTIC_TINT_SELECTORS = Object.freeze([
  ".cr-tool-diff__line--add",
  ".cr-tool-diff__line--remove",
]);

/**
 * Decorative scroll-fade the host paints with the *theme's solid colour*
 * (`.cr-message-list__bottom-mask`, a 72px gradient to rgb(255,255,255) in the
 * light theme). Over a wallpaper it reads as a hard band, so it is switched off
 * while a background is active.
 */
export const MASK_SELECTORS = Object.freeze([
  ".cr-message-list__bottom-mask",
  ".cr-message-list__top-mask",
  '[class*="message-list__"][class*="mask"]',
]);

/**
 * Structural anchors the self-check requires before injecting anything.
 * A zero match means the host layout drifted → fail closed, do not inject.
 */
export interface ContractAnchor {
  key: string;
  selector: string;
  why: string;
}

export const CONTRACT_ANCHORS: readonly ContractAnchor[] = Object.freeze([
  { key: "shell", selector: ".teams-container", why: "外层容器" },
  { key: "conversation", selector: ".conversation-shell", why: "会话主区" },
  { key: "sidebar", selector: ".conversation-list", why: "侧栏列表" },
  { key: "sidebarItem", selector: '[class*="_gridViewItem_"]', why: "侧栏/主区视图项" },
  { key: "composer", selector: ".cr-input-container", why: "输入区" },
  { key: "root", selector: "#root", why: "React 根容器；摸鱼与重挂都依赖它" },
  { key: "messageList", selector: ".cr-message-list", why: "消息列表" },
]);

export type WorkBuddyTheme = "dark" | "light";

/** Scrim opacity by theme. Starting points, to be tuned during M1 acceptance. */
export const SCRIM_BY_THEME: Readonly<Record<WorkBuddyTheme, number>> = Object.freeze({
  dark: 0.28,
  light: 0.12,
});

/**
 * Read the theme off `<html class="dark cb-dark vscode-dark">`. Returns null
 * when neither `dark` nor `light` is present — the caller must then fail closed
 * rather than guess.
 *
 * Note the host emits an intermediate `theme-switching dark cb-dark …` during a
 * transition; token-based parsing handles it, but never compare the whole class
 * string.
 */
export function readTheme(htmlClassName: string): WorkBuddyTheme | null {
  const tokens = htmlClassName.split(/\s+/).filter(Boolean);
  if (tokens.includes("dark")) return "dark";
  if (tokens.includes("light")) return "light";
  return null;
}

export interface ContractCssOptions {
  theme: WorkBuddyTheme;
  /** Override the unified floating-surface opacity (0–1). */
  surfaceAlpha?: number;
  /** Switch off the host's solid-colour scroll fade. */
  mask?: boolean;
  scrim?: number;
}

/**
 * Build the CSS the injector ships into the page.
 *
 * Two mechanisms, on purpose, and they must never double-apply:
 *
 *  - the TOKEN layer (`token-overlay.ts`) makes every host token translucent,
 *    covering surfaces we have never seen (feature pages, modals, popovers);
 *  - this sheet's SURFACE_RULES pin the surfaces we HAVE measured, deriving from
 *    our own opaque `--bc-surface-base` so the value cannot compound with the
 *    token layer.
 *
 * An earlier revision also emitted `color-mix(… calc(var(--bc-surface-alpha) * 100%) …)`;
 * that `calc()` form is rejected by Chromium, so the rule was silently dropped
 * — and where it did apply it compounded. Keep the percentage literal.
 */
export function buildContractCss(options: ContractCssOptions): string {
  const { theme } = options;
  const alpha = options.surfaceAlpha ?? SURFACE_ALPHA;
  const mask = options.mask ?? true;
  const base = SURFACE_BASE_BY_THEME[theme];
  const pct = Math.round(alpha * 1000) / 10;
  const parts: string[] = [];

  /**
   * Theme-dependent values are emitted for BOTH themes, keyed on the same class
   * the host toggles. Pinning only the theme active at inject time is what made
   * a dark switch keep light backgrounds while the host turned the text white —
   * a white-on-white regression. The host's own `<html class>` now selects the
   * right block, so no re-injection is needed on a theme change.
   */
  const DARK_SELECTOR =
    'html:root.dark,html.dark,html.cb-dark,body.dark,body.cb-dark,body[data-theme="dark"],[data-theme="dark"]';
  const themeVars = (b: string, sc: number): string =>
    `${SURFACE_ALPHA_VAR}:${alpha};${SURFACE_BASE_VAR}:${b};${SCRIM_VAR}:${sc};`;

  // An explicit scrim override applies to the theme in effect; the other theme
  // keeps its default so a later switch still looks right.
  const scrimLight = theme === "light" ? (options.scrim ?? SCRIM_BY_THEME.light) : SCRIM_BY_THEME.light;
  const scrimDark = theme === "dark" ? (options.scrim ?? SCRIM_BY_THEME.dark) : SCRIM_BY_THEME.dark;

  parts.push(`html:root{${themeVars(SURFACE_BASE_BY_THEME.light, scrimLight)}}`);
  parts.push(`${DARK_SELECTOR}{${themeVars(SURFACE_BASE_BY_THEME.dark, scrimDark)}}`);

  parts.push(`${BACKDROP_SELECTORS.join(",")}{background-color:transparent !important;}`);

  // Pinned surfaces: one alpha layer, from our own base, no token involved.
  for (const rule of SURFACE_RULES) {
    parts.push(
      `${rule.selector}{` +
        `background-color:color-mix(in srgb, var(${SURFACE_BASE_VAR}, ${base}) ${pct}%, transparent) !important;` +
        `backdrop-filter:none !important;}`,
    );
  }

  parts.push(`${FLATTEN_SELECTORS.join(",")}{background-color:transparent !important;}`);
  parts.push(`${SIDEBAR_FLATTEN_SELECTORS.join(",")}{background-color:transparent !important;}`);

  if (mask) {
    parts.push(`${MASK_SELECTORS.join(",")}{display:none !important;}`);
  }

  const scrimForStage = options.scrim;
  parts.push(
    `#${STAGE_ID}{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:transparent !important;}` +
      `#${STAGE_ID} img,#${STAGE_ID} video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;}` +
      `#${STAGE_ID} img{z-index:1;}` +
      `#${STAGE_ID} video{z-index:2;opacity:0;}` +
      // reads the theme-keyed variable, so the scrim follows a theme switch too
      `#${STAGE_ID}::after{content:"";position:absolute;inset:0;z-index:3;pointer-events:none;background:rgba(0,0,0,var(${SCRIM_VAR}));}` +
      (scrimForStage === undefined
        ? ""
        : `html:root #${STAGE_ID}::after{background:rgba(0,0,0,${scrimForStage});}`) +
      `html[data-bc-active="true"][data-bc-media="video"][data-bc-video-ready="true"] #${STAGE_ID} video{opacity:1;}` +
      `html[data-bc-active="true"][data-bc-media="video"][data-bc-video-ready="true"] #${STAGE_ID} img{display:none !important;}`,
  );

  return parts.join("");
}

/** Attributes the injected runtime owns on `document.documentElement`. */
export const CONTRACT_ATTRIBUTES = Object.freeze([
  "data-bc-active",
  "data-bc-media",
  "data-bc-video-ready",
  "data-bc-generation",
  "data-bc-working",
  "data-bc-fish",
  "data-bc-tone",
  "data-bc-scrim",
]);

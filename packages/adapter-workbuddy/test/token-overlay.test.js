import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOKEN_ALPHA,
  HARDCODED_SURFACE_SCAN_EXPRESSION,
  TOKEN_EXCLUDE_PATTERN,
  TOKEN_INCLUDE_PATTERN,
  TOKEN_SCAN_EXPRESSION,
  buildStyleKeeperExpression,
  buildTokenOverlayCss,
  isOpaqueColor,
  parseColorAlpha,
} from "../dist/index.js";

test("parseColorAlpha understands every form the host actually produces", () => {
  // rgb / rgba
  assert.equal(parseColorAlpha("rgb(255, 255, 255)"), 1);
  assert.equal(parseColorAlpha("rgba(0, 0, 0, 0)"), 0);
  assert.equal(parseColorAlpha("rgba(0, 0, 0, 0.05)"), 0.05);
  assert.equal(parseColorAlpha("rgb(20 20 20 / 0.5)"), 0.5);
  // the colour-mix computed form — the reason this helper exists
  assert.equal(parseColorAlpha("color(srgb 1 1 1 / 0.82)"), 0.82);
  assert.equal(parseColorAlpha("color(srgb 0.94902 0.94902 0.94902)"), 1);
  // hex
  assert.equal(parseColorAlpha("#1f1f1f"), 1);
  assert.equal(parseColorAlpha("#fff"), 1);
  assert.ok(Math.abs(parseColorAlpha("#ffffffcc") - 0.8) < 0.005);
  assert.ok(Math.abs(parseColorAlpha("#fff8") - 0x88 / 255) < 0.005);
  assert.equal(parseColorAlpha("transparent"), 0);
  // unknown
  assert.equal(parseColorAlpha("var(--x)"), null);
  assert.equal(parseColorAlpha(""), null);
  assert.equal(parseColorAlpha(null), null);
});

test("isOpaqueColor treats near-opaque as opaque", () => {
  assert.equal(isOpaqueColor("rgb(255,255,255)"), true);
  assert.equal(isOpaqueColor("color(srgb 1 1 1 / 0.99)"), true);
  assert.equal(isOpaqueColor("color(srgb 1 1 1 / 0.82)"), false);
  assert.equal(isOpaqueColor("var(--x)"), false);
});

test("token include/exclude patterns select surfaces, not states", () => {
  const include = new RegExp(TOKEN_INCLUDE_PATTERN, "i");
  const exclude = new RegExp(TOKEN_EXCLUDE_PATTERN, "i");
  const wanted = (t) => include.test(t) && !exclude.test(t);

  for (const t of [
    "--wb-bg-primary",
    "--wb-bg-secondary",
    "--wb-bg-card",
    "--wb-bg-modal",
    "--cb-bg-primary",
    "--cb-panel-bg-primary",
    "--cb-dropdown-bg-color",
    "--cr-bg-elevated",
    "--cr-user-bubble-bg",
    "--sk-content-bg",
    "--vscode-editor-background",
    "--vscode-menu-background",
    "--vscode-editorWidget-background",
    // interaction-state surface tokens ARE included on purpose: the host uses
    // `--wb-bg-hover-light` as the resting background of real panels
    // (measured on `.artifact-slot-panel__card`), so excluding them left those
    // panels solid.
    "--wb-bg-hover-light",
    "--wb-bg-hover",
    // 5.6.2 paints secondary/neutral buttons opaque (measured on
    // `wb-button--secondary`: --wb-button-secondary-bg #262626 AND
    // --cb-input-button-background #3a3a3a — its rule is .cb-button--secondary);
    // neutral surfaces, so they join the overlay. Primary buttons stay
    // excluded (brand colour).
    "--wb-button-secondary-bg",
    "--cb-input-button-background",
    "--cb-button-secondary-background",
    // 5.6.2's new family, declared on :root[data-sc-color-scheme="dark"]
    "--sc-bg-grey_background",
    "--sc-bg-dark_background",
  ]) {
    assert.equal(wanted(t), true, `${t} should be overridden`);
  }

  for (const t of [
    "--wb-scrollbar-thumb",
    "--wb-button-primary-bg",
    "--wb-color-text-primary",
    "--wb-bg-primary-fg",
    "--wb-bg-primary-icon",
    "--cb-z-index-modal",
    "--wb-border-weak",
    "--wb-shadow-xl",
  ]) {
    assert.equal(wanted(t), false, `${t} must keep its official value`);
  }
});

test("overlay derives each token from itself and only touches opaque bases", () => {
  const css = buildTokenOverlayCss([
    { token: "--wb-bg-primary", lightValue: "#ffffff", darkValue: "#1f1f1f" },
    { token: "--cb-bg-primary", lightValue: "rgba(0, 0, 0, 0.05)", darkValue: "#101114" },
    { token: "--wb-bg-card", lightValue: "#f5f5f5", darkValue: null },
  ]);

  // opaque light bases are derived from themselves
  assert.match(css, /--wb-bg-primary:color-mix\(in srgb, #ffffff 82%, transparent\)/);
  assert.match(css, /--wb-bg-card:color-mix\(in srgb, #f5f5f5 82%, transparent\)/);
  // an already-translucent base is left alone (light) …
  assert.equal(css.includes("--cb-bg-primary:color-mix(in srgb, rgba(0, 0, 0, 0.05)"), false);
  // … but its opaque dark counterpart is still handled
  assert.match(css, /--cb-bg-primary:color-mix\(in srgb, #101114 82%, transparent\)/);
  // light and dark land in separate, theme-keyed blocks with raised specificity
  assert.match(css, /^html:root,/); // light block leads with :root, now a selector list with the body mirror
  assert.match(css, /html:root\.dark/);
  // 5.6.2 moved the host's token declarations down to body level; the overlay
  // must mirror both blocks at body scope or inheritance keeps the host's
  // opaque literals (nearest declaration wins). Gated on html theme classes so
  // light and dark can never match at once.
  assert.match(css, /html:not\(\.dark\):not\(\.cb-dark\) body\{/);
  assert.match(css, /html\.dark body,/);
  assert.match(css, /html\.cb-dark body\{/);
});

test("overlay alpha is configurable and defaults are sane", () => {
  assert.equal(DEFAULT_TOKEN_ALPHA, 0.82);
  const css = buildTokenOverlayCss(
    [{ token: "--wb-bg-primary", lightValue: "#fff", darkValue: null }],
    { alpha: 0.5 },
  );
  assert.match(css, /--wb-bg-primary:color-mix\(in srgb, #fff 50%, transparent\)/);
});

test("overlay ignores junk token names", () => {
  const css = buildTokenOverlayCss([
    { token: "not-a-token", lightValue: "#fff", darkValue: "#000" },
    { token: "--wb-bg-primary", lightValue: "var(--x)", darkValue: null },
  ]);
  assert.equal(css, "");
});

test("both scans walk nested rules and read backgrounds from cssText", () => {
  // 5.6.2 nests palettes inside @layer/@media/@supports and nested style rules;
  // a top-level walk missed --wb-button-secondary-bg entirely. And
  // `background: var(--x)` serialises to "" via getPropertyValue, so the
  // hardcoded sweep reads rule.style.cssText instead.
  for (const expr of [TOKEN_SCAN_EXPRESSION, HARDCODED_SURFACE_SCAN_EXPRESSION]) {
    assert.match(expr, /rule\.cssRules/);
    assert.match(expr, /visit\(/);
  }
  assert.match(HARDCODED_SURFACE_SCAN_EXPRESSION, /rule\.style\.cssText/);
});

test("the scan must not consume our own overlay (would drift on every re-apply)", () => {
  // A second apply used to read the sheet it wrote last time and re-mix the
  // color-mix values, so the dark-block coverage wandered between runs
  // (814 → 561). Both scans must skip any sheet whose id is ours.
  assert.match(TOKEN_SCAN_EXPRESSION, /ownerId\.startsWith\("beauticode"\)/);
  assert.match(HARDCODED_SURFACE_SCAN_EXPRESSION, /ownerId\.startsWith\("beauticode"\)/);
});

test("style keeper keeps our sheets last in <head>", () => {
  const expr = buildStyleKeeperExpression(["--a", "--b"]);
  assert.match(expr, /__bcKeepStylesLast/);
  assert.match(expr, /MutationObserver/);
  assert.match(expr, /appendChild/);
  // only moves them when a stylesheet actually lands after ours
  assert.match(expr, /isSheetNode/);
});

test("hardcoded sweep never touches html/body/#root or scrollbars", () => {
  assert.match(HARDCODED_SURFACE_SCAN_EXPRESSION, /\^\(html\|body\|#root\)\$/);
  assert.match(HARDCODED_SURFACE_SCAN_EXPRESSION, /scrollbar/);
});

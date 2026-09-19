import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKDROP_SELECTORS,
  CONTRACT_ANCHORS,
  CONTRACT_ATTRIBUTES,
  FLATTEN_SELECTORS,
  MASK_SELECTORS,
  SCRIM_BY_THEME,
  SCRIM_VAR,
  SEMANTIC_TINT_SELECTORS,
  STAGE_ID,
  SURFACE_ALPHA,
  SURFACE_ALPHA_VAR,
  SURFACE_BASE_BY_THEME,
  SURFACE_BASE_VAR,
  SURFACE_RULES,
  WORKBUDDY_HOST_DESCRIPTOR,
  assertLoopbackDebuggerUrl,
  buildContractCss,
  isWorkBuddyPageUrl,
  pickWorkBuddyTarget,
  readTheme,
  safeTargetLabel,
} from "../dist/index.js";

/** Exactly the shape measured on WorkBuddy 5.5.6 (query trimmed for readability). */
const REAL_PAGE_URL =
  "file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html" +
  "?locale=zh-CN&accountSnapshot=%7B%22version%22%3A1%7D";

test("descriptor advertises every capability the CDP route can honour", () => {
  assert.equal(WORKBUDDY_HOST_DESCRIPTOR.kind, "workbuddy");
  assert.equal(WORKBUDDY_HOST_DESCRIPTOR.displayName, "WorkBuddy");
  for (const [key, value] of Object.entries(WORKBUDDY_HOST_DESCRIPTOR.capabilities)) {
    assert.equal(value, true, `capability ${key} should be true`);
  }
});

test("target matching ignores the query string but keeps scheme and path", () => {
  assert.equal(isWorkBuddyPageUrl(REAL_PAGE_URL), true);
  assert.equal(
    isWorkBuddyPageUrl(
      "file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html",
    ),
    true,
  );
});

test("target matching rejects other hosts and non-bundle pages", () => {
  // Codex uses app:// — must not match.
  assert.equal(isWorkBuddyPageUrl("app://-/index.html"), false);
  assert.equal(isWorkBuddyPageUrl("http://127.0.0.1:3080/"), false);
  assert.equal(isWorkBuddyPageUrl("about:srcdoc"), false);
  assert.equal(isWorkBuddyPageUrl("file:///etc/passwd"), false);
  assert.equal(isWorkBuddyPageUrl("not a url"), false);
  // The renderer fragment must be a suffix, not merely present.
  assert.equal(isWorkBuddyPageUrl("file:///tmp/app.asar/renderer/index.html.bak"), false);
  assert.equal(isWorkBuddyPageUrl("file:///tmp/x/renderer/index.html"), false);
  assert.equal(isWorkBuddyPageUrl("file:///tmp/app.asar/renderer/index.html/evil"), false);
});

test("only the main window is picked, not iframes or devtools", () => {
  const picked = pickWorkBuddyTarget([
    { id: "A", type: "other", url: "devtools://devtools/bundled/x.html" },
    { id: "B", type: "iframe", url: "about:srcdoc" },
    { id: "C", type: "page", url: REAL_PAGE_URL },
  ]);
  assert.equal(picked?.id, "C");
  assert.equal(pickWorkBuddyTarget([{ id: "X", type: "iframe", url: "about:srcdoc" }]), null);
});

test("log labels never leak the account snapshot carried in the query", () => {
  const label = safeTargetLabel(REAL_PAGE_URL);
  assert.equal(label.includes("?"), false);
  assert.equal(label.includes("accountSnapshot"), false);
  assert.equal(label.includes("locale=zh-CN"), false);
  assert.match(label, /app\.asar\/renderer\/index\.html$/);
  assert.equal(safeTargetLabel("nonsense"), "(unparseable target url)");
});

test("debugger urls are pinned to loopback and the expected port", () => {
  assert.equal(
    assertLoopbackDebuggerUrl("ws://127.0.0.1:9335/devtools/page/C", 9335),
    "ws://127.0.0.1:9335/devtools/page/C",
  );
  assert.equal(
    assertLoopbackDebuggerUrl("ws://localhost:9335/devtools/page/C", 9335),
    "ws://localhost:9335/devtools/page/C",
  );
  assert.throws(() => assertLoopbackDebuggerUrl("ws://10.0.0.5:9335/x", 9335), /loopback/);
  assert.throws(() => assertLoopbackDebuggerUrl("ws://0.0.0.0:9335/x", 9335), /loopback/);
  assert.throws(() => assertLoopbackDebuggerUrl("ws://127.0.0.1:9222/x", 9335), /port/);
  assert.throws(() => assertLoopbackDebuggerUrl("http://127.0.0.1:9335/x", 9335), /ws:\/\//);
  assert.throws(() => assertLoopbackDebuggerUrl("garbage", 9335), /valid URL/);
});

test("theme is read from the html class token list, and unknown themes fail closed", () => {
  assert.equal(readTheme("dark cb-dark vscode-dark"), "dark");
  assert.equal(readTheme("light cb-light vscode-light"), "light");
  // the host emits this intermediate state during a switch
  assert.equal(readTheme("theme-switching dark cb-dark vscode-dark"), "dark");
  assert.equal(readTheme("cb-dark"), null);
  assert.equal(readTheme(""), null);
});

test("wallpaper area is transparent and the scroll fade is killed", () => {
  const css = buildContractCss({ theme: "dark" });
  for (const selector of BACKDROP_SELECTORS) {
    assert.ok(css.includes(selector), `backdrop selector ${selector} missing`);
  }
  assert.match(css, /background-color:transparent !important;/);
  for (const selector of MASK_SELECTORS) {
    assert.ok(css.includes(selector), `mask selector ${selector} missing`);
  }
  assert.match(css, /display:none !important;/);
  assert.ok(css.includes(`#${STAGE_ID}`));
});

test("surfaces are pinned to our own opaque base, so alpha cannot compound", () => {
  const css = buildContractCss({ theme: "light" });
  // The percentage must be literal: the calc(var()) form is rejected by Chromium.
  assert.equal(css.includes("calc(var(--bc-surface-alpha)"), false);
  assert.ok(css.includes(`${SURFACE_BASE_VAR}:${SURFACE_BASE_BY_THEME.light}`));
  assert.match(css, /color-mix\(in srgb, var\(--bc-surface-base, #ffffff\) 82%, transparent\)/);
  // and crucially: no host token may appear as the colour source here
  assert.equal(/var\(--(wb|cb|cr|sk|vscode)-/.test(css), false);
  // no frosted glass may come back
  assert.equal(css.includes("blur("), false);
  assert.match(css, /backdrop-filter:none !important;/);
});

test("BOTH theme bases are emitted, so a theme switch needs no re-injection", () => {
  const css = buildContractCss({ theme: "light" });
  assert.ok(css.includes(`${SURFACE_BASE_VAR}:${SURFACE_BASE_BY_THEME.light}`));
  assert.ok(
    css.includes(`${SURFACE_BASE_VAR}:${SURFACE_BASE_BY_THEME.dark}`),
    "the dark base must also be present — otherwise a dark switch keeps light surfaces while the host turns text white",
  );
  assert.match(css, /html:root\.dark/);
  // both scrim values too
  assert.ok(css.includes(`${SCRIM_VAR}:${SCRIM_BY_THEME.light}`));
  assert.ok(css.includes(`${SCRIM_VAR}:${SCRIM_BY_THEME.dark}`));
});

test("surface rules document which tokens the token layer must cover", () => {
  const tokens = SURFACE_RULES.map((r) => r.token);
  for (const expected of [
    "--cr-bg-elevated",
    "--cr-bg-primary",
    "--cr-bg-primary-default",
    "--cr-user-bubble-bg",
    "--wb-home-bg-primary",
  ]) {
    assert.ok(tokens.includes(expected), `${expected} should be listed as a covered surface token`);
  }
  // these two must not share a token — they read different variables, and a
  // shared token repaints the tool card
  const code = SURFACE_RULES.find((r) => r.selector === ".cr-code-like-box");
  const tool = SURFACE_RULES.find((r) => r.selector === ".cr-tool-exp__content");
  assert.ok(code && tool);
  assert.notEqual(code.token, tool.token);
});

test("sub-surfaces are flattened so exactly one alpha layer remains", () => {
  const css = buildContractCss({ theme: "dark" });
  for (const selector of FLATTEN_SELECTORS) {
    assert.ok(css.includes(selector), `flatten selector ${selector} missing`);
  }
  // the sidebar panel carries the alpha, its list body must not
  assert.equal(SURFACE_RULES.some((r) => r.selector === ".conversation-list"), false);
  assert.ok(BACKDROP_SELECTORS.includes(".conversation-list"));
});

test("diff tint keeps its semantic colour", () => {
  const css = buildContractCss({ theme: "dark" });
  for (const selector of SEMANTIC_TINT_SELECTORS) {
    assert.equal(css.includes(selector), false, `${selector} must not be flattened`);
  }
});

test("rule B holds: beautiCode never overrides a theme variable", () => {
  for (const theme of ["dark", "light"]) {
    const css = buildContractCss({ theme });
    assert.equal(
      /--(?:wb|cb|cr)-[a-z0-9-]+\s*:/.test(css),
      false,
      `generated CSS must not declare a host theme variable (theme=${theme})`,
    );
  }
});

test("scrim and surface alpha are overridable", () => {
  assert.notEqual(SCRIM_BY_THEME.dark, SCRIM_BY_THEME.light);
  assert.ok(buildContractCss({ theme: "dark" }).includes(`${SCRIM_VAR}:${SCRIM_BY_THEME.dark}`));
  assert.ok(buildContractCss({ theme: "light" }).includes(`${SCRIM_VAR}:${SCRIM_BY_THEME.light}`));
  assert.ok(buildContractCss({ theme: "dark", scrim: 0.5 }).includes(`${SCRIM_VAR}:0.5`));
  assert.ok(buildContractCss({ theme: "dark", surfaceAlpha: 0.9 }).includes(`${SURFACE_ALPHA_VAR}:0.9`));
});

test("contract anchors and attributes stay in sync with the self-check", () => {
  assert.ok(CONTRACT_ANCHORS.length >= 7);
  const keys = CONTRACT_ANCHORS.map((a) => a.key);
  for (const required of ["shell", "conversation", "sidebar", "composer", "root", "messageList"]) {
    assert.ok(keys.includes(required), `anchor ${required} missing`);
  }
  assert.ok(CONTRACT_ATTRIBUTES.includes("data-bc-active"));
  assert.ok(CONTRACT_ATTRIBUTES.includes("data-bc-video-ready"));
});

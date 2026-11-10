import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { hostCss, states } from "./fixtures/plugin-panel.mjs";
import { materialCss, pageModeHtml, sessionModeHtml } from "./fixtures/layered-material.mjs";

const runtime = process.env.BEAUTICODE_PLAYWRIGHT_MODULE;
// Without the module these are skipped, never counted as a pass. The ADR's
// verification report must list them as skipped.
const browserTest = runtime ? test : test.skip;
// An unpacked candidate can run the same behavioral test as the source tree.
const plugin = process.env.BEAUTICODE_TEST_PLUGIN_DIR
  ? new URL(`file:///${process.env.BEAUTICODE_TEST_PLUGIN_DIR.replaceAll("\\", "/")}/`)
  : new URL("../", import.meta.url);
const readable = await fs.readFile(new URL("readability.js", plugin), "utf8");
const client = await fs.readFile(new URL("client.js", plugin), "utf8");
const atmosphere = await fs.readFile(new URL("atmosphere.js", plugin), "utf8");
const css = /style.textContent = `([\s\S]*?)`;/;
const clientCss = client.match(css)[1].replaceAll("${CROSSFADE_MS}", "180");
const galleryCss = atmosphere.match(css)[1];

// ADR 0011's acceptance matrix, expressed as the fixture's expected values.
const PAGE_ALPHA = 0.3;
const PANEL_ALPHA = 0.6;
const NESTED_PANEL_ALPHA = 0.68;
const PAGE_BLUR = "blur(2.4px)";
const PANEL_BLUR = "blur(3.69px)";
const PANEL_BLUR_NO_PAGE = "blur(2px)";

// #92's honesty bars: each tone is valid only while the local background stays
// in its range. The page plate (30%) now sits between the text and the
// wallpaper, so the bars are measured against the composited background; the
// two opposing extremes are still asserted to FAIL so the trade-off stays
// visible instead of passing vacuously.
const TITLE_BAR = 5;
const BODY_BAR = 4.2;
const TONE_CASES = [
  { tone: "dark", background: "#555555", range: "local background L <= 0.10" },
  { tone: "light", background: "#e8e8e8", range: "local background L >= 0.81" },
];
const OUT_OF_RANGE_CASES = [
  { tone: "dark", background: "#ffffff", why: "light text on a white wallpaper" },
  { tone: "light", background: "#000000", why: "dark text on a black wallpaper" },
];

async function open(t, {
  html = pageModeHtml,
  pageStrength = 30,
  panelStrength = 60,
  material = {},
  tone = "dark",
  inject = true,
} = {}) {
  const { chromium } = await import(runtime);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BEAUTICODE_BROWSER_CHANNEL ? { channel: process.env.BEAUTICODE_BROWSER_CHANNEL } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(`<html data-bc-active="true" data-bc-resolved-tone="${tone}"><head><style>${hostCss}${materialCss}${clientCss}</style></head><body>${html}</body></html>`);
  await page.evaluate(({ pageStrength, panelStrength, material }) => {
    // Storage/transport is external to CSS rendering; a real in-memory store
    // lets about:blank exercise preference changes without touching user data.
    const data = new Map([
      ["beauticode-readable-surfaces", String(panelStrength)],
      ["beauticode-page-material", String(pageStrength)],
    ]);
    for (const [key, value] of Object.entries(material)) data.set(key, String(value));
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: (key) => data.delete(key),
      },
      configurable: true,
    });
  }, { pageStrength, panelStrength, material });
  if (inject) await page.addScriptTag({ content: readable });
  // Later gallery CSS must not weaken independently protected plugin surfaces.
  await page.addStyleTag({ content: galleryCss });
  return page;
}

async function surface(page, selector, pseudo = null) {
  return page.locator(selector).first().evaluate((element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    const context = document.createElement("canvas").getContext("2d");
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const attributes = {};
    for (const name of [
      "data-bc-material-root",
      "data-bc-material-layer",
      "data-bc-material-level",
      "data-bc-material-depth",
      "data-bc-material-blur",
    ]) {
      attributes[name] = element.getAttribute(name);
    }
    return {
      background: style.backgroundColor,
      alpha: context.getImageData(0, 0, 1, 1).data[3],
      filter: style.filter,
      backdrop: style.backdropFilter || style.webkitBackdropFilter || "none",
      // Computed values inherit custom properties from the root, so they cannot
      // tell whether *this* element was given a material. The inline style is
      // the element's own declaration; nested layers must never declare blur.
      materialAlpha: style.getPropertyValue("--bc-material-alpha").trim(),
      materialBlur: style.getPropertyValue("--bc-material-blur").trim(),
      inlineMaterialAlpha: element.style.getPropertyValue("--bc-material-alpha").trim(),
      inlineMaterialBlur: element.style.getPropertyValue("--bc-material-blur").trim(),
      textShadow: style.textShadow,
      radius: style.borderRadius,
      attributes,
    };
  }, pseudo);
}

/**
 * The page channel's pseudo-element. It must stay absent (alpha-only fallback);
 * the returned root* fields prove the page root keeps the host's positioning and
 * isolation untouched.
 */
const backplate = (page, selector = "#global-panel") => page.locator(selector).first().evaluate((element) => {
  const pseudo = getComputedStyle(element, "::before");
  const root = getComputedStyle(element);
  return {
    content: pseudo.content,
    position: pseudo.position,
    zIndex: pseudo.zIndex,
    pointerEvents: pseudo.pointerEvents,
    backdrop: pseudo.backdropFilter || pseudo.webkitBackdropFilter || "none",
    rootBackdrop: root.backdropFilter || root.webkitBackdropFilter || "none",
    rootPosition: root.position,
    rootIsolation: root.isolation,
  };
});

function hexToRgb(hex) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return null;
  const value = match[1];
  return value.length === 3
    ? { r: parseInt(value[0] + value[0], 16), g: parseInt(value[1] + value[1], 16), b: parseInt(value[2] + value[2], 16) }
    : {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
}

function parseColor(value) {
  // Chromium may serialize a color-mix() as rgba(...) or color(srgb ...).
  const srgb = String(value).match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
  if (srgb) {
    return {
      r: Math.round(Number(srgb[1]) * 255),
      g: Math.round(Number(srgb[2]) * 255),
      b: Math.round(Number(srgb[3]) * 255),
      a: srgb[4] == null ? 1 : Number(srgb[4]),
    };
  }
  const match = String(value).match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}

/** Composite the page plate's rgba over the wallpaper hex. */
function blend(overlay, background) {
  const alpha = overlay.a ?? 1;
  const mix = (channel) => Math.round(overlay[channel] * alpha + background[channel] * (1 - alpha));
  return `rgb(${mix("r")}, ${mix("g")}, ${mix("b")})`;
}

function luminance(color) {
  const hex = String(color).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  const channels = (hex
    ? (hex[1].length === 3 ? [...hex[1]].map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)))
    : String(color).match(/[\d.]+/g).slice(0, 3).map(Number)
  ).map((v) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** The halo token and the shadow the page actually paints. */
const halo = (page) => page.evaluate(() => ({
  token: getComputedStyle(document.body).getPropertyValue("--bc-text-halo").trim(),
  shadow: getComputedStyle(document.querySelector("[data-plugin-panel]")).textShadow,
}));

/** Resolve the secondary tier through a probe, then read the page's own colors. */
const tiers = (page) => page.evaluate(() => {
  const probe = document.createElement("span");
  probe.style.color = "var(--dsw-alias-label-secondary)";
  document.body.append(probe);
  const secondary = getComputedStyle(probe).color;
  probe.remove();
  return {
    secondary,
    description: getComputedStyle(document.querySelector(".host-description")).color,
    count: getComputedStyle(document.querySelector(".host-count")).color,
  };
});

browserTest("page mode: page 30% + blur on, panels 60% + 3.69px", async (t) => {
  const page = await open(t);

  const root = await surface(page, "#global-panel");
  assert.equal(root.attributes["data-bc-material-root"], "page");
  assert.equal(root.attributes["data-bc-material-layer"], null);
  assert.equal(root.attributes["data-bc-material-level"], "1");
  assert.equal(root.attributes["data-bc-material-depth"], "1");
  assert.ok(Math.abs(root.alpha - Math.round(PAGE_ALPHA * 255)) <= 2, `page plate alpha: ${root.background}`);
  assert.equal(root.backdrop, "none", "the page root itself never owns the filter");
  assert.equal(root.inlineMaterialAlpha, "0.3");
  assert.equal(root.inlineMaterialBlur, "2.4px", "the page backplate is on by default");
  assert.equal(root.attributes["data-bc-material-blur"], "on");
  const pageBackplate = await backplate(page);
  assert.equal(pageBackplate.content, '""', "the page blur lives on ::before");
  assert.equal(pageBackplate.position, "absolute");
  assert.equal(pageBackplate.zIndex, "-1");
  assert.equal(pageBackplate.pointerEvents, "none");
  assert.equal(pageBackplate.backdrop, PAGE_BLUR);
  assert.equal(pageBackplate.rootBackdrop, "none");
  assert.equal(pageBackplate.rootPosition, "relative");
  assert.equal(pageBackplate.rootIsolation, "isolate");

  const dialog = await surface(page, "#portal-dialog");
  assert.equal(dialog.attributes["data-bc-material-root"], "panel");
  assert.equal(dialog.attributes["data-bc-material-level"], "2");
  assert.equal(dialog.attributes["data-bc-material-depth"], "1");
  assert.equal(dialog.attributes["data-bc-material-blur"], "on");
  assert.ok(Math.abs(dialog.alpha - Math.round(PANEL_ALPHA * 255)) <= 1,
    `a panel root uses the 60% default: ${dialog.background}`);
  assert.equal(dialog.backdrop, PANEL_BLUR);
  assert.equal(dialog.inlineMaterialAlpha, "0.6");

  const dialogList = await surface(page, "#dialog-listbox");
  assert.equal(dialogList.attributes["data-bc-material-root"], null);
  assert.equal(dialogList.attributes["data-bc-material-layer"], "");
  assert.equal(dialogList.attributes["data-bc-material-level"], "3");
  assert.equal(dialogList.attributes["data-bc-material-depth"], "2");
  assert.equal(dialogList.backdrop, "none", "a nested layer never gets a backdrop-filter");
  // --bc-material-blur inherits from the panel root (3.69px), which is fine:
  // CSS only consumes it through the root's [data-bc-material-blur] rule. The
  // nested layer must not declare the variable itself or carry the flag.
  assert.equal(dialogList.inlineMaterialBlur, "", "a nested layer must not set its own blur radius");
  assert.equal(dialogList.attributes["data-bc-material-blur"], null);
  assert.ok(Math.abs(dialogList.alpha - Math.round(NESTED_PANEL_ALPHA * 255)) <= 1,
    `nested panel uses 60% + one 8% step: ${dialogList.background}`);
  assert.equal(dialogList.inlineMaterialAlpha, "0.68");

  assert.equal((await surface(page, "#sidebar")).attributes["data-bc-material-root"], null,
    "the sidebar never gets the page plate");
  assert.equal((await surface(page, "[data-plugin-panel]")).alpha, 0,
    "the plugin page itself stays transparent; the plate lives on the column");
  for (const selector of ["#composer", "#question-card", "#plan-card", "#approval-card"]) {
    const panel = await surface(page, selector);
    assert.equal(panel.attributes["data-bc-material-root"], "panel", selector);
    assert.ok(Math.abs(panel.alpha - Math.round(PANEL_ALPHA * 255)) <= 1, selector);
    assert.equal(panel.backdrop, PANEL_BLUR, selector);
  }
  assert.deepEqual(await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur()),
    { page: 2.4, panel: 3.69 });
  assert.equal(await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getPageBlur()), true);
  assert.equal(await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.get()), 60);
});

browserTest("conversation mode: no page material; composer and pending cards get 2px", async (t) => {
  const page = await open(t, { html: sessionModeHtml });
  assert.equal(await page.locator("[data-bc-material-root='page']").count(), 0,
    "no [data-global-panel], no page plate");

  for (const selector of ["#composer", "#question-card", "#plan-card", "#approval-card", "#settings-dialog"]) {
    const panel = await surface(page, selector);
    assert.equal(panel.attributes["data-bc-material-root"], "panel", selector);
    assert.ok(Math.abs(panel.alpha - Math.round(PANEL_ALPHA * 255)) <= 1, selector);
    assert.equal(panel.backdrop, PANEL_BLUR_NO_PAGE, `${selector} uses I = 0`);
    assert.equal(panel.inlineMaterialBlur, "2px", selector);
  }

  const nested = await surface(page, "#dialog-listbox");
  assert.equal(nested.attributes["data-bc-material-layer"], "");
  assert.equal(nested.backdrop, "none");
});

browserTest("page 0% removes the page root and the plugin aids; panels fall back to I = 0", async (t) => {
  const page = await open(t, { pageStrength: 0 });
  assert.equal(await page.locator("[data-bc-material-root='page']").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-bc-page-material")), false);

  const dialog = await surface(page, "#portal-dialog");
  assert.equal(dialog.attributes["data-bc-material-root"], "panel");
  assert.equal(dialog.backdrop, PANEL_BLUR_NO_PAGE);

  const painted = await halo(page);
  assert.equal(painted.shadow, "none", "page 0% turns the plugin halo off");
  const lifted = await tiers(page);
  assert.notEqual(lifted.description, lifted.secondary, "page 0% leaves captions at the host tier");
  assert.equal((await surface(page, "[data-plugin-panel]")).alpha, 0);
});

browserTest("panel 0% keeps the 30% page plate and the plugin aids but returns role surfaces to the host", async (t) => {
  const page = await open(t, { panelStrength: 0 });
  const root = await surface(page, "#global-panel");
  assert.equal(root.attributes["data-bc-material-root"], "page");
  assert.equal(root.backdrop, "none");
  assert.equal((await backplate(page)).content, '""', "the page backplate is independent of the panel channel");
  assert.equal((await backplate(page)).backdrop, PAGE_BLUR);
  assert.ok(Math.abs(root.alpha - Math.round(PAGE_ALPHA * 255)) <= 2);

  const dialog = await surface(page, "#portal-dialog");
  assert.equal(dialog.attributes["data-bc-material-root"], null);
  assert.equal(dialog.backdrop, "none");
  assert.ok(dialog.alpha > 0 && dialog.alpha < 255, `host translucent dialog: ${dialog.background}`);

  const composer = await surface(page, "#composer");
  assert.equal(composer.attributes["data-bc-material-root"], null);
  assert.ok(composer.alpha > 0 && composer.alpha < 255, `host translucent composer: ${composer.background}`);

  const painted = await halo(page);
  assert.notEqual(painted.shadow, "none", "the page channel stays on");
  const lifted = await tiers(page);
  assert.equal(lifted.description, lifted.secondary);
  assert.equal(lifted.count, lifted.secondary);
});

browserTest("advanced settings drive depth alpha and the sqrt blur stack", async (t) => {
  const page = await open(t);
  const dialogList = await surface(page, "#dialog-listbox");
  assert.ok(Math.abs(dialogList.alpha - Math.round(NESTED_PANEL_ALPHA * 255)) <= 1,
    `nested panel uses the fixed upward ramp: ${dialogList.background}`);
  assert.equal(dialogList.backdrop, "none");

  // Deeper levels are strictly more opaque: 60% root -> 68% -> 76%.
  await page.evaluate(() => {
    document.querySelector("#dialog-listbox").insertAdjacentHTML("beforeend", '<div role="listbox" id="dialog-deep"></div>');
    globalThis.BeauticodeReadableSurfaces.refresh();
  });
  const deep = await surface(page, "#dialog-deep");
  assert.ok(deep.alpha > dialogList.alpha,
    `depth alpha must increase with depth: ${dialogList.alpha} -> ${deep.alpha}`);
  assert.equal(deep.inlineMaterialAlpha, "0.76");

  // The retired direction input is ignored: no key in the snapshot, no ramp flip.
  const snapshot = await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setMaterial({ direction: "down" }));
  assert.deepEqual(snapshot, { alphaStep: 8, blurStep: 2, maxBlur: 8 });
  assert.equal((await surface(page, "#dialog-listbox")).inlineMaterialAlpha, "0.68");
  assert.equal((await surface(page, "#dialog-deep")).inlineMaterialAlpha, "0.76");

  // An old beauticode-material-direction storage value is ignored on load.
  const legacy = await open(t, { material: { "beauticode-material-direction": "down" } });
  assert.equal((await surface(legacy, "#dialog-listbox")).inlineMaterialAlpha, "0.68",
    "the retired storage key does not flip the ramp");

  await page.evaluate(() => {
    globalThis.BeauticodeReadableSurfaces.setMaterial({ alphaStep: 0, blurStep: 2, maxBlur: 8 });
    globalThis.BeauticodeReadableSurfaces.setPage(100);
  });
  const fullPage = await surface(page, "#global-panel");
  assert.equal(fullPage.backdrop, "none", "the page root never owns the filter");
  assert.equal((await backplate(page)).backdrop, "blur(8px)", "page 100% reaches maxBlur on the backplate");
  const noPanelBlur = await surface(page, "#portal-dialog");
  assert.equal(noPanelBlur.backdrop, "none", "I = M leaves nothing for the panel filter");
  assert.equal(noPanelBlur.attributes["data-bc-material-root"], "panel");

  await page.evaluate(() => {
    globalThis.BeauticodeReadableSurfaces.setPage(30);
    globalThis.BeauticodeReadableSurfaces.setMaterial({ maxBlur: 0 });
  });
  assert.equal((await surface(page, "#global-panel")).attributes["data-bc-material-blur"], null,
    "blur(0px) must never create a containing block");
  assert.equal((await backplate(page)).content, "none", "no backplate when maxBlur is 0");
  assert.equal((await surface(page, "#portal-dialog")).backdrop, "none");

  await page.evaluate(() => {
    globalThis.BeauticodeReadableSurfaces.setMaterial({ maxBlur: 8, alphaStep: 8 });
    globalThis.BeauticodeReadableSurfaces.setMaterial({ blurStep: 0 });
  });
  assert.equal((await surface(page, "#global-panel")).backdrop, "none");
  assert.equal((await backplate(page)).backdrop, PAGE_BLUR, "the page backplate does not depend on blurStep");
  assert.equal((await surface(page, "#portal-dialog")).backdrop, "none", "blurStep 0 leaves no panel blur");
});

browserTest("shell.overlay is not a root; its dialog is; no-role popovers are untouched", async (t) => {
  const page = await open(t);
  const overlay = await surface(page, "#shell-overlay");
  assert.equal(overlay.attributes["data-bc-material-root"], null);
  assert.equal(overlay.attributes["data-bc-material-layer"], null);
  assert.equal(overlay.backdrop, "none");
  assert.equal(overlay.alpha, 0, "the overlay container itself paints nothing");

  const shellDialog = await surface(page, "#shell-dialog");
  assert.equal(shellDialog.attributes["data-bc-material-root"], "panel");
  assert.equal(shellDialog.backdrop, PANEL_BLUR);

  const popover = await surface(page, "#third-party-popover");
  assert.equal(popover.attributes["data-bc-material-root"], null);
  assert.equal(popover.attributes["data-bc-material-layer"], null);
  assert.equal(popover.backdrop, "none");
  assert.equal(popover.background, "rgba(0, 0, 0, 0.5)", "an unknown overlay keeps its host look");
});

browserTest("plugin page keeps the wallpaper and the text halo across themes, phases and settings (#92)", async (t) => {
  const page = await open(t);
  for (const tone of ["dark", "light"]) for (const phase of ["hero", "active", "settling", "none"])
    for (const gallery of [false, true]) for (const dim of [false, true]) {
      await page.evaluate(({ tone, phase, gallery, dim }) => {
        Object.assign(document.documentElement.dataset, { bcResolvedTone: tone, bcGallery: String(gallery), bcDimUser: String(dim), bcBgBlur: "true" });
        document.querySelector("[data-plugin-panel]").dataset.phase = phase;
        document.documentElement.style.setProperty("--bc-dim", ".8");
        document.documentElement.style.setProperty("--bc-bg-blur", "9px");
        document.querySelector("#wallpaper").style.background = dim ? "white" : "repeating-linear-gradient(45deg,black,white 20px)";
      }, { tone, phase, gallery, dim });
      if (phase === "active" || phase === "settling") {
        assert.equal(await page.evaluate((phase) => document.documentElement.matches(`:has(#root [data-phase="${phase}"])`), phase), true);
      }
      for (const selector of ["[data-plugin-panel]>header", "[data-plugin-group=official]", "[data-plugin-group=bundles]", "[data-plugin-item]", "[data-plugin-package]"]) {
        const state = await surface(page, selector);
        assert.equal(state.alpha, 0, `${tone}/${phase}/${gallery}/${dim} ${selector} must keep the wallpaper`);
        assert.equal(state.filter, "none");
        assert.equal(state.backdrop, "none");
      }
      const pageRoot = await surface(page, "#global-panel");
      assert.equal(pageRoot.attributes["data-bc-material-root"], "page");
      assert.equal(pageRoot.backdrop, "none");
      assert.equal((await backplate(page)).content, '""', "the page backplate is on by default");
      assert.equal((await backplate(page)).backdrop, PAGE_BLUR);
      assert.ok(pageRoot.alpha > 0 && pageRoot.alpha < 255, "the page plate stays translucent");
      assert.equal((await surface(page, "[data-plugin-panel]")).alpha, 0, "page surroundings and gaps retain wallpaper");
      const painted = await halo(page);
      assert.equal(painted.token, tone === "dark" ? "#000" : "#fff", `${tone} halo token follows the tone`);
      assert.notEqual(painted.shadow, "none", `${tone}/${phase}/${gallery}/${dim} text halo must survive`);
      assert.equal(await page.locator("h1").evaluate((el) => getComputedStyle(el).textShadow), painted.shadow,
        "headings inherit the page halo");
      const lifted = await tiers(page);
      assert.equal(lifted.description, lifted.secondary, `${tone} descriptions are lifted one tier`);
      assert.equal(lifted.count, lifted.secondary, `${tone} counts are lifted one tier`);
    }
});

browserTest("each tone keeps the reference page's contrast inside its own wallpaper range", async (t) => {
  const page = await open(t);
  const readColors = () => page.locator("h1, .host-intro, h3, .host-count, .host-description")
    .evaluateAll((elements) => elements.map((element) => ({
      tag: element.tagName.toLowerCase() + (element.className ? `.${String(element.className).split(" ")[0]}` : ""),
      color: getComputedStyle(element).color,
    })));
  const paint = ({ tone, background }) => page.evaluate(({ tone, background }) => {
    document.documentElement.dataset.bcResolvedTone = tone;
    document.querySelector("#wallpaper").style.background = background;
  }, { tone, background });

  for (const { tone, background, range } of TONE_CASES) {
    await paint({ tone, background });
    const plate = parseColor((await surface(page, "#global-panel")).background);
    const effective = blend(plate, hexToRgb(background));
    const colors = await readColors();
    assert.ok(colors.length >= 5, "fixture exercises titles, intro, group headings, counts and descriptions");
    for (const { tag, color } of colors) {
      assert.ok(contrast(color, effective) >= BODY_BAR,
        `${tone} tone (${range}): ${tag} ${color} on ${effective} = ${contrast(color, effective).toFixed(2)}`);
    }
    const title = colors.find(({ tag }) => tag === "h1");
    assert.ok(title, "the fixture must render a page title");
    assert.ok(contrast(title.color, effective) >= TITLE_BAR,
      `${tone} tone (${range}): title ${title.color} on ${effective} = ${contrast(title.color, effective).toFixed(2)}`);
  }

  // The accepted trade-off, pinned: the page plate cannot rescue the opposite
  // extreme of either tone, so those cases must remain below the bar.
  for (const { tone, background, why } of OUT_OF_RANGE_CASES) {
    await paint({ tone, background });
    const plate = parseColor((await surface(page, "#global-panel")).background);
    const effective = blend(plate, hexToRgb(background));
    const [title] = await page.locator("h1").evaluateAll((elements) => elements.map((el) => getComputedStyle(el).color));
    const ratio = contrast(title, effective);
    assert.ok(ratio < BODY_BAR,
      `${tone} tone: ${why} is outside the accepted range and must stay below the bar (${ratio.toFixed(2)} on ${effective})`);
  }
});

browserTest("wallpaper reads through the page instead of being occluded by a plate", async (t) => {
  const page = await open(t);
  const group = page.locator("[data-plugin-group=official]");
  for (const tone of ["dark", "light"]) {
    await page.evaluate((tone) => { document.documentElement.dataset.bcResolvedTone = tone; }, tone);
    await page.locator("#wallpaper").evaluate((el) => { el.style.background = "white"; });
    const bright = await group.screenshot();
    await page.locator("#wallpaper").evaluate((el) => { el.style.background = "black"; });
    assert.notDeepEqual(await group.screenshot(), bright,
      `${tone}: the wallpaper must show through the 30% page plate`);
  }
});

browserTest("React state replacements stay transparent and keep the halo without re-injection", async (t) => {
  const page = await open(t);
  for (const [name, html] of Object.entries(states)) {
    await page.locator("[data-plugin-panel]").evaluate((el, html) => { el.innerHTML = html; }, html);
    assert.equal((await surface(page, "[data-plugin-panel]>:first-child")).alpha, 0, `${name} keeps the wallpaper`);
    const painted = await halo(page);
    assert.notEqual(painted.shadow, "none", `${name} keeps the halo`);
  }
});

browserTest("bright, dark, complex and playing video backgrounds keep the page transparent", async (t) => {
  const page = await open(t);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 320, 200);
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = canvas.captureStream(10);
    video.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:-1";
    document.body.prepend(video);
    await video.play();
  });
  assert.equal(await page.locator("video").evaluate((el) => el.paused), false);
  for (const tone of ["dark", "light"]) for (const blur of [false, true])
    for (const background of ["white", "black", "repeating-linear-gradient(45deg,red,white 20px)", "video"]) {
      await page.evaluate(({ tone, blur, background }) => {
        Object.assign(document.documentElement.dataset, { bcResolvedTone: tone, bcBgBlur: String(blur) });
        document.querySelector("#wallpaper").style.background = background === "video" ? "transparent" : background;
        document.querySelector("video").hidden = background !== "video";
      }, { tone, blur, background });
      for (const selector of ["[data-plugin-panel]>header", "[data-plugin-group=official]", "[data-plugin-package]"])
        assert.equal((await surface(page, selector)).alpha, 0, `${tone}/${blur}/${background} ${selector}`);
      const painted = await halo(page);
      assert.equal(painted.token, tone === "dark" ? "#000" : "#fff", `${tone}/${blur}/${background} halo token`);
      assert.notEqual(painted.shadow, "none", `${tone}/${blur}/${background} halo`);
    }
});

browserTest("both channels off restore the host appearance and typography", async (t) => {
  const baseline = await open(t, { inject: false, pageStrength: 0, panelStrength: 0 });
  const page = await open(t, { pageStrength: 0, panelStrength: 0 });
  const snapshot = async (target) => Promise.all(["[data-plugin-panel]>header", "[data-plugin-group=official]", "[data-plugin-package]", "[data-plugin-package] .host-description", "[data-plugin-group=official] .host-count"].map((selector) => surface(target, selector)));
  assert.deepEqual(await snapshot(page), await snapshot(baseline));
  assert.deepEqual(await tiers(page), await tiers(baseline), "both channels off restore host typography");
  assert.equal(await page.locator("[data-bc-material-root]").count(), 0);

  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPage(30));
  assert.equal((await surface(page, "[data-plugin-package]")).alpha, 0, "the card still keeps the wallpaper");
  assert.notDeepEqual(await tiers(page), await tiers(baseline), "the page channel lifts captions one tier");
  assert.equal((await surface(page, "#global-panel")).attributes["data-bc-material-root"], "page");

  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.set(100));
  assert.equal((await surface(page, "#composer")).alpha, 255, "the panel channel stays independent");

  await page.evaluate(() => { document.documentElement.dataset.bcActive = "false"; document.documentElement.dataset.bcGallery = "false"; globalThis.BeauticodeReadableSurfaces.refresh(); });
  await baseline.evaluate(() => { document.documentElement.dataset.bcActive = "false"; document.documentElement.dataset.bcGallery = "false"; });
  assert.deepEqual(await snapshot(page), await snapshot(baseline));
  assert.deepEqual(await tiers(page), await tiers(baseline));
  await page.evaluate(() => { document.documentElement.dataset.bcActive = "true"; globalThis.BeauticodeReadableSurfaces.setPage(0); globalThis.BeauticodeReadableSurfaces.set(0); });
  assert.equal(await page.locator("[data-bc-material-root]").count(), 0);
});

browserTest("transparent rows preserve geometry, card hover, keyboard focus and controls", async (t) => {
  const page = await open(t, { pageStrength: 0, panelStrength: 0 });
  const geometry = () => page.evaluate(() => [...document.querySelectorAll("[data-plugin-panel],header,[data-plugin-group],[data-plugin-package],[data-plugin-item]")]
    .map((el) => { const rect = el.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
  const before = await geometry();
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPage(30));
  assert.deepEqual(await geometry(), before, "the page plate does not move the layout");
  const normal = await surface(page, "[data-plugin-package]");
  // The fixed shell.overlay dialog is unrelated to this host-hover check and
  // covers the card's centre in the fixture, so hover the clear left portion.
  await page.locator("[data-plugin-package]").hover({ position: { x: 24, y: 40 } });
  const hover = await surface(page, "[data-plugin-package]");
  assert.notEqual(hover.background, normal.background, "host hover feedback survives");
  assert.ok(hover.alpha > 0 && hover.alpha < 255, `hover stays translucent: ${hover.background}`);
  await page.getByRole("checkbox", { name: "Enable beautiCode" }).check();
  assert.equal(await page.getByRole("checkbox", { name: "Enable beautiCode" }).isChecked(), true);
  await page.keyboard.press("Tab");
  await page.getByRole("button", { name: "beautiCode", exact: true }).focus();
  assert.notEqual(await page.locator("[data-plugin-package] .host-open").evaluate((el) => getComputedStyle(el, "::after").outlineStyle), "none");
  const card = await page.locator("[data-plugin-package]").boundingBox();
  const group = await page.locator("[data-plugin-group=bundles]").boundingBox();
  assert.ok(card.x < group.x, "fixture exercises the host's negative card margin");
  assert.equal(normal.radius, "16px");
  await page.locator("[data-plugin-panel]").evaluate((el) => {
    el.insertAdjacentHTML("beforeend", '<section data-plugin-group="more" style="min-height:900px">More plugins</section>');
    el.scrollTop = 100;
  });
  assert.ok(await page.locator("[data-plugin-panel]").evaluate((el) => el.scrollTop > 0));
  // The fixture starts with both channels off so it can compare geometry and
  // host hover. Restore the panel channel before checking a newly mounted
  // overlay: with panel 0% the host's translucent fallback is the correct
  // result, not the opaque panel material.
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.set(100));
  await page.locator("body").evaluate((el) => el.insertAdjacentHTML("beforeend", '<div role="dialog" id="late-dialog"><button>Install</button></div><div role="tooltip" id="late-tooltip">Hint</div>'));
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.refresh());
  assert.equal((await surface(page, "#late-dialog")).alpha, 255);
  assert.equal((await surface(page, "#late-dialog")).backdrop, "blur(3.69px)");
  assert.equal((await surface(page, "#late-dialog")).attributes["data-bc-material-blur"], "on");
  // A tooltip is not a material layer: it keeps the host surface and has no
  // material attributes even when mounted late.
  const lateTooltip = await surface(page, "#late-tooltip");
  assert.equal(lateTooltip.attributes["data-bc-material-root"], null);
  assert.equal(lateTooltip.attributes["data-bc-material-layer"], null);
  assert.equal(lateTooltip.backdrop, "none");
  assert.equal(await page.locator("[data-plugin-panel]>header").getAttribute("data-window-drag"), "");
});

browserTest("the panel slider paints its alpha and 0% restores the host surface", async (t) => {
  const page = await open(t);
  assert.ok(Math.abs((await surface(page, "#composer")).alpha - Math.round(PANEL_ALPHA * 255)) <= 1,
    "the default panel strength is 60%");
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.set(100));
  assert.equal((await surface(page, "#composer")).alpha, 255, "100% paints the opaque plate");
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.set(40));
  const mid = (await surface(page, "#composer")).alpha;
  assert.ok(Math.abs(mid - 102) <= 1, `40% paints about 40% of 255: ${mid}`);
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.set(0));
  const host = (await surface(page, "#composer")).alpha;
  assert.ok(host > 0 && host < 255, `0% restores the host's translucent composer: ${host}`);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.bcReadableSurfaces), "false");
  const pagePlate = await surface(page, "#global-panel");
  assert.ok(pagePlate.alpha > 0 && pagePlate.alpha < 255,
    "the page channel is independent of the panel slider");
});

browserTest("page backplate pauses for page overlays; tooltips keep host look and position", async (t) => {
  const page = await open(t);
  const pageRect = await page.locator("#global-panel").boundingBox();

  // Default: page 30% + page backplate on, no pause (the fixture column has no
  // page-internal overlay).
  const root = await surface(page, "#global-panel");
  assert.equal(root.attributes["data-bc-material-root"], "page");
  assert.ok(Math.abs(root.alpha - Math.round(PAGE_ALPHA * 255)) <= 2,
    `the page plate keeps its 30% fill: ${root.background}`);
  assert.equal(root.backdrop, "none", "the page root must not create a containing block");
  assert.equal(root.attributes["data-bc-material-blur"], "on");
  const plate = await backplate(page);
  assert.equal(plate.content, '""');
  assert.equal(plate.backdrop, PAGE_BLUR);
  assert.equal(plate.rootPosition, "relative");
  assert.equal(plate.rootIsolation, "isolate");
  assert.equal(await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getPageBlur()), true);
  assert.deepEqual(await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur()),
    { page: 2.4, panel: 3.69 });
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-bc-page-blur")), "true");

  const portalOn = await page.locator("#portal-fixed").boundingBox();
  assert.ok(Math.abs(portalOn.x - 40) <= 1 && Math.abs(portalOn.y - 40) <= 1,
    `a body-portal fixed dropdown keeps viewport coordinates: ${JSON.stringify(portalOn)}`);
  const innerOn = await page.locator("#page-fixed").boundingBox();
  assert.ok(Math.abs(innerOn.x - 60) <= 1 && Math.abs(innerOn.y - 60) <= 1,
    `in-page fixed popover stays viewport-relative: ${JSON.stringify(innerOn)}`);

  // A page-internal menu + tooltip: the menu becomes a 60% alpha-only panel,
  // the tooltip keeps the host tooltip token, and the page backplate pauses.
  await page.evaluate(() => {
    document.querySelector("#global-panel").insertAdjacentHTML("beforeend", `
      <div role="menu" id="page-menu" style="position:absolute;left:200px;top:200px;width:240px;height:120px">
        <div role="tooltip" id="menu-tooltip" style="position:fixed;left:40px;top:40px;padding:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-label-primary)">Hint</div>
      </div>`);
    document.body.insertAdjacentHTML("beforeend", `
      <div role="tooltip" id="host-tooltip" style="position:fixed;left:40px;top:40px;padding:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-label-primary)">Hint</div>`);
  });
  await page.waitForFunction(() => document.querySelector("#global-panel")?.hasAttribute("data-bc-page-blur-paused"));

  const pausedPlate = await backplate(page);
  assert.equal(pausedPlate.content, "none", "a page overlay removes the backplate pseudo-element");
  assert.equal(pausedPlate.rootPosition, "static", "a page overlay removes position:relative");
  assert.equal(pausedPlate.rootIsolation, "auto", "a page overlay removes isolation");
  assert.equal((await surface(page, "#global-panel")).backdrop, "none");
  assert.ok(Math.abs((await surface(page, "#global-panel")).alpha - Math.round(PAGE_ALPHA * 255)) <= 2,
    "the paused page keeps its 30% fill");
  assert.equal((await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur())).page, 0,
    "paused page blur is not applied");

  const pageMenu = await surface(page, "#page-menu");
  assert.equal(pageMenu.attributes["data-bc-material-root"], "panel");
  assert.equal(pageMenu.backdrop, "none", "page-internal panels are alpha-only");
  assert.equal(pageMenu.attributes["data-bc-material-blur"], null);
  assert.ok(Math.abs(pageMenu.alpha - Math.round(PANEL_ALPHA * 255)) <= 1,
    `page-internal menu uses panel 60%, not page alpha: ${pageMenu.background}`);

  const tooltipLook = await page.evaluate(() => {
    const read = (selector) => {
      const element = document.querySelector(selector);
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        background: style.backgroundColor,
        color: style.color,
        rect: { x: rect.x, y: rect.y },
        material: element.getAttribute("data-bc-material-root"),
        layer: element.getAttribute("data-bc-material-layer"),
        backdrop: style.backdropFilter || style.webkitBackdropFilter || "none",
      };
    };
    const bodyToken = getComputedStyle(document.body).getPropertyValue("--dsw-alias-tooltip-bg").trim();
    const menuToken = getComputedStyle(document.querySelector("#page-menu")).getPropertyValue("--dsw-alias-tooltip-bg").trim();
    return { menu: read("#menu-tooltip"), host: read("#host-tooltip"), bodyToken, menuToken };
  });
  assert.equal(tooltipLook.menu.material, null, "tooltip is not a material root");
  assert.equal(tooltipLook.menu.layer, null, "tooltip is not a nested material layer");
  assert.equal(tooltipLook.menu.backdrop, "none");
  assert.equal(tooltipLook.menu.background, tooltipLook.host.background,
    "tooltip keeps the host tooltip background inside a page-internal menu");
  assert.equal(tooltipLook.menu.color, tooltipLook.host.color, "tooltip keeps the host tooltip text colour");
  assert.ok(Math.abs(tooltipLook.menu.rect.x - 40) <= 1 && Math.abs(tooltipLook.menu.rect.y - 40) <= 1,
    `tooltip keeps host fixed positioning: ${JSON.stringify(tooltipLook.menu.rect)}`);
  assert.equal(tooltipLook.menuToken, tooltipLook.bodyToken, "--dsw-alias-tooltip-bg is never rewritten");

  // Closing every page overlay resumes the backplate.
  await page.evaluate(() => {
    document.querySelector("#page-menu").remove();
    document.querySelector("#host-tooltip").remove();
  });
  await page.waitForFunction(() => !document.querySelector("#global-panel")?.hasAttribute("data-bc-page-blur-paused"));
  assert.equal((await backplate(page)).content, '""', "removing the overlay restores the page backplate");
  assert.equal((await backplate(page)).rootPosition, "relative");
  assert.equal((await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur())).page, 2.4);

  // Standalone page tooltip (the reported plugin-market case): host black card
  // stays black/white, positioned at 70/70, while the page pauses.
  await page.evaluate(() => {
    document.querySelector("#global-panel").insertAdjacentHTML("beforeend",
      '<div role="tooltip" id="page-tooltip" style="position:fixed;left:70px;top:70px;padding:6px;background:rgb(0,0,0);color:rgb(255,255,255)">Hint</div>');
  });
  await page.waitForFunction(() => document.querySelector("#global-panel")?.hasAttribute("data-bc-page-blur-paused"));
  const tooltip = await page.evaluate(() => {
    const element = document.querySelector("#page-tooltip");
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      color: style.color,
      rect: { x: rect.x, y: rect.y },
      material: element.getAttribute("data-bc-material-root"),
      layer: element.getAttribute("data-bc-material-layer"),
    };
  });
  assert.equal(tooltip.material, null);
  assert.equal(tooltip.layer, null);
  assert.equal(tooltip.background, "rgb(0, 0, 0)", "the host tooltip card stays black");
  assert.equal(tooltip.color, "rgb(255, 255, 255)", "the host tooltip text stays white");
  assert.ok(Math.abs(tooltip.rect.x - 70) <= 1 && Math.abs(tooltip.rect.y - 70) <= 1,
    `host tooltip positioning is stable while page blur is on: ${JSON.stringify(tooltip.rect)}`);
  assert.equal((await backplate(page)).rootPosition, "static", "the page backplate is paused for the tooltip");

  await page.evaluate(() => { document.querySelector("#page-tooltip").remove(); });
  await page.waitForFunction(() => !document.querySelector("#global-panel")?.hasAttribute("data-bc-page-blur-paused"));
  assert.equal((await backplate(page)).content, '""');

  // Turning the page backplate off keeps the same host tooltip/geometry and
  // removes every page position/isolation.
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPageBlur(false));
  const offPlate = await backplate(page);
  assert.equal(offPlate.content, "none");
  assert.equal(offPlate.rootPosition, "static");
  assert.equal(offPlate.rootIsolation, "auto");
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-bc-page-blur")), false);
  assert.equal((await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur())).page, 0);
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPageBlur(true));
  assert.equal((await backplate(page)).content, '""');

  // Page 0% and maxBlur 0 both remove the backplate without leaving position or
  // isolation behind; the stored page-blur preference is unchanged.
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPage(0));
  assert.equal(await page.locator("[data-bc-material-root='page']").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-bc-page-blur")), false);
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPage(30));
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setMaterial({ maxBlur: 0 }));
  assert.equal((await backplate(page)).content, "none", "maxBlur 0 leaves no page backplate");
  assert.equal((await backplate(page)).rootPosition, "static");
  assert.equal((await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur())).page, 0);
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setMaterial({ maxBlur: 8 }));
  assert.equal((await backplate(page)).content, '""');

  t.diagnostic(`page blur default on: column x=${pageRect.x}, root alpha=${root.alpha}, fixed=${JSON.stringify(innerOn)}, portal=${JSON.stringify(portalOn)}`);
  t.diagnostic(`paused page: menu alpha=${pageMenu.alpha}, tooltip=${JSON.stringify(tooltipLook.menu)}, standalone=${JSON.stringify(tooltip)}`);
});

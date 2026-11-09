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
const NESTED_PAGE_ALPHA = 0.38;
const PANEL_BLUR = "blur(3.69px)";
const PANEL_BLUR_NO_PAGE = "blur(2px)";
const NESTED_DOWN = { page: 0.22, panel: 0.92 };

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
  panelStrength = 100,
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

/** Max per-channel difference between two screenshots (compositing noise safe). */
async function clipDiff(page, first, second) {
  return page.evaluate(async ({ first, second }) => {
    const draw = async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const [left, right] = await Promise.all([draw(first), draw(second)]);
    let max = 0;
    for (let index = 0; index < left.length; index += 4) {
      max = Math.max(max,
        Math.abs(left[index] - right[index]),
        Math.abs(left[index + 1] - right[index + 1]),
        Math.abs(left[index + 2] - right[index + 2]));
    }
    return max;
  }, { first: first.toString("base64"), second: second.toString("base64") });
}

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

browserTest("page mode: page 30% alpha-only, independent panel 100% / 3.69px, nested layers alpha only", async (t) => {
  const page = await open(t);

  const root = await surface(page, "#global-panel");
  assert.equal(root.attributes["data-bc-material-root"], "page");
  assert.equal(root.attributes["data-bc-material-layer"], null);
  assert.equal(root.attributes["data-bc-material-level"], "1");
  assert.equal(root.attributes["data-bc-material-depth"], "1");
  assert.ok(Math.abs(root.alpha - Math.round(PAGE_ALPHA * 255)) <= 2, `page plate alpha: ${root.background}`);
  assert.equal(root.backdrop, "none", "the page channel is alpha-only");
  assert.equal(root.inlineMaterialAlpha, "0.3");
  assert.equal(root.inlineMaterialBlur, "", "page blur is opt-in and off by default");
  assert.equal(root.attributes["data-bc-material-blur"], null);
  const pageBackplate = await backplate(page);
  assert.equal(pageBackplate.content, "none", "the page channel has no backplate");
  assert.equal(pageBackplate.rootBackdrop, "none");
  assert.equal(pageBackplate.rootPosition, "static");
  assert.equal(pageBackplate.rootIsolation, "auto");

  const dialog = await surface(page, "#portal-dialog");
  assert.equal(dialog.attributes["data-bc-material-root"], "panel");
  assert.equal(dialog.attributes["data-bc-material-level"], "2");
  assert.equal(dialog.attributes["data-bc-material-depth"], "1");
  assert.equal(dialog.attributes["data-bc-material-blur"], "on");
  assert.equal(dialog.alpha, 255, "a panel root is opaque by default");
  assert.equal(dialog.backdrop, PANEL_BLUR);
  assert.equal(dialog.inlineMaterialAlpha, "1");

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
  assert.equal(dialogList.alpha, 255, "panel alpha clamps at 100%");

  const pageNested = await surface(page, "#page-nested-panel");
  assert.equal(pageNested.attributes["data-bc-material-layer"], "");
  assert.equal(pageNested.attributes["data-bc-material-depth"], "2");
  assert.equal(pageNested.backdrop, "none");
  assert.ok(Math.abs(pageNested.alpha - Math.round(NESTED_PAGE_ALPHA * 255)) <= 2,
    `page nested alpha: ${pageNested.background}`);
  assert.equal(pageNested.inlineMaterialAlpha, "0.38");

  assert.equal((await surface(page, "#sidebar")).attributes["data-bc-material-root"], null,
    "the sidebar never gets the page plate");
  assert.equal((await surface(page, "[data-plugin-panel]")).alpha, 0,
    "the plugin page itself stays transparent; the plate lives on the column");
  for (const selector of ["#composer", "#question-card", "#plan-card", "#approval-card"]) {
    const panel = await surface(page, selector);
    assert.equal(panel.attributes["data-bc-material-root"], "panel", selector);
    assert.equal(panel.alpha, 255, selector);
    assert.equal(panel.backdrop, PANEL_BLUR, selector);
  }
});

browserTest("conversation mode: no page material; composer and pending cards get 2px", async (t) => {
  const page = await open(t, { html: sessionModeHtml });
  assert.equal(await page.locator("[data-bc-material-root='page']").count(), 0,
    "no [data-global-panel], no page plate");

  for (const selector of ["#composer", "#question-card", "#plan-card", "#approval-card", "#settings-dialog"]) {
    const panel = await surface(page, selector);
    assert.equal(panel.attributes["data-bc-material-root"], "panel", selector);
    assert.equal(panel.alpha, 255, selector);
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
  assert.equal((await backplate(page)).content, "none", "the alpha-only page channel has no backplate");
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
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setMaterial({ direction: "down" }));
  const pageNested = await surface(page, "#page-nested-panel");
  assert.ok(Math.abs(pageNested.alpha - Math.round(NESTED_DOWN.page * 255)) <= 2, `down page nested: ${pageNested.background}`);
  const dialogList = await surface(page, "#dialog-listbox");
  assert.ok(Math.abs(dialogList.alpha - Math.round(NESTED_DOWN.panel * 255)) <= 2, `down panel nested: ${dialogList.background}`);
  assert.equal(dialogList.backdrop, "none");

  await page.evaluate(() => {
    globalThis.BeauticodeReadableSurfaces.setMaterial({ direction: "up", alphaStep: 0, blurStep: 2, maxBlur: 8 });
    globalThis.BeauticodeReadableSurfaces.setPage(100);
  });
  const fullPage = await surface(page, "#global-panel");
  assert.equal(fullPage.backdrop, "none", "the page root never owns the filter");
  assert.equal((await backplate(page)).content, "none", "the page channel has no backplate");
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
  assert.equal((await backplate(page)).content, "none");
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
      assert.equal((await backplate(page)).content, "none", "the page channel is alpha-only");
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
  await page.locator("[data-plugin-package]").hover();
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
  assert.equal((await surface(page, "#late-tooltip")).alpha, 255);
  assert.equal(await page.locator("[data-plugin-panel]>header").getAttribute("data-window-drag"), "");
});

browserTest("the panel slider paints its alpha and 0% restores the host surface", async (t) => {
  const page = await open(t);
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.set(100));
  assert.equal((await surface(page, "#composer")).alpha, 255, "the default strength keeps the plate opaque");
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

browserTest("alpha-only page channel keeps absolute, fixed and stacking baseline", async (t) => {
  const page = await open(t);
  const pageRect = await page.locator("#global-panel").boundingBox();

  // The page channel is alpha-only: 30% fill, no filter, no backplate, and no
  // positioning/stacking context of our own (V9/V10/V11 fallback).
  const root = await surface(page, "#global-panel");
  assert.equal(root.attributes["data-bc-material-root"], "page");
  assert.ok(Math.abs(root.alpha - Math.round(PAGE_ALPHA * 255)) <= 2,
    `the page plate keeps its 30% fill: ${root.background}`);
  assert.equal(root.backdrop, "none", "the page root must not create a containing block");
  assert.equal(root.filter, "none");
  const plate = await backplate(page);
  assert.equal(plate.content, "none", "the page channel owns no backplate pseudo-element");
  assert.equal(plate.rootBackdrop, "none");
  assert.equal(plate.rootPosition, "static");
  assert.equal(plate.rootIsolation, "auto");

  // Panel blur is unchanged by the page fallback.
  assert.equal((await surface(page, "#portal-dialog")).backdrop, PANEL_BLUR);

  // V9: an absolute descendant must resolve against the host's containing block
  // (#root is position:relative), not against the page column.
  const absoluteOn = await page.evaluate(() => {
    const node = document.createElement("div");
    node.id = "absolute-probe";
    node.style.cssText = "position:absolute;left:10px;top:12px;width:20px;height:20px";
    document.querySelector("#global-panel").append(node);
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
  assert.ok(Math.abs(absoluteOn.x - 10) <= 1 && Math.abs(absoluteOn.y - 12) <= 1,
    `absolute probe must use #root, not the page column: ${JSON.stringify(absoluteOn)} (column x=${pageRect.x})`);

  // V10: a high z-index layer inside the page column must participate in #root's
  // stacking context. With isolation it would be trapped and lose to a z-index:1
  // sibling outside the page.
  const stackingOn = await page.evaluate(() => {
    const inside = document.createElement("div");
    inside.id = "high-inside";
    inside.style.cssText = "position:absolute;left:300px;top:400px;width:80px;height:80px;z-index:9999;background:rgb(255,0,0)";
    document.querySelector("#global-panel").append(inside);
    const outside = document.createElement("div");
    outside.id = "high-outside";
    outside.style.cssText = "position:absolute;left:320px;top:420px;width:80px;height:80px;z-index:1;background:rgb(0,0,255)";
    document.querySelector("#root").append(outside);
    return document.elementFromPoint(340, 440)?.id;
  });
  assert.equal(stackingOn, "high-inside", "page-internal z-index:9999 is not trapped by the page root");

  const portalOn = await page.locator("#portal-fixed").boundingBox();
  assert.ok(Math.abs(portalOn.x - 40) <= 1 && Math.abs(portalOn.y - 40) <= 1,
    `a body-portal fixed dropdown keeps viewport coordinates: ${JSON.stringify(portalOn)}`);
  const innerOn = await page.locator("#page-fixed").boundingBox();
  assert.ok(Math.abs(innerOn.x - 60) <= 1 && Math.abs(innerOn.y - 60) <= 1,
    `in-page fixed popover must stay viewport-relative: ${JSON.stringify(innerOn)}`);

  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPage(0));
  const pageOff = await page.locator("#global-panel").boundingBox();
  assert.ok(Math.abs(pageOff.x - pageRect.x) <= 1 && Math.abs(pageOff.y - pageRect.y) <= 1
    && Math.abs(pageOff.width - pageRect.width) <= 1 && Math.abs(pageOff.height - pageRect.height) <= 1,
  "the page fill must not change the page column's own layout");
  const absoluteOff = await page.locator("#absolute-probe").boundingBox();
  assert.ok(Math.abs(absoluteOff.x - absoluteOn.x) <= 1 && Math.abs(absoluteOff.y - absoluteOn.y) <= 1,
    `absolute coordinates must be identical with page material on and off: ${JSON.stringify({ absoluteOn, absoluteOff })}`);
  const stackingOff = await page.evaluate(() => document.elementFromPoint(340, 440)?.id);
  assert.equal(stackingOff, stackingOn, "stacking must be identical with page material on and off");
  const portalOff = await page.locator("#portal-fixed").boundingBox();
  assert.ok(Math.abs(portalOff.x - portalOn.x) <= 1 && Math.abs(portalOff.y - portalOn.y) <= 1,
    "toggling page material never moves a portal dropdown");
  const innerOff = await page.locator("#page-fixed").boundingBox();
  assert.ok(Math.abs(innerOff.x - innerOn.x) <= 1 && Math.abs(innerOff.y - innerOn.y) <= 1,
    `fixed coordinates must be identical with page material on and off: ${JSON.stringify({ innerOn, innerOff })}`);
  const plateOff = await backplate(page);
  assert.equal(plateOff.content, "none", "page 0% has no backplate either");
  assert.equal(plateOff.rootPosition, "static");
  assert.equal(plateOff.rootIsolation, "auto");

  // V11: there is no backplate to scroll away. The page column is a scroll
  // container in this fixture; after scrolling, the fill still covers the
  // scrollport and neither a filter nor a pseudo-element appears.
  const scroll = await page.locator("#global-panel").evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: style.overflowY,
      scrollable: el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(style.overflowY),
    };
  });
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPage(30));
  const scrollTop = await page.locator("#global-panel").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  const scrolled = await surface(page, "#global-panel");
  assert.equal(scrolled.backdrop, "none");
  assert.ok(Math.abs(scrolled.alpha - Math.round(PAGE_ALPHA * 255)) <= 2,
    "the fill still covers the scrollport after scrolling");
  const plateScrolled = await backplate(page);
  assert.equal(plateScrolled.content, "none", "no backplate exists to scroll away");
  assert.equal(await page.locator("[data-bc-material-backplate]").count(), 0);
  // The fill must still cover the bottom of the scrollport after scrolling:
  // toggling page material changes the bottom strip's pixels.
  const bottomClip = {
    x: Math.round(pageRect.x + 180),
    y: Math.round(pageRect.y + 760),
    width: 160,
    height: 30,
  };
  const filledBottom = await page.screenshot({ clip: bottomClip });
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPage(0));
  const unfilledBottom = await page.screenshot({ clip: bottomClip });
  assert.notDeepEqual(filledBottom, unfilledBottom,
    "the page fill must still cover the scrollport bottom after scrolling (V11)");
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPage(30));
  await page.locator("#global-panel").evaluate((el) => { el.scrollTop = 0; });

  // ---------------------------------------------------------------------------
  // Experimental opt-in page blur (default off). It restores the v1 backplate
  // *and* its known V9/V10/V11 side effects; the assertions below pin those
  // limitations explicitly instead of presenting them as safe.
  // ---------------------------------------------------------------------------
  assert.equal(await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getPageBlur()), false);
  assert.equal((await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur())).page, 0);
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPageBlur(true));
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-bc-page-blur")), "true");

  const expRoot = await surface(page, "#global-panel");
  assert.equal(expRoot.backdrop, "none", "the page root still clears the generic filter");
  const expPlate = await backplate(page);
  assert.equal(expPlate.content, '""');
  assert.equal(expPlate.position, "absolute");
  assert.equal(expPlate.zIndex, "-1");
  assert.equal(expPlate.pointerEvents, "none");
  assert.equal(expPlate.backdrop, "blur(2.4px)");
  assert.equal(expPlate.rootPosition, "relative");
  assert.equal(expPlate.rootIsolation, "isolate");
  assert.deepEqual(await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur()),
    { page: 2.4, panel: 3.69 });

  // Known limitation V9: the page root becomes an absolute containing block.
  const absoluteExperimental = await page.locator("#absolute-probe").boundingBox();
  assert.ok(Math.abs(absoluteExperimental.x - (pageRect.x + 10)) <= 1,
    `experimental page blur makes the page root the absolute containing block: ${JSON.stringify(absoluteExperimental)}`);
  // Known limitation V10: isolation traps a high z-index page layer below an
  // outside z-index:1 sibling. Move the inside probe to viewport x=300 first.
  await page.locator("#high-inside").evaluate((el) => { el.style.left = "60px"; el.style.top = "400px"; });
  const stackingExperimental = await page.evaluate(() => document.elementFromPoint(340, 440)?.id);
  assert.equal(stackingExperimental, "high-outside",
    "experimental page blur traps page-internal z-index:9999 under an outside z-index:1 sibling");
  // The backplate form does not reintroduce the original V3 fixed containing
  // block (60 stays 60); it is the absolute/isolation/scroll side effects that
  // are known.
  const innerExperimental = await page.locator("#page-fixed").boundingBox();
  assert.ok(Math.abs(innerExperimental.x - 60) <= 1 && Math.abs(innerExperimental.y - 60) <= 1,
    `fixed stays viewport-relative even with the experimental backplate: ${JSON.stringify(innerExperimental)}`);

  // The backplate really blurs (wallpaper strip clear of every overlay).
  await page.locator("#wallpaper").evaluate((el) => {
    el.style.background = "repeating-conic-gradient(#000 0% 25%, #fff 0% 50%) 0 0 / 8px 8px";
  });
  const blurClip = {
    x: Math.round(pageRect.x + 180),
    y: Math.round(pageRect.y + 560),
    width: 160,
    height: 80,
  };
  const experimentalBlurred = await page.screenshot({ clip: blurClip });
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setMaterial({ maxBlur: 0 }));
  const experimentalSharp = await page.screenshot({ clip: blurClip });
  const experimentalDelta = await clipDiff(page, experimentalBlurred, experimentalSharp);
  assert.ok(experimentalDelta > 8,
    `the opt-in backplate must blur the wallpaper (max channel delta ${experimentalDelta})`);
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setMaterial({ maxBlur: 8 }));

  // Known limitation V11: the absolute backplate scrolls with a scrollable page
  // column, so its bottom rows lose the blur. Record (and pin) the limitation.
  const experimentalScrollTop = await page.locator("#global-panel").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  const scrollStrip = {
    x: Math.round(pageRect.x + 180),
    y: Math.round(pageRect.y + 768),
    width: 160,
    height: 20,
  };
  const scrollBlurred = await page.screenshot({ clip: scrollStrip });
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setMaterial({ maxBlur: 0 }));
  const scrollSharp = await page.screenshot({ clip: scrollStrip });
  const scrollDelta = await clipDiff(page, scrollBlurred, scrollSharp);
  assert.ok(scrollDelta <= 2,
    `known experimental scroll limitation: the bottom strip loses the backplate blur (delta ${scrollDelta})`);
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setMaterial({ maxBlur: 8 }));
  await page.locator("#global-panel").evaluate((el) => { el.scrollTop = 0; });

  // Turning the experiment off restores the safe alpha-only shape exactly.
  await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.setPageBlur(false));
  const safePlate = await backplate(page);
  assert.equal(safePlate.content, "none");
  assert.equal(safePlate.rootPosition, "static");
  assert.equal(safePlate.rootIsolation, "auto");
  assert.equal(expRoot.backdrop, "none");
  assert.equal((await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getBlur())).page, 0);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-bc-page-blur")), false);
  const absoluteRestored = await page.locator("#absolute-probe").boundingBox();
  assert.ok(Math.abs(absoluteRestored.x - (pageRect.x + 10)) > 100,
    `safe mode restores the host containing block: ${JSON.stringify(absoluteRestored)}`);
  assert.ok(Math.abs(absoluteRestored.x - 10) <= 1);
  await page.locator("#high-inside").evaluate((el) => { el.style.left = "300px"; el.style.top = "400px"; });
  assert.equal(await page.evaluate(() => document.elementFromPoint(340, 440)?.id), "high-inside",
    "safe mode restores the host stacking");
  const innerRestored = await page.locator("#page-fixed").boundingBox();
  assert.ok(Math.abs(innerRestored.x - 60) <= 1 && Math.abs(innerRestored.y - 60) <= 1);

  // Page 0% removes the opt-in flag/backplate while keeping the stored option.
  await page.evaluate(() => {
    globalThis.BeauticodeReadableSurfaces.setPageBlur(true);
    globalThis.BeauticodeReadableSurfaces.setPage(0);
  });
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-bc-page-blur")), false);
  assert.equal(await page.locator("[data-bc-material-root='page']").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.BeauticodeReadableSurfaces.getPageBlur()), true);
  await page.evaluate(() => {
    globalThis.BeauticodeReadableSurfaces.setPage(30);
    globalThis.BeauticodeReadableSurfaces.setPageBlur(false);
  });

  t.diagnostic(`alpha-only page: column x=${pageRect.x}, absolute=${JSON.stringify(absoluteOn)}, fixed=${JSON.stringify(innerOn)}, portal=${JSON.stringify(portalOn)}, stacking=${stackingOn}, scroll=${JSON.stringify(scroll)}, scrollTop=${scrollTop}`);
  t.diagnostic(`experimental page blur: absolute=${JSON.stringify(absoluteExperimental)}, stacking=${stackingExperimental}, fixed=${JSON.stringify(innerExperimental)}, blurDelta=${experimentalDelta}, scrollTop=${experimentalScrollTop}, bottomDelta=${scrollDelta}`);
});

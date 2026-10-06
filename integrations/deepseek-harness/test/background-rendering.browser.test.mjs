import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

// Browser layout is required: a DOM stub cannot reproduce #86 or #87.
// Reuse an available Playwright runtime without adding a shipped dependency.
const runtime = process.env.BEAUTICODE_PLAYWRIGHT_MODULE;
const browserTest = runtime ? test : test.skip;
const client = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
const atmosphere = await fs.readFile(new URL("../atmosphere.js", import.meta.url), "utf8");

async function openFixture(t) {
  const { chromium } = await import(runtime);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BEAUTICODE_BROWSER_CHANNEL
      ? { channel: process.env.BEAUTICODE_BROWSER_CHANNEL } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0}#root{position:relative;height:800px}
    [data-step-process-body]{height:400px;overflow:auto}
    .host_fadeBottom{mask-image:linear-gradient(black 90%,transparent)}
    p{height:24px;margin:0}
  </style></head><body><div id="root">
    <div data-step-process-body class="host_fadeBottom">
      <div data-step-process-content>${"<p>Completed reasoning</p>".repeat(100)}</div>
    </div></div><div id="beauticode-bg-stage">
    <div class="beauticode-media-slot"><img><video></video></div>
  </div></body></html>`);
  await page.evaluate(() => {
    // Only the external host transport is stubbed; scripts, CSS, image loading,
    // preference writers, layout and the water canvas run unchanged.
    globalThis.__beauticodeTransport = { headers: () => ({}), events: () => {} };
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    globalThis.__BEAUTICODE_CANVAS_URL = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#456"/></svg>',
    );
  });
  await page.addScriptTag({ content: atmosphere });
  await page.addScriptTag({ content: client });
  await page.evaluate(() => { document.documentElement.dataset.bcActive = "true"; });
  return page;
}

async function openGallery(page) {
  await page.evaluate(() => globalThis.BeauticodeAtmosphere.setWindowMode("on"));
  await page.waitForFunction(() => document.querySelector("#beauticode-gallery-bg canvas")?.width > 300);
}

async function backgroundState(page) {
  return page.evaluate(() => {
    const gallery = document.querySelector("#beauticode-gallery-bg");
    const media = document.querySelector("#beauticode-bg-stage img");
    return {
      filter: gallery ? getComputedStyle(gallery.querySelector("img")).filter : null,
      overlay: gallery ? getComputedStyle(gallery, "::after").backgroundColor : null,
      content: gallery ? getComputedStyle(gallery, "::after").content : null,
      overlayLayer: gallery ? getComputedStyle(gallery, "::after").zIndex : null,
      waterLayer: gallery ? getComputedStyle(gallery.querySelector("canvas")).zIndex : null,
      rootFilter: getComputedStyle(document.querySelector("#root")).filter,
      mediaFilter: getComputedStyle(media).filter,
      mediaOpacity: getComputedStyle(media).opacity,
    };
  });
}

browserTest("gallery consumes blur and dim preferences in dark and light appearance (#86)", async (t) => {
  const page = await openFixture(t);
  await openGallery(page);
  for (const [tone, wantOverlay] of [
    ["dark", "rgba(0, 0, 0, 0.8)"],
    ["light", "rgba(255, 255, 255, 0.8)"],
  ]) {
    await page.evaluate((tone) => {
      document.body.toggleAttribute("data-ds-dark-theme", tone === "dark");
      document.documentElement.style.colorScheme = tone;
      globalThis.BeauticodeBackgroundBlur.set(100);
      globalThis.BeauticodeBackgroundDim.set(0.8);
    }, tone);
    await page.waitForFunction((tone) => document.documentElement.dataset.bcResolvedTone === tone, tone);
    const state = await backgroundState(page);
    assert.equal(state.filter, "blur(9px)");
    assert.equal(state.overlay, wantOverlay);
    assert.equal(state.content, '""');
    assert.ok(Number(state.overlayLayer) > Number(state.waterLayer), "dim also covers water highlights");
    assert.equal(state.rootFilter, "none", "foreground content stays sharp");
  }
  await page.evaluate(() => {
    globalThis.BeauticodeBackgroundBlur.set(0);
    globalThis.BeauticodeBackgroundDim.set(0);
  });
  const reset = await backgroundState(page);
  assert.ok(["none", "blur(0px)"].includes(reset.filter));
  assert.equal(reset.overlay, "rgba(255, 255, 255, 0)", "light overlay becomes fully transparent");
});

browserTest("background modes preserve native fading scroll bodies and scroll position (#87)", async (t) => {
  const page = await openFixture(t);
  for (const mode of ["ordinary", "gallery"]) {
    if (mode === "gallery") await openGallery(page);
    const frames = await page.evaluate(async () => {
      const body = document.querySelector("[data-step-process-body]");
      body.scrollTop = 200;
      const frames = [];
      for (let i = 0; i < 90; i++) {
        await new Promise(requestAnimationFrame);
        frames.push({ height: body.clientHeight, top: body.scrollTop, mask: getComputedStyle(body).maskImage });
      }
      return frames;
    });
    assert.ok(frames.every(frame => frame.height === 400), `${mode}: native content must stay in layout`);
    assert.ok(frames.every(frame => frame.top === 200), `${mode}: scrolling must remain stable`);
    assert.ok(frames.every(frame => frame.mask.startsWith("linear-gradient")), "retain native fading masks");
  }
});

browserTest("closing gallery restores ordinary image and video preference rendering", async (t) => {
  const page = await openFixture(t);
  await openGallery(page);
  await page.evaluate(() => {
    globalThis.BeauticodeBackgroundBlur.set(100);
    globalThis.BeauticodeBackgroundDim.set(0.8);
    globalThis.BeauticodeAtmosphere.setWindowMode("closed");
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#beauticode-bg-stage img")).opacity === "1");
  const state = await backgroundState(page);
  assert.equal(state.filter, null, "gallery layer is removed");
  assert.equal(state.mediaFilter, "blur(9px)");
  assert.equal(state.mediaOpacity, "1", "gallery no longer hides ordinary media");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#beauticode-bg-stage video")).filter), "blur(9px)");
});

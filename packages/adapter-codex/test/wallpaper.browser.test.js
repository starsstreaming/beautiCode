import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
const { loadRendererSource, buildInjectionExpression } = await import(process.env.BEAUTICODE_RENDERER_PAYLOAD || "../dist/payload.js");
const modulePath = process.env.BEAUTICODE_PLAYWRIGHT_MODULE;
const browserTest = modulePath ? test : test.skip;
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path fill="#936" d="M0 0h20v20H0z"/><path fill="#69c" d="M0 0h10v10H0z"/></svg>');
async function fixture(t) {
    const { chromium } = await import(modulePath);
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    await page.goto("about:blank");
    await page.setContent(`<html data-theme="dark"><head><style>
    body{margin:0;color:#eee}html[data-theme=light] body{color:#202124}
    #root{display:flex;height:720px}aside.app-shell-left-panel{width:230px;border-radius:24px;background:#333}
    main{flex:1;border-radius:22px;background:#333;padding:20px}.hero{border-radius:18px}
    .bg-surface{background:white} [role=menu]{padding:20px;border-radius:16px}
    [data-overlay-owner]{position:fixed;top:100px;left:300px;width:250px;height:100px}
    [role=tooltip]{background:#282033;color:#fff;border-radius:8px;padding:10px}
    #tip{position:fixed;top:300px;left:300px}
    #peek{border-radius:14px;top:450px;height:100px;padding:0}
    #peek>div{height:100px;background:white;border-radius:0}
    #unrelated{background:rgb(98,52,120)}[data-bc-ui]{background:rgb(17,34,51)!important}
    .native-header::before{content:"";background:rgb(24,24,24)}
  </style></head><body><div id=root><aside class=app-shell-left-panel>Sidebar</aside><main>
    <div class=hero>Home</div><aside id=unrelated>Other panel</aside>
    <div data-composer-body>Composer</div>
    <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col outline-none"><div class="relative h-full min-h-0"><div class="contents">
      <div class="h-full min-h-0 flex-1 overflow-y-auto relative"><div class="flex min-h-full w-full flex-col">
        <div id="library-header" class="native-header border-transparent"><div class="mx-auto w-full"><h1>Library</h1></div></div>
      </div></div>
    </div></div></div>
    <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col outline-none">
      <div id="route-shell" class="flex h-full min-h-0 flex-col bg-surface"><div class="contents">
        <div class="h-full min-h-0 flex-1 overflow-y-auto relative"><div class="flex min-h-full w-full flex-col">
          <div id="route-header" class="native-header border-transparent"><div class="mx-auto w-full"><h1>Sites</h1></div></div>
        <div id="route-content" class="mx-auto flex min-h-0 w-full flex-1 flex-col bg-surface">
          <div id="route-panel" role="tabpanel" class="mx-auto flex min-h-full w-full flex-1 flex-col bg-surface">
            <article id="reading-card" class="bg-surface">Readable card</article>
          </div>
        </div>
        </div></div>
      </div></div>
    </div>
  </main></div><div data-radix-popper-content-wrapper><div role=menu>Menu</div></div>
  <div data-overlay-owner="test"><div class=bg-surface id=overlay>Overlay</div></div>
  <div role=tooltip id=tip>Native tooltip</div>
  <div role=tooltip data-overlay-owner=slate-sidebar id=peek><div class=bg-surface>Preview</div></div>
  <div data-bc-ui data-overlay-owner=test class=bg-surface id=owned>Skin UI</div>
  <div data-bc-ui><div data-overlay-owner=test class=bg-surface id=owned-child style="background:rgb(17,34,51)">Owned nested surface</div></div></body></html>`);
    const source = await loadRendererSource();
    const inject = payload => page.evaluate(buildInjectionExpression(source.runtimeIife, payload, source.cssText));
    await inject({ generation: 1, media: "image", imageDataUrl: image });
    return { page, inject };
}
browserTest("real CSS preserves corners and native tooltips across both host themes", async (t) => {
    const { page } = await fixture(t);
    const style = (selector, property) => page.locator(selector).evaluate((e, p) => getComputedStyle(e)[p], property);
    assert.equal(await style("aside.app-shell-left-panel", "borderTopLeftRadius"), "24px");
    assert.equal(await style("main", "borderTopLeftRadius"), "22px");
    assert.equal(await style("#peek>div", "borderTopLeftRadius"), "14px");
    assert.equal(await style("#peek", "overflow"), "hidden");
    assert.equal(await style("[data-radix-popper-content-wrapper]", "backgroundColor"), "rgba(0, 0, 0, 0)");
    for (const [theme, color] of [["light", "rgb(255, 255, 255)"], ["dark", "rgb(31, 31, 31)"], ["light", "rgb(255, 255, 255)"]]) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.waitForFunction(color => getComputedStyle(document.querySelector("#overlay")).backgroundColor === color, color);
        for (const selector of ["#overlay", "#peek", "#peek>div", "[data-composer-body]", "[role=menu]"])
            assert.equal(await style(selector, "backgroundColor"), color);
        assert.equal(await style("#tip", "backgroundColor"), "rgb(40, 32, 51)");
        assert.equal(await style("#tip", "color"), "rgb(255, 255, 255)");
        assert.equal(await style("#unrelated", "backgroundColor"), "rgb(98, 52, 120)");
        assert.equal(await style("#owned", "backgroundColor"), "rgb(17, 34, 51)");
        assert.equal(await style("#owned-child", "backgroundColor"), "rgb(17, 34, 51)");
        await fs.mkdir(new URL("../../../artifacts/pr96/", import.meta.url), { recursive: true });
        await page.screenshot({ path: new URL("../../../artifacts/pr96/fixture-" + theme + ".png", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1") });
    }
    await page.evaluate(() => window.__BEAUTICODE_BG__.dispose());
    assert.equal(await style("#peek>div", "borderTopLeftRadius"), "0px");
    assert.equal(await style("#peek>div", "backgroundColor"), "rgb(255, 255, 255)");
});
browserTest("full payload repeated injection keeps the media and guest owner, then releases both", async (t) => {
    const { page, inject } = await fixture(t);
    await page.evaluate(() => { window.initialStage = document.getElementById("beauticode-bg-stage"); window.initialGuest = window.__BEAUTICODE_GUEST__; });
    for (let i = 0; i < 100; i++)
        await inject({ generation: 1, media: "image", imageDataUrl: image });
    assert.equal(await page.evaluate(() => initialStage === document.getElementById("beauticode-bg-stage")), true);
    assert.equal(await page.evaluate(() => initialGuest === window.__BEAUTICODE_GUEST__), true);
    assert.equal((await page.evaluate(() => __BEAUTICODE_BG__.snapshot())).imageLoaded, true);
    await inject({ generation: 2, media: "clear", imageDataUrl: null });
    assert.equal(await page.locator("#beauticode-bg-stage").count(), 0);
    await page.evaluate(() => __BEAUTICODE_BG__.dispose());
    assert.equal(await page.evaluate(() => Boolean(window.__BEAUTICODE_GUEST__)), false);
});
browserTest("native content shells clear only route plates while reading cards stay opaque", async (t) => {
    const { page } = await fixture(t);
    const bg = selector => page.locator(selector).evaluate(e => getComputedStyle(e).backgroundColor);
    for (const selector of ["#route-shell", "#route-content", "#route-panel"])
        assert.equal(await bg(selector), "rgba(0, 0, 0, 0)");
    assert.equal(await page.locator("#route-header").evaluate(e => getComputedStyle(e, "::before").backgroundColor), "rgba(0, 0, 0, 0)");
    assert.equal(await page.locator("#library-header").evaluate(e => getComputedStyle(e, "::before").backgroundColor), "rgba(0, 0, 0, 0)");
    assert.equal(await bg("#reading-card"), "rgb(255, 255, 255)");
    await page.evaluate(() => __BEAUTICODE_BG__.dispose());
    for (const selector of ["#route-shell", "#route-content", "#route-panel"])
        assert.equal(await bg(selector), "rgb(255, 255, 255)");
});
browserTest("real video decode, handoff, mute, seek and fish mode survive modularisation", async (t) => {
    const { page, inject } = await fixture(t);
    const data = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        canvas.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647";
        document.body.append(canvas);
        const stream = canvas.captureStream(0), recorder = new MediaRecorder(stream, { mimeType: "video/webm" }), parts = [];
        recorder.ondataavailable = e => parts.push(e.data);
        const done = new Promise(resolve => recorder.onstop = resolve);
        recorder.start();
        const ctx = canvas.getContext("2d");
        for (let i = 0; i < 8; i++) {
            ctx.fillStyle = i % 2 ? "#936" : "#69c";
            ctx.fillRect(0, 0, 16, 16);
            stream.getVideoTracks()[0].requestFrame();
            await new Promise(r => setTimeout(r, 100));
        }
        recorder.stop();
        await done;
        for (const track of stream.getTracks())
            track.stop();
        canvas.remove();
        return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(new Blob(parts, { type: "video/webm" })); });
    });
    assert.ok(data.length > 100, "recorder must emit media bytes");
    const decode = await page.evaluate(async (data) => { const v = document.createElement("video"); v.muted = true; v.src = data; try {
        await v.play();
        return { ready: v.readyState, bytes: data.length };
    }
    catch (e) {
        return { error: e.message, media: v.error?.message, bytes: data.length };
    }
    finally {
        v.src = "";
    } }, data);
    assert.ok(decode.ready >= 2, JSON.stringify(decode));
    const payload = { generation: 2, media: "video", imageDataUrl: image, video: { mode: "data", dataUrl: data } };
    await inject(payload);
    assert.equal(await page.evaluate(() => __BEAUTICODE_BG__.videoError), null);
    await page.waitForFunction(() => __BEAUTICODE_BG__.snapshot().videoReady, null, { timeout: 5000 }).catch(async () => {
        throw new Error(JSON.stringify(await page.evaluate(() => ({ snapshot: __BEAUTICODE_BG__.snapshot(), error: __BEAUTICODE_BG__.videoError, video: [...document.querySelectorAll("video")].map(v => ({ readyState: v.readyState, paused: v.paused, srcLength: v.src.length, error: v.error?.message })) }))));
    });
    assert.equal(await page.evaluate(() => __BEAUTICODE_BG__.setMuted(true).muted), true);
    assert.equal(await page.evaluate(() => __BEAUTICODE_BG__.seekTo(0).ok), true);
    assert.equal(await page.evaluate(() => __BEAUTICODE_BG__.setFishMode(true)), true);
    assert.equal(await page.evaluate(() => __BEAUTICODE_BG__.setBackgroundTone("light")), true);
    await page.evaluate(() => { window.guestBeforeHandoff = __BEAUTICODE_GUEST__; });
    await inject({ ...payload, generation: 3 });
    await page.waitForFunction(() => __BEAUTICODE_BG__.snapshot().videoReady, null, { timeout: 5000 }).catch(async () => {
        throw new Error(JSON.stringify(await page.evaluate(() => ({ snapshot: __BEAUTICODE_BG__.snapshot(), error: __BEAUTICODE_BG__.videoError, video: [...document.querySelectorAll("video")].map(v => ({ readyState: v.readyState, paused: v.paused, srcLength: v.src.length, error: v.error?.message })) }))));
    });
    const snap = await page.evaluate(() => __BEAUTICODE_BG__.snapshot());
    assert.equal(snap.videoCount, 1);
    assert.equal(snap.fish, true);
    assert.equal(snap.muted, true);
    assert.equal(await page.evaluate(() => __BEAUTICODE_BG__.isBackgroundTone()), "light");
    assert.equal(await page.evaluate(() => guestBeforeHandoff === __BEAUTICODE_GUEST__), true);
    await page.evaluate(() => __BEAUTICODE_BG__.dispose());
    assert.equal(await page.locator("#beauticode-bg-stage").count(), 0);
});

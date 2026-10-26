import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRendererSource, buildInjectionExpression } from '../dist/payload.js';

const runtime = process.env.BEAUTICODE_PLAYWRIGHT_MODULE;
const browserTest = runtime ? test : test.skip;
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#789"/></svg>');

async function fixture(t, stored = '0.46', tone = 'dark') {
  const { chromium } = await import(runtime);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://127.0.0.1:19335/**', route => route.fulfill({ body: `<!doctype html><html data-theme="${tone}"><head><style>
    .bg-surface {background:rgb(24,24,24)} [data-composer-body]{background:#333}
    .from-surface {background-image:linear-gradient(to top, #181818, transparent)}
    main{height:600px} .decoration{height:240px}
  </style></head><body><div id="root"><main>
    <div class="thread-scroll-container"><div>
      <div class="pointer-events-none sticky bottom-0">
        <div id="thread-fade" class="pointer-events-none absolute inset-x-0 from-surface"></div>
        <div id="nonempty-fade" class="pointer-events-none absolute inset-x-0 from-surface">Content</div>
      </div>
      <div id="unpositioned-fade" class="pointer-events-none absolute inset-x-0 from-surface"></div>
    </div></div>
    <div class="pointer-events-none sticky bottom-0">
      <div id="unrelated-fade" class="pointer-events-none absolute inset-x-0 from-surface"></div>
    </div>
    <div class="pointer-events-none absolute inset-x-0 bottom-0">
      <div id="decoration" class="decoration pointer-events-none absolute inset-x-0 bottom-0 bg-surface"></div>
      <div data-composer-body><textarea aria-label="Draft"></textarea></div>
    </div><div role="dialog">Dialog</div><div class="bg-surface" id="unrelated">Other surface</div>
  </main></div></body></html>`, contentType: 'text/html' }));
  await page.goto('http://127.0.0.1:19335/');
  await page.evaluate(value => { if(value !== null) localStorage.setItem('beauticode-dim',value); }, stored);
  const source = await loadRendererSource();
  await page.evaluate(buildInjectionExpression(source.runtimeIife, { generation: 1, media: 'image', imageDataUrl: image }, source.cssText));
  return { page, source };
}

browserTest('saved shadow is restored before the first active background without a console', async t => {
  const { page } = await fixture(t);
  assert.equal(await page.locator('#beauticode-bg-stage').evaluate(n => getComputedStyle(n,'::after').backgroundColor), 'rgba(0, 0, 0, 0.46)');
});

browserTest('host root style replacement cannot desynchronise saved shadow from its setting', async t => {
  const { page, source } = await fixture(t);
  await page.addScriptTag({ content: source.consoleSource });
  await page.evaluate(() => document.documentElement.setAttribute('style','--font-ui-size:14px'));
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#beauticode-bg-stage').evaluate(n => getComputedStyle(n,'::after').backgroundColor), 'rgba(0, 0, 0, 0.46)');
  assert.equal(await page.locator('.bc-dim-value').first().textContent(), '46%');
});

browserTest('zero, automatic and invalid stored shadow keep their intended appearance', async t => {
  for (const [stored, tone, expected] of [
    ['0', 'dark', 'rgba(0, 0, 0, 0)'],
    [null, 'dark', 'rgba(0, 0, 0, 0)'],
    ['invalid', 'light', 'rgba(255, 255, 255, 0.48)'],
    ['0.46', 'light', 'rgba(255, 255, 255, 0.46)'],
  ]) {
    const { page, source } = await fixture(t, stored, tone);
    assert.equal(await page.locator('#beauticode-bg-stage').evaluate(n => getComputedStyle(n,'::after').backgroundColor), expected);
    await page.addScriptTag({ content: source.consoleSource });
    const stage = await page.locator('#beauticode-bg-stage').elementHandle();
    await page.evaluate(() => { BeauticodeBackgroundDim.set(0.7); BeauticodeBackgroundDim.clear(); });
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => localStorage.getItem('beauticode-dim')), null);
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--bc-dim')), '');
    assert.equal(await stage.evaluate(n => n === document.getElementById('beauticode-bg-stage')), true);
    await page.close();
  }
});

browserTest('new composer decoration is transparent while composer and dialogs stay opaque', async t => {
  const { page } = await fixture(t);
  const bg = selector => page.locator(selector).evaluate(n => getComputedStyle(n).backgroundColor);
  assert.equal(await bg('#decoration'), 'rgba(0, 0, 0, 0)');
  assert.equal(await bg('[data-composer-body]'), 'rgb(31, 31, 31)');
  assert.equal(await bg('[role=dialog]'), 'rgb(31, 31, 31)');
  assert.equal(await bg('#unrelated'), 'rgb(24, 24, 24)');
  await page.evaluate(() => window.__BEAUTICODE_BG__.dispose());
  assert.equal(await bg('#decoration'), 'rgb(24, 24, 24)');
});

browserTest('empty sticky thread fade above the composer clears only while wallpaper is active', async t => {
  const { page } = await fixture(t);
  const gradient = selector => page.locator(selector).evaluate(n => getComputedStyle(n).backgroundImage);
  for (const tone of ['light', 'dark', 'light']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), tone);
    assert.equal(await gradient('#thread-fade'), 'none');
    for (const selector of ['#nonempty-fade', '#unpositioned-fade', '#unrelated-fade']) {
      assert.match(await gradient(selector), /linear-gradient/);
    }
    assert.notEqual(await page.locator('[data-composer-body]').evaluate(n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)');
  }
  await page.evaluate(() => window.__BEAUTICODE_BG__.dispose());
  assert.match(await gradient('#thread-fade'), /linear-gradient/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

const runtime = process.env.BEAUTICODE_PLAYWRIGHT_MODULE;
const browserTest = runtime ? test : test.skip;
for (const host of ['codex', 'dsh']) {
  browserTest(`${host} gallery confines keyboard focus, restores it, and ignores stale responses`, async t => {
    const { chromium } = await import(runtime);
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:19339/**', route => route.fulfill({ body: '<button id="opener">Open</button><textarea id="composer"></textarea>', contentType: 'text/html' }));
    await page.goto('http://127.0.0.1:19339/');
    await page.evaluate(() => {
      const payload = route => route.includes('/config') ? { enabled: true, url: '' } : { skins: [{ id: 'skin-abcdefgh', name: route.includes('type=image') ? 'old-image' : 'new-video', type: 'video' }] };
      window.fetch = async route => {
        await new Promise(r => setTimeout(r, route.includes('type=image') ? 180 : 10));
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => payload(route) };
      };
      window.beauticodeConsole = raw => {
        const req = JSON.parse(raw);
        setTimeout(() => {
          const pending = window.__beauticodeBridgePending.get(req.id);
          window.__beauticodeBridgePending.delete(req.id);
          pending.resolve(payload(req.path));
        }, req.path.includes('type=image') ? 180 : 10);
      };
    });
    const source = host === 'codex' ? new URL('../src/renderer/gallery.js', import.meta.url) : new URL('../../../integrations/deepseek-harness/gallery.js', import.meta.url);
    await page.addScriptTag({ content: await fs.readFile(source, 'utf8') });
    await page.locator('#opener').focus();
    await page.evaluate(() => window.BeauticodeGallery.open());
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('fixture');
    assert.equal(await page.locator('#composer').inputValue(), '');
    assert.equal(await page.evaluate(() => document.getElementById('beauticode-gallery').contains(document.activeElement)), true);
    await page.locator('.bcg-type').selectOption('image');
    await page.locator('.bcg-type').selectOption('video');
    await page.waitForTimeout(250);
    assert.match(await page.locator('.bcg-grid').innerText(), /new-video/);
    assert.doesNotMatch(await page.locator('.bcg-grid').innerText(), /old-image/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#beauticode-gallery').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');
    await page.evaluate(() => window.BeauticodeGallery.open());
    await page.locator('.bcg-type').selectOption('image');
    await page.evaluate(() => window.BeauticodeGallery.close());
    await page.waitForTimeout(250);
    assert.doesNotMatch(await page.locator('.bcg-grid').textContent(), /old-image/);
  });
}

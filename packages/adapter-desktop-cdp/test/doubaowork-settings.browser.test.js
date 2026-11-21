import assert from 'node:assert/strict';
import test from 'node:test';

const browserTest = process.env.BEAUTICODE_PLAYWRIGHT_MODULE ? test : test.skip;

browserTest('Doubao Work appearance settings synchronize resets and keep library navigation keyboard accessible', async t => {
  const {
    buildDoubaoWorkBackgroundCleanup, buildDoubaoWorkBackgroundInjection,
  } = await import('../../adapter-doubaowork/dist/index.js');
  const { chromium } = await import(process.env.BEAUTICODE_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main id="chat-route-layout"></main><aside data-testid="settings_modal"><section><h2>设置</h2><p>通用</p></section></aside>');
  assert.equal(await page.evaluate(buildDoubaoWorkBackgroundInjection()), 'ok');
  const panel = page.locator('#beauticode-doubaowork-background-panel');
  await panel.waitFor({ state: 'hidden' });

  await page.locator('[data-testid="settings_modal"] section').evaluate(section => {
    section.innerHTML = '<h2>外观设置</h2><p>终端代码字体</p>';
  });
  await panel.waitFor({ state: 'visible' });
  for (const [property, label, value, reset] of [
    ['dim', '背景阴影', 85, 49], ['blur', '背景磨砂', 40, 0],
  ]) {
    const slider = panel.getByRole('slider', { name: label });
    await slider.fill(String(value));
    assert.equal(await slider.getAttribute('aria-valuetext'), value + '%');
    await panel.locator('[data-action="' + property + '-reset"]').click();
    assert.equal(await slider.inputValue(), String(reset));
    assert.equal(await slider.getAttribute('aria-valuetext'), reset + '%');
    assert.equal(await slider.evaluate(el => el.style.getPropertyValue('--bc-range-pct')), reset + '%');
  }
  assert.deepEqual(await page.evaluate(() => {
    const { dim, blur } = JSON.parse(window.__bcDesktopPersistGet());
    return [dim, blur];
  }), [49, 0]);

  const trigger = panel.locator('[data-action="library"]');
  const library = page.getByRole('dialog', { name: 'Wallpaper Engine 本地壁纸库' });
  await trigger.click();
  const first = await page.evaluate(() => window.__bcDesktopLibraryRequest);
  await library.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await library.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
  assert.equal(await page.evaluate(id => window.__bcDesktopShowLibrary(id, { items: [] }), first.requestId), false);

  await trigger.press('Enter');
  const reopened = await page.evaluate(() => window.__bcDesktopLibraryRequest);
  const catalog = { offset: 0, limit: 80, total: 81, items: [{ id: 'opaque-0', type: 'video', title: '壁纸 A' }] };
  assert.equal(await page.evaluate(({ id, catalog }) => window.__bcDesktopShowLibrary(id, catalog), {
    id: reopened.requestId, catalog,
  }), true);
  await library.getByRole('button', { name: '下一页' }).press('Enter');
  const second = await page.evaluate(() => window.__bcDesktopLibraryRequest);
  assert.equal(second.offset, 80);
  assert.equal(second.refresh, false);
  await page.evaluate(id => window.__bcDesktopShowLibrary(id, {
    offset: 80, limit: 80, total: 81, items: [{ id: 'opaque-1', type: 'scene', title: '壁纸 B' }],
  }), second.requestId);
  await library.getByRole('button', { name: '壁纸 B 场景预览' }).press('Enter');
  await page.getByRole('button', { name: '保存并应用' }).press('Enter');
  const apply = await page.evaluate(() => window.__bcDesktopApplyRequest);
  assert.equal(apply.mode, 'library');
  assert.equal(apply.libraryId, 'opaque-1');
  assert.equal(apply.path, undefined);

  await page.evaluate(buildDoubaoWorkBackgroundCleanup());
  assert.equal(await panel.count(), 0);
  assert.equal(await page.evaluate(() => typeof window.__bcDesktopShowLibrary), 'undefined');
});

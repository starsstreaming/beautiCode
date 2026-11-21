import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildDesktopBackgroundInjection, buildDesktopBackgroundCleanup } from '../dist/index.js';
import { CURSOR_CDP_SPEC } from '../../adapter-cursor/dist/spec.js';
import { BACKDROP_SELECTORS } from '../../adapter-workbuddy/dist/contract.js';
import { buildMediaHealthProbe, mediaHealthState, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../../core/dist/index.js';

const browserTest=process.env.BEAUTICODE_PLAYWRIGHT_MODULE?test:test.skip;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(t,label='Customize') {
  const {chromium}=await import(process.env.BEAUTICODE_PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent(`<button data-action-id="marketplace" data-sidebar-primary-action><span class="ui-sidebar-menu-button-label">${label}</span></button>`);
  assert.equal(await page.evaluate(buildDesktopBackgroundInjection(CURSOR_CDP_SPEC)),'ok');
  await page.evaluate(()=>{
    const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    window.liveUrls=new Set();window.urlNames={};
    URL.createObjectURL=file=>{const url=create(file);liveUrls.add(url);urlNames[url]=file.name;return url};
    URL.revokeObjectURL=url=>{liveUrls.delete(url);revoke(url)};
    const add=HTMLImageElement.prototype.addEventListener;
    HTMLImageElement.prototype.addEventListener=function(type,fn,options){
      if(type==='load'){const el=this;return add.call(this,type,function(e){if(urlNames[el.src]==='slow.png')setTimeout(()=>fn.call(el,e),160);else fn.call(el,e)},options)}
      return add.call(this,type,fn,options);
    };
  });
  return page;
}
async function apply(page,name,id) {
  await page.evaluate(({name,id})=>window.__bcDesktopPrepareFile({mode:'gallery',path:name,name,requestId:id,save:true}),{name,id});
  await page.locator('[data-id="fileInput"]').setInputFiles({name,mimeType:'image/png',buffer:png});
}
browserTest('slow old media cannot replace the latest selection; clear cancels pending loads and cleanup releases resources',async t=>{
  const page=await fixture(t);
  await apply(page,'slow.png','a');await apply(page,'fast.png','b');
  await page.waitForFunction(()=>window.__bcDesktopApplyResult.b?.status==='ok');
  await page.waitForTimeout(190);
  assert.equal(await page.evaluate(()=>JSON.parse(window.__bcDesktopPersistGet()).wallpaper),'fast.png');
  assert.equal(await page.evaluate(()=>window.__bcDesktopApplyResult.a.status),'error');
  await apply(page,'slow.png','c');
  await page.evaluate(()=>document.querySelector('[data-action="clear"] button').click());
  await page.waitForTimeout(190);
  assert.equal(await page.locator('#beauticode-bg-stage .bc-media').count(),0);
  for(let i=0;i<100;i++) {await apply(page,'fast.png',`loop-${i}`);await page.waitForFunction(id=>window.__bcDesktopApplyResult[id]?.status==='ok',`loop-${i}`);}
  assert.ok(await page.evaluate(()=>Object.keys(window.__bcDesktopApplyResult).length)<=64);
  assert.equal(await page.evaluate(()=>window.liveUrls.size),1);
  await apply(page,'slow.png','dispose-pending');
  await page.evaluate(buildDesktopBackgroundCleanup('cursor'));
  await page.waitForTimeout(190);
  assert.equal(await page.evaluate(()=>window.liveUrls.size),0);
  assert.equal(await page.evaluate(()=>typeof window.__bcDesktopApplyResult),'undefined');
});
browserTest('localized Cursor anchors retain structural checks and picker formats match core',async t=>{
  const page=await fixture(t,'自定义');
  assert.equal(await page.locator('[data-id="fileInput"]').getAttribute('accept'),[...IMAGE_EXTENSIONS,...VIDEO_EXTENSIONS].join(','));
  await page.evaluate(buildDesktopBackgroundCleanup('cursor'));
  await page.locator('[data-action-id="marketplace"] span').evaluate(n=>n.textContent='Unrelated');
  assert.equal(await page.evaluate(buildDesktopBackgroundInjection(CURSOR_CDP_SPEC)),'anchor-text-mismatch');
});
browserTest('media health distinguishes empty, broken, hidden, and known occluded backgrounds',async t=>{
  const page=await fixture(t);
  const probe=buildMediaHealthProbe(BACKDROP_SELECTORS);
  assert.equal(mediaHealthState(await page.evaluate(probe)),'no-background');
  await apply(page,'fast.png','h');await page.waitForFunction(()=>window.__bcDesktopApplyResult.h?.status==='ok');
  assert.equal(mediaHealthState(await page.evaluate(probe)),'presentation-unverified');
  await page.evaluate(()=>{const cover=document.createElement('div');cover.className='layout-window-frame__body';cover.style.cssText='position:fixed;inset:0;background:rgb(248,253,255)';document.body.append(cover)});
  assert.equal(mediaHealthState(await page.evaluate(probe)),'injected-but-occluded');
  for (const background of ['color(srgb 1 1 1 / 0.82)', 'color-mix(in srgb, white 40%, transparent)', 'linear-gradient(transparent, transparent)']) {
    await page.locator('.layout-window-frame__body').evaluate((n, background) => n.style.background = background, background);
    assert.equal(mediaHealthState(await page.evaluate(probe)), 'presentation-unverified', background);
  }
  const cover = page.locator('.layout-window-frame__body');
  await cover.evaluate(n => n.style.background = 'color(srgb 1 1 1 / 0.95)');
  assert.deepEqual((await page.evaluate(probe)).opaqueSelectors, ['.layout-window-frame__body']);
  await cover.evaluate(n => n.style.transform = 'translateY(100vh)');
  assert.deepEqual((await page.evaluate(probe)).opaqueSelectors, []);
  await page.locator('.layout-window-frame__body').evaluate(n=>n.style.display='none');
  assert.equal(mediaHealthState(await page.evaluate(probe)),'presentation-unverified');
  await page.locator('.bc-media').evaluate(n=>n.style.visibility='hidden');
  assert.equal(mediaHealthState(await page.evaluate(probe)),'injected-but-occluded');

  await page.evaluate(() => {
    const video = document.createElement('video');
    video.className = 'bc-media';
    Object.defineProperties(video, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_METADATA },
      videoWidth: { value: 1280 },
    });
    document.getElementById('beauticode-bg-stage').replaceChildren(video);
  });
  assert.equal(mediaHealthState(await page.evaluate(probe)), 'media-not-ready');
  await page.locator('video.bc-media').evaluate(video =>
    Object.defineProperty(video, 'readyState', { value: HTMLMediaElement.HAVE_CURRENT_DATA }));
  assert.equal((await page.evaluate(probe)).media, true);
});
browserTest('atmosphere respects reduced motion and resumes when preference changes',async t=>{
  const page=await fixture(t);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{window.__BEAUTICODE_CANVAS_URL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';window.draws=0;const draw=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(...args){window.draws++;return draw.apply(this,args)}});
  await page.addScriptTag({content:await fs.readFile(new URL('../../../integrations/deepseek-harness/atmosphere.js',import.meta.url),'utf8')});
  await page.evaluate(()=>window.BeauticodeAtmosphere.setWindowMode('on'));
  await page.waitForTimeout(180);const before=await page.evaluate(()=>window.draws);
  await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>window.draws),before);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(before=>window.draws>before,before);
  await page.evaluate(()=>window.BeauticodeAtmosphere.setWindowMode('closed'));
});

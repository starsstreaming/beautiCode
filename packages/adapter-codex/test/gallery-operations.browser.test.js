import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const run=process.env.BEAUTICODE_PLAYWRIGHT_MODULE?test:test.skip;
for(const host of ['codex','dsh'])run(`${host} cancels queries and reconnects to an installation receipt`,async t=>{
 const {chromium}=await import(process.env.BEAUTICODE_PLAYWRIGHT_MODULE),browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('http://127.0.0.1:19409/**',route=>route.fulfill({body:'<button id="opener">open</button>',contentType:'text/html'}));await page.goto('http://127.0.0.1:19409/');
 await page.evaluate(()=>{
  window.cancelled=0;window.complete=false;window.phase='download';window.calls=[];const controllers=new Map();
  function response(req){
   if(req.path.includes('/config'))return{ok:true,enabled:true,url:''};
   if(req.path.includes('/operation')){const b=req.body;window.calls.push(b.action);if(b.action==='start')return{ok:true,id:'op-fixture'};if(b.action==='cancel'){window.cancelled++;return{ok:true,cancellable:false,message:'正在提交'}};return{ok:true,phase:window.phase,...(window.complete?{result:{ok:true,message:'恢复结果成功'}}:{})};}
   return{ok:true,skins:[{id:'skin-abcdefgh',name:'fixture',type:'image'}]};
  }
  window.fetch=(url,init={})=>new Promise((resolve,reject)=>{
   const req={path:url,body:JSON.parse(init.body||'null')};const timer=setTimeout(()=>resolve({ok:true,headers:{get:()=> 'application/json'},json:async()=>response(req)}),url.includes('type=image')?250:5);
   init.signal?.addEventListener('abort',()=>{clearTimeout(timer);window.cancelled++;reject(new DOMException('aborted','AbortError'))},{once:true});
  });
  window.beauticodeConsole=raw=>{const req=JSON.parse(raw);if(req.path.endsWith('/cancel-request')){const timer=controllers.get(req.body.requestId);if(timer){clearTimeout(timer);controllers.delete(req.body.requestId);window.cancelled++;}return;}
   const timer=setTimeout(()=>{controllers.delete(req.id);const p=window.__beauticodeBridgePending.get(req.id);if(p)p.resolve(response(req));},req.path.includes('type=image')?250:5);controllers.set(req.id,timer);
  };
 });
 const file=host==='codex'?new URL('../src/renderer/gallery.js',import.meta.url):new URL('../../../integrations/deepseek-harness/gallery.js',import.meta.url);await page.addScriptTag({content:await fs.readFile(file,'utf8')});
 await page.evaluate(()=>window.BeauticodeGallery.open());await page.locator('.bcg-type').selectOption('image');await page.locator('.bcg-type').selectOption('video');await page.waitForFunction(()=>window.cancelled>0);
 await page.locator('[data-id="skin-abcdefgh"]').click();await page.waitForFunction(()=>sessionStorage.getItem('beauticode-gallery-operation')==='op-fixture');
 await page.evaluate(()=>{window.phase='apply';window.BeauticodeGallery.close();window.complete=true});await page.evaluate(()=>window.BeauticodeGallery.open());
 await page.waitForFunction(()=>document.querySelector('.bcg-msg').textContent==='恢复结果成功');assert.equal(await page.evaluate(()=>sessionStorage.getItem('beauticode-gallery-operation')),null);
});

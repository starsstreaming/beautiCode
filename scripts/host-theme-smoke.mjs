/** Run real renderer payloads in Chromium against each host's semantic DOM. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');
const repo = path.resolve(import.meta.dirname, '..');
const bundle = process.argv[3] ? path.resolve(process.argv[3]) : null;
const load = (local, packed) => import(pathToFileURL(path.join(bundle || repo, bundle ? packed : local)).href);
const { loadRendererSource, buildInjectionExpression } = await load('packages/adapter-codex/dist/payload.js','runtime/codex/vendor/adapter-codex/payload.js');
const { buildContractCss } = await load('packages/adapter-workbuddy/dist/contract.js','runtime/workbuddy/packages/adapter-workbuddy/dist/contract.js');
const { BACKGROUND_BAR_INJECTION } = await load('packages/adapter-workbuddy/dist/background-bar.js','runtime/workbuddy/packages/adapter-workbuddy/dist/background-bar.js');
const { buildDesktopBackgroundInjection } = await load('packages/adapter-desktop-cdp/dist/runtime.js','runtime/desktop/packages/adapter-desktop-cdp/dist/runtime.js');
const { CURSOR_CDP_SPEC } = await load('packages/adapter-cursor/dist/spec.js','runtime/desktop/packages/adapter-cursor/dist/spec.js');
const { DOUBAO_CDP_SPEC } = await load('packages/adapter-doubao/dist/spec.js','runtime/desktop/packages/adapter-doubao/dist/spec.js');
const dshDir = path.join(bundle || repo, bundle ? 'runtime/dsh' : 'integrations/deepseek-harness');
const output = path.join(repo, 'artifacts/five-host-theme');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1100, height: 760 } });
const codex = await loadRendererSource();
const png = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#000"/></svg>');
const doms = {
  codex: '<div id="root"><aside class="app-shell-left-panel">Sidebar</aside><main><p>Conversation text</p><form><textarea>Draft</textarea></form></main></div><div role="dialog">Settings panel</div>',
  workbuddy: '<div id="root" class="teams-container"><div data-view-id="sidebar"><div class="conversation-list"><div class="conversation-list-tabs"><button class="conversation-list-tab-button">Tasks</button></div></div></div><main class="conversation-shell"><p>Conversation text</p><div class="cr-input-container">Draft</div></main></div><div role="dialog">Settings panel</div>',
  cursor: '<div class="monaco-workbench"><div class="agent-sidebar-header-actions"><div></div><div class="agent-sidebar-cell"><span class="agent-sidebar-cell-text">Customize</span></div></div><aside class="ui-sidebar">Sidebar</aside><main class="agent-panel"><p>Conversation text</p><div class="ui-prompt-input__container">Draft</div></main></div><div role="dialog">Settings panel</div>',
  doubao: '<div id="chat-route-layout"><aside id="flow_chat_sidebar"><div data-testid="skill-page-item-more"><div><span class="font-medium">更多</span></div></div>Sidebar</aside><main id="chat-route-main"><p>Conversation text</p><div class="guidance-input-surface">Draft</div></main></div><div role="dialog">Settings panel</div>',
  dsh: '<div id="root"><main><p>Conversation text</p><div data-composer-card>Draft</div></main></div><div role="dialog">Settings panel</div>',
};
const markers = {
  codex: ['light', 'dark', 'light'],
  workbuddy: ['cb-light', 'cb-dark', 'vscode-light'],
  cursor: ['cursor-light', 'cursor-dark', 'vs'],
  doubao: ['light', 'dark', 'light'],
  dsh: ['light', 'dark', 'light'],
};
const sidebars = {codex:'aside',workbuddy:'[data-view-id="sidebar"]',cursor:'.ui-sidebar',doubao:'#flow_chat_sidebar'};
const composers = {codex:'form',workbuddy:'.cr-input-container',cursor:'.ui-prompt-input__container',doubao:'.guidance-input-surface',dsh:'[data-composer-card]'};
function luminance(values) {
  return values.map(c => c/255).map(c => c<=.04045?c/12.92:((c+.055)/1.055)**2.4)
    .reduce((sum,c,i) => sum+c*[.2126,.7152,.0722][i],0);
}
function contrastOnBlack(surface) {
  const channels = surface.text.match(/[\d.]+/g).slice(0,3).map(Number);
  const background = luminance(surface.rgba.slice(0,3).map(c=>c*surface.rgba[3]/255));
  const foreground = luminance(channels);
  return (Math.max(background,foreground)+.05)/(Math.min(background,foreground)+.05);
}
const failures = [], results = [];
for (const host of Object.keys(doms)) {
  const page = await context.newPage();
  try {
    await page.setContent(`<html><head><style>
      html,body{margin:0}body{color:#eee;background:#151515}
      html.light body,html.cb-light body,html.vscode-light body,html.cursor-light body,html.vs body,html[data-theme=light] body,body[data-theme=light]{color:#202124;background:#fff}
      main{position:relative;padding:30px;margin:60px 250px;background:#fff}aside{padding:20px;width:220px}
      [role=dialog]{position:fixed;inset:100px 260px 200px;background:#fff;padding:40px;color:inherit}
      form,.cr-input-container,.ui-prompt-input__container,.guidance-input-surface{padding:20px;background:inherit}
      #root{position:relative;z-index:1} :root{--wb-bg-primary:#fff;--dsw-static-neutral-bluish-800:#232833;--dsw-static-neutral-bluish-00:#fff;--dsw-alias-bg-layer-2:rgba(35,40,51,.32)}
      [role=dialog]{background:var(--dsw-alias-bg-layer-2,#fff)}
    </style></head><body>${doms[host]}</body></html>`);
    await page.evaluate(({host,marker}) => {
      if (host==='doubao') document.body.dataset.theme=marker;
      else document.documentElement.className=marker;
      document.documentElement.dataset.bcActive='true';
      if(host==='dsh')document.documentElement.dataset.bcResolvedTone='light';
    }, { host, marker: markers[host][0] });
    if (host==='codex') {
      await page.evaluate(buildInjectionExpression(codex.runtimeIife, { generation: 1, media: 'image', imageDataUrl: png }, codex.cssText));
    } else if (host==='workbuddy') {
      await page.addStyleTag({ content: buildContractCss({ theme: 'light' }) });
      const injection = BACKGROUND_BAR_INJECTION.replaceAll('__BC_GALLERY_PORT__','0').replaceAll('__BC_GALLERY_TOKEN__','""').replaceAll('__BC_CENTER_URL__','""');
      assert.equal(await page.evaluate(injection), 'ok');
    } else if (host==='cursor'||host==='doubao') {
      assert.equal(await page.evaluate(buildDesktopBackgroundInjection(host==='cursor'?CURSOR_CDP_SPEC:DOUBAO_CDP_SPEC)), 'ok');
    } else {
      const client = await fs.readFile(path.join(dshDir,'client.js'),'utf8');
      await page.addStyleTag({ content: client.match(/style.textContent = `([\s\S]*?)`;/)[1].replaceAll('${CROSSFADE_MS}','180') });
      await page.addScriptTag({ content: await fs.readFile(path.join(dshDir,'readability.js'),'utf8') });
    }
    await page.evaluate((host) => {
      const stage = document.getElementById('beauticode-bg-stage');
      if(stage){stage.style.backgroundImage='linear-gradient(#000,#000)';window.testStage=stage;}
      document.documentElement.dataset.bcActive='true';
      document.documentElement.dataset.bcDimUser='true';
      // Codex reads light-mode text off its veil, so this host is exercised with
      // the shipped tone defaults: zeroing the veil (or the shadow var that feeds
      // it) would test a combination the renderer never ships by default. Its
      // panel slider is still zeroed to prove the veil alone carries contrast.
      if(host!=='codex'){
        document.documentElement.style.setProperty('--bc-dim','0');
        document.documentElement.style.setProperty('--bc-scrim-val','0');
      }
      document.documentElement.style.setProperty('--bc-surface-alpha-pct','0%');
    }, host);
    for (let i=0;i<3;i++) {
      const light = i!==1;
      await page.evaluate(({host,marker,light}) => {
        if(host==='doubao')document.body.dataset.theme=marker;
        else document.documentElement.className=marker;
        if(host==='dsh')document.documentElement.dataset.bcResolvedTone=light?'light':'dark';
      }, {host,marker:markers[host][i],light});
      await page.waitForTimeout(100);
      const state = await page.evaluate(({sidebar,composer}) => {
        const rgb = selector => {
          const el=document.querySelector(selector),cs=getComputedStyle(el);
          const ctx=document.createElement('canvas').getContext('2d');
          ctx.fillStyle=cs.backgroundColor;ctx.fillRect(0,0,1,1);
          return {color:cs.backgroundColor,rgba:[...ctx.getImageData(0,0,1,1).data],text:cs.color};
        };
        const stage=document.getElementById('beauticode-bg-stage');
        const after=stage?getComputedStyle(stage,'::after'):null;
        // Composite the stage overlay over the black stage so the veil strength
        // is read as the pixels a user actually sees.
        let veil=null;
        if(after){
          const ctx=document.createElement('canvas').getContext('2d');
          ctx.fillStyle='#000';ctx.fillRect(0,0,1,1);
          ctx.fillStyle=after.backgroundColor;ctx.fillRect(0,0,1,1);
          veil=[...ctx.getImageData(0,0,1,1).data];
        }
        return {theme:document.documentElement.dataset.bcResolvedTone||document.documentElement.dataset.bcTheme,
          dialog:rgb('[role=dialog]'),main:rgb('main'),sidebar:sidebar?rgb(sidebar):null,composer:rgb(composer),
          veil,scrim:after?after.backgroundColor:null,
          stageStable:!window.testStage||window.testStage===document.getElementById('beauticode-bg-stage')};
      }, {sidebar:sidebars[host],composer:composers[host]});
      assert.equal(state.stageStable,true, `${host}: theme switch rebuilt media`);
      if(host==='codex'||host==='cursor'||host==='doubao')assert.equal(state.theme,light?'light':'dark',`${host}: host theme must outrank system dark preference`);
      assert.equal(state.dialog.rgba[3],255,`${host}: settings must hide underlying text`);
      assert.equal(state.composer.rgba[3],255,`${host}: composer must hide the transcript`);
      if(light){
        assert.ok(state.dialog.rgba[0]>=240,`${host}: light settings retain a dark fill`);
        if(host==='codex'){
          // Codex keeps the picture: reading surfaces stay transparent and the
          // white veil above the media supplies the contrast instead.
          assert.equal(state.main.rgba[3],0,`${host}: light reading area must not paint a plate over the wallpaper`);
          assert.equal(state.sidebar.rgba[3],0,`${host}: light sidebar must not paint a plate over the wallpaper`);
          assert.ok(state.veil&&state.veil[3]===255,`${host}: no light veil over the media (${state.scrim})`);
          assert.ok(state.veil[0]>=128&&state.veil[0]===state.veil[1]&&state.veil[1]===state.veil[2],
            `${host}: light veil must be white, got ${state.scrim}`);
          const veiled=luminance(state.veil.slice(0,3));
          const textL=luminance(state.main.text.match(/[\d.]+/g).slice(0,3).map(Number));
          const ratio=(Math.max(veiled,textL)+.05)/(Math.min(veiled,textL)+.05);
          assert.ok(ratio>=4.5,
            `${host}: light text over the veil on a black wallpaper is ${ratio.toFixed(2)}:1 (${state.scrim})`);
        } else if(host!=='dsh'){
          assert.ok(state.main.rgba[0]>=240&&state.main.rgba[3]>=209,`${host}: light reading area has no white backing at zero shadow`);
          assert.ok(contrastOnBlack(state.main)>=4.5,`${host}: light text contrast on a black wallpaper is insufficient`);
          assert.ok(state.sidebar.rgba[0]>=240&&state.sidebar.rgba[3]>=209,`${host}: light sidebar text has no white backing`);
        }
      }
      results.push({host,mode:light?'light':'dark',marker:markers[host][i],state});
    }
    await page.screenshot({path:path.join(output,`${host}-light.png`)});
    if(host==='cursor'){
      await page.evaluate(() => {
        document.documentElement.className='';document.body.className='';
        document.querySelector('.monaco-workbench').classList.add('hc-light');
      });
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(()=>document.documentElement.dataset.bcTheme),'high-contrast-light');
      assert.equal(await page.locator('main').evaluate(el=>getComputedStyle(el).backgroundColor),'color(srgb 1 1 1)');
      await page.evaluate(() => document.querySelector('.monaco-workbench').classList.remove('hc-light'));
    }
    if(host==='codex'){
      await page.evaluate(()=>window.__BEAUTICODE_BG__.dispose());
      assert.equal(await page.evaluate(()=>!!window.__BEAUTICODE_THEME__),false,'Codex theme observer must be released');
    }else if(host==='cursor'||host==='doubao'){
      await page.evaluate(()=>{
        document.querySelector('.bc-desktop-pop [data-action="clear"]').click();
      });
    }else await page.evaluate(()=>document.documentElement.removeAttribute('data-bc-active'));
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.bcActive==='true'),false,'clear deactivates readability');
    if(host==='workbuddy') {
      // The older WB contract still owns transparent shells after clear; this
      // fix releases its protected dialog back to that existing contract.
      assert.equal(await page.locator('[role=dialog]').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(35, 40, 51, 0.32)');
    } else assert.equal(await page.locator('main').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)','clearing restores the authored host background');
    console.log(`PASS: ${host}, light → dark → light, zero shadow / full panel transparency`);
  } catch(error) { failures.push({host,error:String(error.message)}); console.log(`FAIL: ${host}: ${error.message}`); }
  finally { await page.close(); }
}
await fs.writeFile(path.join(output,'results.json'), JSON.stringify({results,failures},null,2));
await browser.close();
assert.deepEqual(failures,[], 'all five host renderers must remain readable');

import type { DesktopCdpHostSpec } from "./types.js";

export const DESKTOP_BACKGROUND_SCHEMA = "beauticode.desktop-background.v1";
export const DESKTOP_BACKGROUND_VERSION = "v1.3";

/**
 * Host-parameterized renderer payload. Media bytes never cross Runtime.evaluate:
 * the runner uses DOM.setFileInputFiles and this payload consumes the resulting
 * File as a blob URL, so a multi-gigabyte video has constant Node-side memory.
 */
export function buildDesktopBackgroundInjection(
  spec: DesktopCdpHostSpec,
  galleryUrl = "",
): string {
  const config = {
    kind: spec.kind,
    build: DESKTOP_BACKGROUND_VERSION,
    anchorSelector: spec.anchorSelector,
    anchorText: spec.anchorText,
    mount: spec.mount,
    popupTopInset: spec.popupTopInset,
    strings: spec.strings,
    contract: spec.contract,
    theme: spec.theme,
    galleryUrl,
    schema: DESKTOP_BACKGROUND_SCHEMA,
  };
  return `(function(){
var CFG=${JSON.stringify(config)};
var BC='beauticode-'+CFG.kind+'-background';
var ENTRY=BC+'-entry', PANEL=BC+'-panel', STYLE=BC+'-style';
var root=document.documentElement;
var existing=document.getElementById(ENTRY);
var existingStyle=document.getElementById(STYLE);
var existingStage=document.getElementById('beauticode-bg-stage');
if(root.getAttribute('data-bc-desktop-build')===CFG.build&&existing&&document.getElementById(PANEL)&&existingStyle&&existingStage)return 'already-installed';
if(window.__bcDesktopAbort){try{window.__bcDesktopAbort.abort()}catch(e){}}
var aborter=new AbortController();window.__bcDesktopAbort=aborter;
document.querySelectorAll('[data-bc-desktop="'+CFG.kind+'"]').forEach(function(n){if(n.id!=='beauticode-bg-stage')n.remove()});

var anchor=document.querySelector(CFG.anchorSelector);
if(!anchor)return 'no-anchor';
var anchorLabel=CFG.mount==='cursor'?anchor.querySelector('.ui-sidebar-menu-button-label'):anchor.querySelector('span.font-medium');
if(!anchorLabel||anchorLabel.textContent.trim()!==CFG.anchorText)return 'anchor-text-mismatch';

function node(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}
function icon(){var ns='http://www.w3.org/2000/svg',s=document.createElementNS(ns,'svg');[['viewBox','0 0 24 24'],['width','20'],['height','20'],['fill','none'],['stroke','currentColor'],['stroke-width','1.8'],['stroke-linecap','round'],['stroke-linejoin','round'],['aria-hidden','true']].forEach(function(a){s.setAttribute(a[0],a[1])});var r=document.createElementNS(ns,'rect');[['x','3'],['y','4'],['width','18'],['height','16'],['rx','2']].forEach(function(a){r.setAttribute(a[0],a[1])});var p=document.createElementNS(ns,'path');p.setAttribute('d','m7 15 3-3 2.5 2.5L15 12l3 3');var c=document.createElementNS(ns,'circle');[['cx','8'],['cy','9'],['r','1']].forEach(function(a){c.setAttribute(a[0],a[1])});s.append(r,p,c);return s}
var entry;
if(CFG.mount==='cursor'){
  entry=anchor.cloneNode(true);entry.id=ENTRY;entry.removeAttribute('data-active');entry.setAttribute('data-action-id','beauticode-background');entry.setAttribute('aria-label',CFG.strings.entry);
  var label=entry.querySelector('.ui-sidebar-menu-button-label');label.textContent=CFG.strings.entry;
  var iw=entry.querySelector('.ui-sidebar-menu-button-icon-wrapper');if(iw)iw.replaceChildren(icon());
}else{
  entry=anchor.cloneNode(false);entry.id=ENTRY;entry.removeAttribute('data-expand');entry.setAttribute('data-testid','beauticode-background-entry');
  var navRow=anchor.firstElementChild.cloneNode(false);navRow.setAttribute('role','button');navRow.setAttribute('tabindex','0');var outer=node('div','flex w-full items-center justify-between'),inner=node('div','truncate ml-[8px] flex-1 min-w-0 s-font-small flex items-center'),entryLabel=node('span','font-medium',CFG.strings.entry);inner.appendChild(entryLabel);outer.appendChild(inner);navRow.append(icon(),outer);
  entry.appendChild(navRow);
}
entry.setAttribute('data-bc-desktop',CFG.kind);anchor.insertAdjacentElement('afterend',entry);

function hasToken(tokens){var list=document.body&&document.body.classList;if(!list||!Array.isArray(tokens))return false;for(var i=0;i<tokens.length;i++)if(list.contains(tokens[i]))return true;return false}
function hasRootValue(values){var attr=CFG.theme&&CFG.theme.rootAttribute;if(!attr||!Array.isArray(values))return false;var value=root.getAttribute(attr);for(var i=0;i<values.length;i++)if(value===values[i])return true;return false}
function hostTheme(){
  var theme=CFG.theme||{};
  if(hasToken(theme.highContrastClassTokens)||hasRootValue(theme.highContrastAttributeValues))return 'high-contrast';
  if(hasToken(theme.darkClassTokens)||hasRootValue(theme.darkAttributeValues))return 'dark';
  if(hasToken(theme.lightClassTokens)||hasRootValue(theme.lightAttributeValues))return 'light';
  if(theme.cssThemeVariable){var cssValue=getComputedStyle(root).getPropertyValue(theme.cssThemeVariable).trim();if(cssValue==='dark'||cssValue==='light')return cssValue}
  try{return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){return 'dark'}
}
var lastTheme='';
var themeObserver=null;
var themeMedia=null;
function refreshTheme(){var next=hostTheme();if(next===lastTheme)return false;lastTheme=next;root.setAttribute('data-bc-theme',next);root.setAttribute('data-bc-light',next==='light'?'true':'false');return true}
function observeTheme(){
  if(themeObserver)themeObserver.disconnect();
  themeObserver=new MutationObserver(function(){refreshTheme();if(document.body!==themeObserverBody)attachThemeBody()});
  var attrs=(CFG.theme&&CFG.theme.observeAttributes)||['class','data-theme'];
  themeObserver.observe(root,{attributes:true,attributeFilter:attrs,childList:true,subtree:true});
  var themeObserverBody=null;
  function attachThemeBody(){if(!document.body||document.body===themeObserverBody)return;themeObserverBody=document.body;themeObserver.observe(themeObserverBody,{attributes:true,attributeFilter:attrs});}
  attachThemeBody();
  refreshTheme();
  themeMedia=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null;
  if(themeMedia){if(themeMedia.addEventListener)themeMedia.addEventListener('change',refreshTheme);else if(themeMedia.addListener)themeMedia.addListener(refreshTheme)}
  window.__bcDesktopThemeObserver=themeObserver;window.__bcDesktopThemeMedia=themeMedia;
  aborter.signal.addEventListener('abort',function(){if(themeObserver)themeObserver.disconnect();if(themeMedia){if(themeMedia.removeEventListener)themeMedia.removeEventListener('change',refreshTheme);else if(themeMedia.removeListener)themeMedia.removeListener(refreshTheme)}}, {once:true});
}
observeTheme();
var style=document.createElement('style');style.id=STYLE;style.setAttribute('data-bc-desktop',CFG.kind);
function scope(selectors){return selectors.map(function(selector){return 'html[data-bc-active="true"] '+selector}).join(',')}
var backdrop=scope(CFG.contract.backdropSelectors);
var surfaces=scope(CFG.contract.surfaceSelectors);
var flatten=scope(CFG.contract.flattenSelectors);
style.textContent='html{--bc-surface-base:#1f1f1f;--bc-surface-alpha-pct:82%;--bc-scrim-val:.28;--bc-bg-blur:0px;--bc-stage-fallback:#101114;--bc-scrim-rgb:0,0,0;--bc-panel-bg:rgba(31,31,31,.97);--bc-panel-text:#eee;--bc-panel-border:rgba(255,255,255,.18);--bc-control-bg:rgba(255,255,255,.08);--bc-control-border:rgba(255,255,255,.17);--bc-overlay-rgb:0,0,0}' +
  'html[data-bc-theme="light"]{--bc-surface-base:#fff;--bc-scrim-val:.12;--bc-stage-fallback:#f7f8fa;--bc-scrim-rgb:255,255,255;--bc-panel-bg:rgba(255,255,255,.97);--bc-panel-text:#202124;--bc-panel-border:rgba(0,0,0,.16);--bc-control-bg:rgba(0,0,0,.05);--bc-control-border:rgba(0,0,0,.16);--bc-overlay-rgb:255,255,255}' +
  'html[data-bc-theme="high-contrast"]{--bc-surface-base:#000;--bc-surface-alpha-pct:90%;--bc-scrim-val:.18;--bc-stage-fallback:#000;--bc-scrim-rgb:0,0,0;--bc-panel-bg:#000;--bc-panel-text:#fff;--bc-panel-border:#fff;--bc-control-bg:#000;--bc-control-border:#fff;--bc-overlay-rgb:0,0,0}' +
  'html[data-bc-active="true"],html[data-bc-active="true"] body{background:transparent!important}body{isolation:isolate}' +
  '#beauticode-bg-stage{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:var(--bc-stage-fallback)}' +
  'html[data-bc-active="true"] #beauticode-bg-stage{background:var(--bc-stage-fallback)}' +
  '#beauticode-bg-stage .bc-media{position:absolute;inset:-12px;width:calc(100% + 24px);height:calc(100% + 24px);object-fit:cover;filter:blur(var(--bc-bg-blur));pointer-events:none}' +
  '#beauticode-bg-stage:after{content:"";position:absolute;inset:0;background:transparent;pointer-events:none}' +
  'html[data-bc-active="true"] #beauticode-bg-stage:after{background:rgba(var(--bc-scrim-rgb),var(--bc-scrim-val))}' +
  (backdrop?backdrop+'{background-color:transparent!important;background-image:none!important}':'') +
  (surfaces?surfaces+'{background-color:color-mix(in srgb,var(--bc-surface-base) var(--bc-surface-alpha-pct),transparent)!important;backdrop-filter:none!important}':'') +
  (flatten?flatten+'{background-color:transparent!important;background-image:none!important}':'') +
  '.bc-desktop-pop,.bc-desktop-dialog *,.bc-desktop-pop *{box-sizing:border-box}' +
  '.bc-desktop-pop{position:fixed;z-index:2147483000;width:340px;max-height:calc(100vh - 24px);overflow:auto;padding:6px;border-radius:16px;background:var(--bc-panel-bg);color:var(--bc-panel-text);border:1px solid var(--bc-panel-border);box-shadow:0 22px 55px rgba(0,0,0,.42);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;display:none}' +
  '.bc-desktop-item{display:flex;align-items:center;gap:10px;min-height:46px;padding:7px 10px;border-radius:10px}.bc-desktop-item:hover{background:var(--bc-control-bg)}' +
  '.bc-desktop-item>svg{width:18px;flex:none}.bc-desktop-title{flex:1}.bc-desktop-ctl{display:flex;align-items:center;gap:6px}.bc-desktop-val{width:36px;text-align:right;font-size:12px;opacity:.65}.bc-desktop-item input[type=range]{width:105px;accent-color:currentColor}' +
  '.bc-desktop-pill{border:1px solid var(--bc-control-border);border-radius:999px;padding:5px 11px;background:var(--bc-control-bg);color:inherit;cursor:pointer;font:inherit;font-size:12px}.bc-desktop-sep{height:1px;background:var(--bc-panel-border);margin:2px 8px}' +
  '.bc-desktop-msg{padding:7px 10px 4px;min-height:22px;font-size:12px;opacity:.68}' +
  '.bc-desktop-dialog{position:fixed;inset:0;z-index:2147483100;display:grid;place-items:center;padding:20px;background:rgba(var(--bc-overlay-rgb),.55)}.bc-desktop-dialog[hidden]{display:none}' +
  '.bc-desktop-card{width:min(430px,calc(100vw - 40px));max-height:min(620px,calc(100vh - 40px));overflow:auto;padding:18px;border-radius:17px;background:var(--bc-panel-bg);color:var(--bc-panel-text);border:1px solid var(--bc-panel-border);box-shadow:0 22px 55px rgba(0,0,0,.42);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}' +
  '.bc-desktop-card h2{margin:0 0 12px;font-size:17px}.bc-desktop-card input[type=text]{width:100%;height:40px;padding:0 11px;border-radius:10px;border:1px solid var(--bc-control-border);background:var(--bc-control-bg);color:inherit;font:inherit}.bc-desktop-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.bc-desktop-error{color:#ff8585;font-size:12px}.bc-desktop-theme{display:flex;align-items:center;width:100%;gap:9px;padding:10px;margin:7px 0;border-radius:11px;border:1px solid var(--bc-control-border);background:var(--bc-control-bg);color:inherit;text-align:left;cursor:pointer}.bc-desktop-theme-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-desktop-kind{font-size:12px;opacity:.6}.bc-desktop-dot{width:8px;height:8px;border-radius:50%;border:1px solid currentColor}.bc-desktop-theme[data-active=true] .bc-desktop-dot{background:#25c995;border-color:#25c995}' +
  'html[data-bc-theme="high-contrast"] .bc-desktop-pop,html[data-bc-theme="high-contrast"] .bc-desktop-card{border-width:2px;box-shadow:0 0 0 1px #fff,0 22px 55px rgba(0,0,0,.7)}';
document.head.appendChild(style);

var stage=document.getElementById('beauticode-bg-stage');
if(!stage){stage=document.createElement('div');stage.id='beauticode-bg-stage';stage.setAttribute('data-bc-desktop',CFG.kind);document.body.insertBefore(stage,document.body.firstChild)}

var PERSIST=window.__bcDesktopPersistStore||{schema:CFG.schema,wallpaper:null,cleared:false,dim:49,blur:0,alpha:100,muted:true,themes:[],activeThemeId:null};
window.__bcDesktopApplyResult=window.__bcDesktopApplyResult||{};
window.__bcDesktopPersistStore=PERSIST;if(!Array.isArray(PERSIST.themes))PERSIST.themes=[];
function persist(){PERSIST.schema=CFG.schema;window.__bcDesktopPersistDirty=(window.__bcDesktopPersistDirty||0)+1}
window.__bcDesktopPersistGet=function(){return JSON.stringify(PERSIST)};
function clearMedia(){stage.querySelectorAll('.bc-media').forEach(function(n){var u=n.dataset.blobUrl;if(u)URL.revokeObjectURL(u);n.remove()});root.removeAttribute('data-bc-active');root.removeAttribute('data-bc-media')}
function setVars(){root.style.setProperty('--bc-scrim-val',String(Math.max(0,Math.min(100,+PERSIST.dim||0))/100));root.style.setProperty('--bc-bg-blur',(Math.max(0,Math.min(100,+PERSIST.blur||0))*.09).toFixed(2)+'px');root.style.setProperty('--bc-surface-alpha-pct',(100-Math.max(0,Math.min(100,+PERSIST.alpha||0)))+'%')}
setVars();

var pop=document.createElement('div');pop.id=PANEL;pop.className='bc-desktop-pop';pop.setAttribute('data-bc-desktop',CFG.kind);document.body.appendChild(pop);
function row(title,control,action){var r=node('div','bc-desktop-item'),t=node('span','bc-desktop-title',title),ctl=node('span','bc-desktop-ctl');ctl.appendChild(control);r.append(icon(),t,ctl);if(action)r.dataset.action=action;return r}
function pill(text,action){var b=document.createElement('button');b.type='button';b.className='bc-desktop-pill';b.textContent=text;if(action)b.dataset.action=action;return b}
function slider(value){var box=document.createElement('span');var input=document.createElement('input');input.type='range';input.min='0';input.max='100';input.value=String(value);var val=document.createElement('span');val.className='bc-desktop-val';val.textContent=value+'%';box.appendChild(input);box.appendChild(val);box.input=input;box.val=val;return box}
var dim=slider(PERSIST.dim),blur=slider(PERSIST.blur),alpha=slider(PERSIST.alpha),sound=pill(PERSIST.muted?CFG.strings.soundOff:CFG.strings.soundOn,'sound'),themes=pill(CFG.strings.choose,'themes');
var items=[row(CFG.strings.dim,dim),row(CFG.strings.blur,blur),row(CFG.strings.transparency,alpha),row(CFG.strings.sound,sound,'sound'),row(CFG.strings.importBackground,pill(CFG.strings.chooseFile,'import'),'import'),row(CFG.strings.savedThemes,themes,'themes'),row(CFG.strings.skinCenter,pill(CFG.strings.open,'skin'),'skin'),row(CFG.strings.clearBackground,pill(CFG.strings.clear,'clear'),'clear')];
items.forEach(function(r,i){pop.appendChild(r);if(i<items.length-1){var s=document.createElement('div');s.className='bc-desktop-sep';pop.appendChild(s)}});
var msg=document.createElement('div');msg.className='bc-desktop-msg';pop.appendChild(msg);function say(t){msg.textContent=String(t||'')};window.__bcDesktopMessage=say;
var input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,video/mp4,video/quicktime,video/webm,video/x-m4v';input.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;opacity:0';input.dataset.id='fileInput';pop.appendChild(input);

var nameDialog=node('div','bc-desktop-dialog');nameDialog.hidden=true;nameDialog.setAttribute('data-bc-desktop',CFG.kind);var nameCard=node('div','bc-desktop-card'),nameTitle=node('h2'),nameFile=node('p'),nameInput=node('input'),nameError=node('p','bc-desktop-error'),nameActions=node('div','bc-desktop-actions'),nameCancel=node('button','bc-desktop-pill'),nameConfirm=node('button','bc-desktop-pill');nameCard.setAttribute('role','dialog');nameCard.setAttribute('aria-modal','true');nameFile.setAttribute('data-file','');nameInput.type='text';nameInput.maxLength=80;nameError.setAttribute('data-error','');nameError.hidden=true;nameCancel.setAttribute('data-cancel','');nameConfirm.setAttribute('data-confirm','');nameActions.append(nameCancel,nameConfirm);nameCard.append(nameTitle,nameFile,nameInput,nameError,nameActions);nameDialog.appendChild(nameCard);document.body.appendChild(nameDialog);
nameTitle.textContent=CFG.strings.saveTheme;nameInput.placeholder=CFG.strings.themeNamePlaceholder;nameCancel.textContent=CFG.strings.cancel;nameConfirm.textContent=CFG.strings.saveAndApply;
var pendingImport=null;
function closeName(){pendingImport=null;nameDialog.hidden=true;nameInput.value=''}
nameDialog.querySelector('[data-cancel]').onclick=closeName;

var savedDialog=node('div','bc-desktop-dialog'),savedCard=node('div','bc-desktop-card'),savedTitle=node('h2',null,CFG.strings.savedThemes),savedList=node('div'),savedEmpty=node('p',null,CFG.strings.noThemes),savedActions=node('div','bc-desktop-actions'),savedClose=node('button','bc-desktop-pill',CFG.strings.close);savedDialog.hidden=true;savedDialog.setAttribute('data-bc-desktop',CFG.kind);savedCard.setAttribute('role','dialog');savedCard.setAttribute('aria-modal','true');savedList.setAttribute('data-list','');savedEmpty.setAttribute('data-empty','');savedClose.setAttribute('data-close','');savedActions.appendChild(savedClose);savedCard.append(savedTitle,savedList,savedEmpty,savedActions);savedDialog.appendChild(savedCard);document.body.appendChild(savedDialog);savedClose.onclick=function(){savedDialog.hidden=true};
function syncThemes(){themes.textContent=PERSIST.themes.length?String(PERSIST.themes.length):CFG.strings.choose}
function renderThemes(){var list=savedDialog.querySelector('[data-list]');list.textContent='';savedDialog.querySelector('[data-empty]').hidden=PERSIST.themes.length>0;PERSIST.themes.forEach(function(t){var b=node('button','bc-desktop-theme'),dot=node('span','bc-desktop-dot'),themeName=node('span','bc-desktop-theme-name',t.name),kindName=node('span','bc-desktop-kind',t.type==='video'?CFG.strings.video:CFG.strings.image);b.type='button';b.dataset.active=String(t.id===PERSIST.activeThemeId);b.append(dot,themeName,kindName);b.onclick=function(){savedDialog.hidden=true;window.__bcDesktopApplyRequest={requestId:Date.now()+'-'+Math.random(),mode:'theme',path:t.path,name:t.name,themeId:t.id,save:false}};list.appendChild(b)})}
syncThemes();

function mediaKind(file){if(/^video\\//.test(file.type)||/\\.(mp4|mov|webm|m4v)$/i.test(file.name))return 'video';if(/^image\\//.test(file.type)||/\\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name))return 'image';return null}
async function applyFile(file,meta){var kind=mediaKind(file);if(!kind){say(CFG.strings.unsupportedFile);throw new Error('unsupported media')}
  var themeName=meta.save?String(meta.name||'').trim().slice(0,80):'';if(meta.save&&!themeName)throw new Error('theme name required');
  var url=URL.createObjectURL(file),el=document.createElement(kind==='video'?'video':'img');el.className='bc-media';el.dataset.blobUrl=url;if(kind==='video'){el.loop=true;el.playsInline=true;el.muted=PERSIST.muted;el.preload='auto'}
  try{await new Promise(function(resolve,reject){var done=false;var timer=setTimeout(function(){if(!done){done=true;reject(new Error('media timeout'))}},30000);var ok=function(){if(done)return;done=true;clearTimeout(timer);resolve()};var bad=function(){if(done)return;done=true;clearTimeout(timer);reject(new Error('media load failed'))};if(kind==='video'){el.addEventListener('loadeddata',ok,{once:true});el.addEventListener('error',bad,{once:true})}else{el.addEventListener('load',ok,{once:true});el.addEventListener('error',bad,{once:true})}el.src=url})}catch(e){URL.revokeObjectURL(url);throw e}
  var old=[].slice.call(stage.querySelectorAll('.bc-media'));stage.appendChild(el);old.forEach(function(n){var u=n.dataset.blobUrl;if(u)URL.revokeObjectURL(u);n.remove()});root.setAttribute('data-bc-active','true');root.setAttribute('data-bc-media',kind);if(kind==='video'){try{await el.play()}catch(e){}}
  PERSIST.wallpaper=meta.path;PERSIST.cleared=false;PERSIST.muted=!!PERSIST.muted;
  if(meta.save){var found=PERSIST.themes.find(function(t){return t.path===meta.path || (meta.provenance&&t.provenance&&t.provenance.source==='hnnulwh'&&t.provenance.sourceSkinId===meta.provenance.sourceSkinId)});if(found){found.name=themeName;found.type=kind;if(meta.provenance)found.provenance=meta.provenance;found.path=meta.path}else{found={id:meta.themeId||('theme-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7)),name:themeName,path:meta.path,type:kind};if(meta.provenance)found.provenance=meta.provenance;PERSIST.themes.push(found)}PERSIST.activeThemeId=found.id}else if(meta.themeId){PERSIST.activeThemeId=meta.themeId}
  persist();syncThemes();say(kind==='video'?CFG.strings.appliedVideo:CFG.strings.appliedImage);return true}
window.__bcDesktopPrepareFile=function(meta){window.__bcDesktopPendingFile=meta||null;return true};
input.addEventListener('change',function(){var file=input.files&&input.files[0],meta=window.__bcDesktopPendingFile;window.__bcDesktopPendingFile=null;input.value='';if(!file||!meta)return;if(meta.mode==='import'){pendingImport={file:file,path:meta.path};nameDialog.querySelector('[data-file]').textContent=file.name;nameDialog.querySelector('.bc-desktop-error').hidden=true;nameInput.value='';nameDialog.hidden=false;setTimeout(function(){nameInput.focus()},0);return}applyFile(file,meta).then(function(){window.__bcDesktopApplyResult[meta.requestId]={status:'ok'}}).catch(function(e){window.__bcDesktopApplyResult[meta.requestId]={status:'error',error:String(e&&e.message||e)};say(CFG.strings.importFailed)})});
nameDialog.querySelector('[data-confirm]').onclick=function(){var n=String(nameInput.value||'').trim(),err=nameDialog.querySelector('.bc-desktop-error');if(!n){err.textContent=CFG.strings.nameRequired;err.hidden=false;nameInput.focus();return}var p=pendingImport;if(!p)return;nameDialog.hidden=true;pendingImport=null;applyFile(p.file,{mode:'import',path:p.path,name:n,save:true}).catch(function(){say(CFG.strings.importFailed)})};
nameInput.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();nameDialog.querySelector('[data-confirm]').click()}else if(e.key==='Escape')closeName()});

dim.input.oninput=function(){PERSIST.dim=+dim.input.value;dim.val.textContent=PERSIST.dim+'%';setVars();persist()};blur.input.oninput=function(){PERSIST.blur=+blur.input.value;blur.val.textContent=PERSIST.blur+'%';setVars();persist()};alpha.input.oninput=function(){PERSIST.alpha=+alpha.input.value;alpha.val.textContent=PERSIST.alpha+'%';setVars();persist()};
function openPop(){pop.style.display='block';var safeTop=Math.max(0,Number(CFG.popupTopInset)||12),safeMin=safeTop+1,bottom=12;pop.style.maxHeight=Math.max(0,innerHeight-safeMin-bottom)+'px';var r=entry.getBoundingClientRect(),w=pop.offsetWidth||340,h=pop.offsetHeight||520,x=Math.max(12,Math.min(r.left,innerWidth-w-12)),y=r.bottom+8;if(y+h>innerHeight-bottom)y=r.top-h-8;y=Math.max(safeMin,Math.min(y,innerHeight-bottom-h));pop.style.left=x+'px';pop.style.top=y+'px'}
function closePop(){pop.style.display='none'}
entry.addEventListener('click',function(e){e.preventDefault();e.stopImmediatePropagation();pop.style.display==='block'?closePop():openPop()},{capture:true,signal:aborter.signal});entry.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();entry.click()}},{capture:true,signal:aborter.signal});
pop.addEventListener('click',function(e){var a=e.target.closest('[data-action]');if(!a)return;var action=a.dataset.action;if(action==='import'){window.__bcDesktopPickRequest=Date.now();say(CFG.strings.chooseFile);closePop()}else if(action==='themes'){renderThemes();savedDialog.hidden=false;closePop()}else if(action==='skin'){window.__bcDesktopSkinCenterRequest=Date.now();closePop()}else if(action==='sound'){PERSIST.muted=!PERSIST.muted;stage.querySelectorAll('video').forEach(function(v){v.muted=PERSIST.muted});sound.textContent=PERSIST.muted?CFG.strings.soundOff:CFG.strings.soundOn;persist()}else if(action==='clear'){clearMedia();PERSIST.wallpaper=null;PERSIST.cleared=true;PERSIST.activeThemeId=null;persist();closePop()}},{signal:aborter.signal});
document.addEventListener('mousedown',function(e){if(pop.style.display==='block'&&!pop.contains(e.target)&&!entry.contains(e.target))closePop()},{signal:aborter.signal});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){if(!nameDialog.hidden)closeName();else if(!savedDialog.hidden)savedDialog.hidden=true;else closePop()}},{signal:aborter.signal});

window.__bcDesktopRestoreState=function(raw){try{var s=typeof raw==='string'?JSON.parse(raw):raw;if(!s||typeof s!=='object')return false;PERSIST.schema=CFG.schema;PERSIST.wallpaper=typeof s.wallpaper==='string'?s.wallpaper:null;PERSIST.cleared=!!s.cleared;PERSIST.dim=Number.isFinite(+s.dim)?+s.dim:49;PERSIST.blur=Number.isFinite(+s.blur)?+s.blur:0;PERSIST.alpha=Number.isFinite(+s.alpha)?+s.alpha:100;PERSIST.muted=s.muted!==false;PERSIST.themes=Array.isArray(s.themes)?s.themes.filter(function(t){return t&&typeof t.id==='string'&&typeof t.name==='string'&&typeof t.path==='string'&&(t.type==='image'||t.type==='video')}).slice(0,200):[];PERSIST.activeThemeId=typeof s.activeThemeId==='string'?s.activeThemeId:null;dim.input.value=String(PERSIST.dim);dim.val.textContent=PERSIST.dim+'%';blur.input.value=String(PERSIST.blur);blur.val.textContent=PERSIST.blur+'%';alpha.input.value=String(PERSIST.alpha);alpha.val.textContent=PERSIST.alpha+'%';sound.textContent=PERSIST.muted?CFG.strings.soundOff:CFG.strings.soundOn;setVars();syncThemes();if(PERSIST.cleared)clearMedia();else if(PERSIST.wallpaper){var t=PERSIST.themes.find(function(x){return x.id===PERSIST.activeThemeId||x.path===PERSIST.wallpaper});window.__bcDesktopApplyRequest={requestId:'restore-'+Date.now(),mode:'restore',path:PERSIST.wallpaper,name:t?t.name:'',themeId:t?t.id:null,save:false}}return true}catch(e){return false}};
window.__bcDesktopApplyGallery=function(path,name,provenance){window.__bcDesktopApplyRequest={requestId:'gallery-'+Date.now(),mode:'gallery',path:String(path),name:String(name||'Skin'),provenance:provenance||null,themeId:null,save:true};return true};
root.setAttribute('data-bc-desktop-host',CFG.kind);root.setAttribute('data-bc-desktop-build',CFG.build);return 'ok';
})()`;
}

export function buildDesktopBackgroundCleanup(kind: "cursor" | "doubao"): string {
  return `(()=>{if(window.__bcDesktopAbort){try{window.__bcDesktopAbort.abort()}catch(e){}}if(window.__bcDesktopThemeObserver){try{window.__bcDesktopThemeObserver.disconnect()}catch(e){}}document.querySelectorAll('[data-bc-desktop="${kind}"]').forEach(n=>n.remove());const r=document.documentElement;r.removeAttribute('data-bc-desktop-host');r.removeAttribute('data-bc-desktop-build');r.removeAttribute('data-bc-active');r.removeAttribute('data-bc-media');r.removeAttribute('data-bc-light');r.removeAttribute('data-bc-theme');r.style.removeProperty('--bc-scrim-val');r.style.removeProperty('--bc-bg-blur');r.style.removeProperty('--bc-surface-alpha-pct');delete window.__bcDesktopAbort;delete window.__bcDesktopThemeObserver;delete window.__bcDesktopThemeMedia;delete window.__bcDesktopPersistStore;delete window.__bcDesktopPersistGet;delete window.__bcDesktopRestoreState;delete window.__bcDesktopPrepareFile;delete window.__bcDesktopApplyGallery;delete window.__bcDesktopApplyRequest;delete window.__bcDesktopPickRequest;delete window.__bcDesktopSkinCenterRequest;return 'cleaned'})()`;
}

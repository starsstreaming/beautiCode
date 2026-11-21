import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "@beauticode/core";
import type { DesktopCdpHostKind, DesktopCdpHostSpec } from "./types.js";

export const DESKTOP_BACKGROUND_SCHEMA = "beauticode.desktop-background.v1";
export const DESKTOP_BACKGROUND_VERSION = "v1.21";

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
    anchorTexts: spec.anchorTexts || [spec.anchorText],
    imageExtensions: IMAGE_EXTENSIONS,
    videoExtensions: VIDEO_EXTENSIONS,
    mount: spec.mount,
    popupTopInset: spec.popupTopInset,
    strings: spec.strings,
    contract: spec.contract,
    theme: spec.theme,
    galleryUrl,
    schema: DESKTOP_BACKGROUND_SCHEMA,
    settings: spec.settings,
    surfaceBaseVariable: spec.surfaceBaseVariable,
    videoFrame: spec.videoFrame === true,
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
if(window.__bcDesktopDispose){try{window.__bcDesktopDispose()}catch(e){}}
if(window.__bcDesktopAbort){try{window.__bcDesktopAbort.abort()}catch(e){}}
var aborter=new AbortController();window.__bcDesktopAbort=aborter;
document.querySelectorAll('[data-bc-desktop="'+CFG.kind+'"]').forEach(function(n){if(n.id!=='beauticode-bg-stage')n.remove()});

var settingsMode=!!CFG.settings;
var anchor=document.querySelector(CFG.anchorSelector);
if(!anchor)return 'no-anchor';
if(!settingsMode){
  var anchorLabel=CFG.mount==='cursor'?(anchor.querySelector('.ui-sidebar-menu-button-label')||anchor.querySelector('.agent-sidebar-cell-text')):anchor.querySelector('span.font-medium');
  if(!anchorLabel||CFG.anchorTexts.indexOf(anchorLabel.textContent.trim())===-1)return 'anchor-text-mismatch';
}

function node(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}
function icon(){var ns='http://www.w3.org/2000/svg',s=document.createElementNS(ns,'svg');[['viewBox','0 0 24 24'],['width','20'],['height','20'],['fill','none'],['stroke','currentColor'],['stroke-width','1.8'],['stroke-linecap','round'],['stroke-linejoin','round'],['aria-hidden','true']].forEach(function(a){s.setAttribute(a[0],a[1])});var r=document.createElementNS(ns,'rect');[['x','3'],['y','4'],['width','18'],['height','16'],['rx','2']].forEach(function(a){r.setAttribute(a[0],a[1])});var p=document.createElementNS(ns,'path');p.setAttribute('d','m7 15 3-3 2.5 2.5L15 12l3 3');var c=document.createElementNS(ns,'circle');[['cx','8'],['cy','9'],['r','1']].forEach(function(a){c.setAttribute(a[0],a[1])});s.append(r,p,c);return s}
function glyph(kind){var ns='http://www.w3.org/2000/svg',s=document.createElementNS(ns,'svg');[['viewBox','0 0 24 24'],['width','16'],['height','16'],['fill','none'],['stroke','currentColor'],['stroke-width','1.8'],['stroke-linecap','round'],['stroke-linejoin','round'],['aria-hidden','true']].forEach(function(a){s.setAttribute(a[0],a[1])});var d={readability:'M12 3 3 7l9 4 9-4-9-4ZM3 12l9 4 9-4M3 17l9 4 9-4',dim:'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',alpha:'M12 3c3 4 6 7 6 10a6 6 0 0 1-12 0c0-3 3-6 6-10Z',blur:'M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',sound:'M4 9v6h4l5 4V5L8 9H4ZM16 9a4 4 0 0 1 0 6',import:'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M9 9h.01',skin:'M4 9h16l-1 10H5L4 9ZM8 9a4 4 0 0 1 8 0',library:'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',clear:'M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5'}[kind];if(!d)return null;var p=document.createElementNS(ns,'path');p.setAttribute('d',d);s.appendChild(p);var box=document.createElement('span');box.className='bc-desktop-glyph';box.dataset.kind=kind;box.appendChild(s);return box}
var entry;
if(settingsMode){
  entry=document.createElement('span');entry.id=ENTRY;entry.hidden=true;entry.setAttribute('aria-hidden','true');
}else if(CFG.mount==='cursor'){
  entry=anchor.cloneNode(true);entry.id=ENTRY;entry.setAttribute('role','button');entry.setAttribute('tabindex','0');entry.setAttribute('aria-label',CFG.strings.entry);entry.setAttribute('data-selected','false');entry.setAttribute('data-action-id','beauticode-background');
  var label=entry.querySelector('.ui-sidebar-menu-button-label')||entry.querySelector('.agent-sidebar-cell-text');if(label)label.textContent=CFG.strings.entry;
  var iw=entry.querySelector('.ui-sidebar-menu-button-icon-wrapper')||entry.querySelector('.agent-sidebar-cell-icon');if(iw)iw.replaceChildren(icon());
}else{
  entry=anchor.cloneNode(false);entry.id=ENTRY;entry.removeAttribute('data-expand');entry.setAttribute('data-testid','beauticode-background-entry');
  var navRow=anchor.firstElementChild.cloneNode(false);navRow.setAttribute('role','button');navRow.setAttribute('tabindex','0');var outer=node('div','flex w-full items-center justify-between'),inner=node('div','truncate ml-[8px] flex-1 min-w-0 s-font-small flex items-center'),entryLabel=node('span','font-medium',CFG.strings.entry);inner.appendChild(entryLabel);outer.appendChild(inner);navRow.append(icon(),outer);
  entry.appendChild(navRow);
}
entry.setAttribute('data-bc-desktop',CFG.kind);
if(settingsMode)document.documentElement.appendChild(entry);else anchor.insertAdjacentElement('afterend',entry);

function themeNodes(){return [CFG.theme&&CFG.theme.classElementSelector?document.querySelector(CFG.theme.classElementSelector):null,root,document.body].filter(Boolean)}
function hasToken(tokens,n){return Array.isArray(tokens)&&tokens.some(function(t){return n.classList.contains(t)})}
function hasRootValue(values,n){var attr=CFG.theme&&CFG.theme.rootAttribute;return !!attr&&Array.isArray(values)&&values.indexOf(n.getAttribute(attr))!==-1}
function hostTheme(){
  var theme=CFG.theme||{};
  var nodes=themeNodes();for(var i=0;i<nodes.length;i++){var n=nodes[i];
    if(hasToken(theme.highContrastLightClassTokens,n))return 'high-contrast-light';
    if(hasToken(theme.highContrastClassTokens,n)||hasRootValue(theme.highContrastAttributeValues,n))return 'high-contrast';
    if(hasToken(theme.darkClassTokens,n)||hasRootValue(theme.darkAttributeValues,n))return 'dark';
    if(hasToken(theme.lightClassTokens,n)||hasRootValue(theme.lightAttributeValues,n))return 'light';
  }
  if(theme.cssThemeVariable){var cssValue=getComputedStyle(root).getPropertyValue(theme.cssThemeVariable).trim();if(cssValue==='dark'||cssValue==='light')return cssValue}
  try{return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){return 'dark'}
}
var lastTheme='';
var themeObserver=null;
var themeMedia=null;
function refreshTheme(){var next=hostTheme();if(next===lastTheme)return false;lastTheme=next;root.setAttribute('data-bc-theme',next);root.setAttribute('data-bc-light',next==='light'||next==='high-contrast-light'?'true':'false');return true}
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
var reading=(CFG.contract.readingSelectors||[]).map(function(s){return 'html[data-bc-active="true"]:is([data-bc-light="true"],[data-bc-theme="high-contrast"]) '+s}).join(',');
var opaque=scope(['[role="dialog"]','[role="alertdialog"]','[role="menu"]','[role="listbox"]','[role="tooltip"]'].concat(CFG.contract.opaqueSelectors||[]));
function scopeFlag(flag,selectors){return (selectors||[]).map(function(selector){return 'html[data-bc-active="true"]['+flag+'] '+selector}).join(',')}
var readableCss=scopeFlag('data-bc-readable-surfaces="false"',CFG.contract.readabilitySelectors);
var readableFlattenCss=scopeFlag('data-bc-readable-surfaces="false"',CFG.contract.readabilityFlattenSelectors);
var hostPlate=CFG.surfaceBaseVariable?'html{--bc-surface-base:var('+CFG.surfaceBaseVariable+',#1f1f1f)}html[data-bc-theme="light"],html[data-bc-theme="high-contrast-light"]{--bc-surface-base:var('+CFG.surfaceBaseVariable+',#fff)}':'';
var readableRule=readableCss?readableCss+'{background-color:color-mix(in srgb,var(--bc-surface-base) var(--bc-surface-alpha-pct),transparent)!important;background-image:none!important;backdrop-filter:none!important}':'';
var readableFlattenRule=readableFlattenCss?readableFlattenCss+'{background-color:transparent!important;background-image:none!important}':'';
style.textContent='html{--bc-surface-base:#1f1f1f;--bc-surface-alpha-pct:82%;--bc-scrim-val:.28;--bc-bg-blur:0px;--bc-stage-fallback:#101114;--bc-scrim-rgb:0,0,0;--bc-panel-bg:rgba(31,31,31,.97);--bc-panel-text:#eee;--bc-panel-border:rgba(255,255,255,.18);--bc-control-bg:rgba(255,255,255,.08);--bc-control-border:rgba(255,255,255,.17);--bc-overlay-rgb:0,0,0}' +
  // A light host reads its text off the white veil, not off panel plates (same
  // call as the Codex adapter): reading surfaces get no floor and the veil takes
  // the contrast, so the wallpaper stays visible. High contrast still floors at
  // 100% below.
  'html[data-bc-theme="light"]{--bc-surface-base:#fff;--bc-scrim-val:.48;--bc-reading-min:0%;--bc-stage-fallback:#f7f8fa;--bc-scrim-rgb:255,255,255;--bc-panel-bg:rgba(255,255,255,.97);--bc-panel-text:#202124;--bc-panel-border:rgba(0,0,0,.16);--bc-control-bg:rgba(0,0,0,.05);--bc-control-border:rgba(0,0,0,.16);--bc-overlay-rgb:255,255,255}' +
  'html[data-bc-theme="high-contrast"]{--bc-surface-base:#000;--bc-surface-alpha-pct:90%;--bc-scrim-val:.18;--bc-stage-fallback:#000;--bc-scrim-rgb:0,0,0;--bc-panel-bg:#000;--bc-panel-text:#fff;--bc-panel-border:#fff;--bc-control-bg:#000;--bc-control-border:#fff;--bc-overlay-rgb:0,0,0}' +
  'html[data-bc-theme="high-contrast-light"]{--bc-surface-base:#fff;--bc-stage-fallback:#fff;--bc-scrim-rgb:255,255,255;--bc-panel-bg:#fff;--bc-panel-text:#000;--bc-panel-border:#000;--bc-control-bg:#fff;--bc-control-border:#000;--bc-overlay-rgb:255,255,255}' +
  'html[data-bc-active="true"],html[data-bc-active="true"] body{background:transparent!important}body{isolation:isolate}' +
  '#beauticode-bg-stage{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:var(--bc-stage-fallback)}' +
  'html[data-bc-active="true"] #beauticode-bg-stage{background:var(--bc-stage-fallback)}' +
  // The media keeps its exact box: growing it shifted the picture and, when the
  // width could not follow the offset, left a bare strip that showed the page
  // behind. Blur is opt-in as well — a per-frame convolution must not sit on the
  // default path.
  '#beauticode-bg-stage .bc-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none}' +
  '#beauticode-bg-stage iframe.bc-media{border:0;background:transparent}' +
  'html[data-bc-blur-user] #beauticode-bg-stage .bc-media{filter:blur(var(--bc-bg-blur))}' +
  '#beauticode-bg-stage:after{content:"";position:absolute;inset:0;background:transparent;pointer-events:none}' +
  'html[data-bc-active="true"] #beauticode-bg-stage:after{background:rgba(var(--bc-scrim-rgb),var(--bc-scrim-val))}' +
  (backdrop?backdrop+'{background-color:transparent!important;background-image:none!important}':'') +
  (surfaces?surfaces+'{background-color:color-mix(in srgb,var(--bc-surface-base) var(--bc-surface-alpha-pct),transparent)!important;backdrop-filter:none!important}':'') +
  (flatten?flatten+'{background-color:transparent!important;background-image:none!important}':'') +
  'html[data-bc-theme^="high-contrast"]{--bc-reading-min:100%}' +
  (reading?reading+'{background-color:color-mix(in srgb,var(--bc-surface-base) max(var(--bc-reading-min,0%),var(--bc-surface-alpha-pct)),transparent)!important}':'') +
  opaque+'{background-color:var(--bc-surface-base)!important}' +
  hostPlate+readableRule+readableFlattenRule +
  '.bc-desktop-settings{position:static;width:100%;margin:24px 0 0;padding:0;background:transparent!important;color:inherit;border:0;box-shadow:none;font:inherit}' +
  '.bc-desktop-settings[hidden]{display:none!important}' +
  '.bc-desktop-pop,.bc-desktop-dialog *,.bc-desktop-pop *{box-sizing:border-box}' +
  '.bc-desktop-pop{position:fixed;z-index:2147483000;width:340px;max-height:calc(100vh - 24px);overflow:auto;padding:6px;border-radius:16px;background:var(--bc-panel-bg);color:var(--bc-panel-text);border:1px solid var(--bc-panel-border);box-shadow:0 22px 55px rgba(0,0,0,.42);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;display:none}' +
  '.bc-desktop-item{display:flex;align-items:center;gap:10px;min-height:46px;padding:7px 10px;border-radius:10px}.bc-desktop-item:hover{background:var(--bc-control-bg)}' +
  '.bc-desktop-item>svg{width:18px;flex:none}.bc-desktop-title{flex:1}.bc-desktop-ctl{display:flex;align-items:center;gap:6px}.bc-desktop-val{width:36px;text-align:right;font-size:12px;opacity:.65}.bc-desktop-item input[type=range]{width:105px;accent-color:currentColor}' +
  '.bc-desktop-pill{border:1px solid var(--bc-control-border);border-radius:999px;padding:5px 11px;background:var(--bc-control-bg);color:inherit;cursor:pointer;font:inherit;font-size:12px}.bc-desktop-sep{height:1px;background:var(--bc-panel-border);margin:2px 8px}' +
  '.bc-desktop-settings h2{margin:0 4px 8px;font:inherit;font-size:12px;font-weight:500;line-height:16px;color:color-mix(in srgb,currentColor 50%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-intro{margin:0 4px 10px;font-size:12px;line-height:1.5;color:color-mix(in srgb,currentColor 45%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-group{border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 0 0 1px color-mix(in srgb,currentColor 6%,transparent)}' +
  'html[data-bc-theme="dark"] .bc-desktop-settings .bc-desktop-group,html[data-bc-theme="high-contrast"] .bc-desktop-settings .bc-desktop-group{background:#1f1f1f;box-shadow:0 0 0 1px rgba(255,255,255,.08)}' +
  '.bc-desktop-settings .bc-desktop-item{min-height:52px;padding:0 12px 0 16px;border-radius:0;gap:12px;background:transparent}' +
  '.bc-desktop-settings .bc-desktop-item:hover{background:transparent}' +
  '.bc-desktop-settings .bc-desktop-item+.bc-desktop-item{box-shadow:inset 0 1px 0 color-mix(in srgb,currentColor 7%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-title{font-size:14px;font-weight:500;line-height:22px}' +
  '.bc-desktop-glyph{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9px;flex:none;background:var(--bc-glyph-bg,#f2f3f5);color:var(--bc-glyph-fg,#4e5969)}' +
  '.bc-desktop-glyph svg{width:16px;height:16px}' +
  '.bc-desktop-glyph[data-kind="readability"]{--bc-glyph-bg:#e8f1ff;--bc-glyph-fg:#0066ff}' +
  '.bc-desktop-glyph[data-kind="dim"]{--bc-glyph-bg:#f2f3f5;--bc-glyph-fg:#4e5969}' +
  '.bc-desktop-glyph[data-kind="alpha"]{--bc-glyph-bg:#e6f7ff;--bc-glyph-fg:#0ea5e9}' +
  '.bc-desktop-glyph[data-kind="blur"]{--bc-glyph-bg:#f3eeff;--bc-glyph-fg:#8b5cf6}' +
  '.bc-desktop-glyph[data-kind="sound"]{--bc-glyph-bg:#e8fff4;--bc-glyph-fg:#10b981}' +
  '.bc-desktop-glyph[data-kind="import"]{--bc-glyph-bg:#fff4e5;--bc-glyph-fg:#f59e0b}' +
  '.bc-desktop-glyph[data-kind="skin"]{--bc-glyph-bg:#fff0f6;--bc-glyph-fg:#ec4899}' +
  '.bc-desktop-glyph[data-kind="library"]{--bc-glyph-bg:#eef2ff;--bc-glyph-fg:#6366f1}' +
  '.bc-desktop-glyph[data-kind="clear"]{--bc-glyph-bg:#fff1f0;--bc-glyph-fg:#ef4444}' +
  'html[data-bc-theme="dark"] .bc-desktop-glyph,html[data-bc-theme="high-contrast"] .bc-desktop-glyph{background:color-mix(in srgb,var(--bc-glyph-fg) 22%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px;padding:8px 0}' +
  '.bc-desktop-settings .bc-desktop-desc{font-size:12px;font-weight:400;line-height:1.4;color:color-mix(in srgb,currentColor 50%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-reset{width:18px;height:18px;margin-left:2px;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px;line-height:1;opacity:.45;transition:background .15s,opacity .15s}' +
  '.bc-desktop-settings .bc-desktop-reset:hover{background:color-mix(in srgb,currentColor 8%,transparent);opacity:.8}' +
  '.bc-desktop-themes{padding:12px 16px 14px;box-shadow:inset 0 1px 0 color-mix(in srgb,currentColor 7%,transparent)}' +
  '.bc-desktop-theme-head{font-size:14px;font-weight:500;line-height:22px;margin:2px 0 8px}' +
  '.bc-desktop-tabs{display:inline-flex;gap:2px;padding:2px;margin-bottom:10px;border-radius:9px;background:color-mix(in srgb,currentColor 6%,transparent)}' +
  '.bc-desktop-tab{border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;line-height:20px;padding:2px 10px;opacity:.6;transition:background .15s,opacity .15s}' +
  '.bc-desktop-tab[data-active="true"]{background:#fff;opacity:1;font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
  'html[data-bc-theme="dark"] .bc-desktop-tab[data-active="true"]{background:rgba(255,255,255,.14);box-shadow:none}' +
  '.bc-desktop-settings .bc-desktop-theme{width:100%;padding:10px 12px;margin:6px 0;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 9%,transparent);background:transparent;transition:background .15s,border-color .15s}' +
  '.bc-desktop-settings .bc-desktop-theme:hover{background:color-mix(in srgb,currentColor 4%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-theme[data-active="true"]{border-color:#0066ff;background:color-mix(in srgb,#0066ff 6%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-ctl{margin-left:auto}' +
  '.bc-desktop-settings .bc-desktop-val{width:38px;font-size:13px;font-weight:400;opacity:1;color:color-mix(in srgb,currentColor 50%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-item input[type=range]{-webkit-appearance:none;appearance:none;width:104px;height:20px;margin:0;background:transparent;cursor:pointer}' +
  '.bc-desktop-settings .bc-desktop-item input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:999px;background:linear-gradient(to right,currentColor 0 var(--bc-range-pct,0%),color-mix(in srgb,currentColor 14%,transparent) var(--bc-range-pct,0%) 100%)}' +
  '.bc-desktop-settings .bc-desktop-item input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:-5.5px;border-radius:50%;background:currentColor;box-shadow:0 1px 3px rgba(0,0,0,.28)}' +
  '.bc-desktop-settings .bc-desktop-item input[type=range]::-moz-range-track{height:3px;border-radius:999px;background:color-mix(in srgb,currentColor 14%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-item input[type=range]::-moz-range-progress{height:3px;border-radius:999px;background:currentColor}' +
  '.bc-desktop-settings .bc-desktop-item input[type=range]::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:currentColor;box-shadow:0 1px 3px rgba(0,0,0,.28)}' +
  '.bc-desktop-settings .bc-desktop-link{width:100%;border:0;font:inherit;text-align:left;cursor:pointer;color:inherit}' +
  '.bc-desktop-settings .bc-desktop-link:hover{background:color-mix(in srgb,currentColor 4%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-hint{margin-left:auto;font-size:14px;font-weight:400;color:color-mix(in srgb,currentColor 50%,transparent)}' +
  '.bc-desktop-settings .bc-desktop-chevron{width:14px;height:14px;flex:none;opacity:.4}' +
  '.bc-desktop-settings .bc-switch{width:38px;height:22px;margin-left:auto;padding:2px;border:0;border-radius:999px;background:color-mix(in srgb,currentColor 16%,transparent);cursor:pointer;transition:background .15s}' +
  '.bc-desktop-settings .bc-switch span{display:block;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .16s ease}' +
  '.bc-desktop-settings .bc-switch[aria-pressed="true"]{background:#0066ff}' +
  '.bc-desktop-settings .bc-switch[aria-checked="true"] span{transform:translateX(16px);background:#fff}' +
  '.bc-desktop-settings .bc-desktop-item[data-disabled="true"]{opacity:.38;pointer-events:none}' +
  '.bc-desktop-settings .bc-desktop-msg{min-height:0;padding:8px 2px 0;font-size:12px;opacity:1;color:color-mix(in srgb,currentColor 55%,transparent)}' +
  '.bc-desktop-msg{padding:7px 10px 4px;min-height:22px;font-size:12px;opacity:.68}' +
  // The host sets pointer-events:none on body while its own modal is open.
  // The name and theme dialogs are mounted on body, so that value reaches
  // them and their buttons paint without ever receiving a click.
  '.bc-desktop-dialog{position:fixed;inset:0;z-index:2147483100;display:grid;place-items:center;padding:20px;background:rgba(var(--bc-overlay-rgb),.55);pointer-events:auto}.bc-desktop-dialog[hidden]{display:none}.bc-desktop-dialog *{pointer-events:auto}' +
  '.bc-desktop-card{width:min(430px,calc(100vw - 40px));max-height:min(620px,calc(100vh - 40px));overflow:auto;padding:18px;border-radius:17px;background:var(--bc-panel-bg);color:var(--bc-panel-text);border:1px solid var(--bc-panel-border);box-shadow:0 22px 55px rgba(0,0,0,.42);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}' +
  '.bc-desktop-card h2{margin:0 0 12px;font-size:17px}.bc-desktop-card input[type=text]{width:100%;height:40px;padding:0 11px;border-radius:10px;border:1px solid var(--bc-control-border);background:var(--bc-control-bg);color:inherit;font:inherit}.bc-desktop-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.bc-desktop-error{color:#ff8585;font-size:12px}.bc-desktop-theme{display:flex;align-items:center;width:100%;gap:9px;padding:10px;margin:7px 0;border-radius:11px;border:1px solid var(--bc-control-border);background:var(--bc-control-bg);color:inherit;text-align:left;cursor:pointer}.bc-desktop-theme-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-desktop-kind{font-size:12px;opacity:.6}.bc-desktop-dot{width:8px;height:8px;border-radius:50%;border:1px solid currentColor}.bc-desktop-theme[data-active=true] .bc-desktop-dot{background:#25c995;border-color:#25c995}' +
  'html[data-bc-theme="high-contrast"] .bc-desktop-pop,html[data-bc-theme="high-contrast"] .bc-desktop-card{border-width:2px;box-shadow:0 0 0 1px #fff,0 22px 55px rgba(0,0,0,.7)}';
document.head.appendChild(style);

var stage=document.getElementById('beauticode-bg-stage');
if(!stage){stage=document.createElement('div');stage.id='beauticode-bg-stage';stage.setAttribute('data-bc-desktop',CFG.kind);document.body.insertBefore(stage,document.body.firstChild)}

var PERSIST=window.__bcDesktopPersistStore||{schema:CFG.schema,wallpaper:null,cleared:false,dim:49,blur:0,alpha:100,muted:true,readable:true,themes:[],activeThemeId:null};
window.__bcDesktopApplyResult=window.__bcDesktopApplyResult||{};
window.__bcDesktopPersistStore=PERSIST;if(!Array.isArray(PERSIST.themes))PERSIST.themes=[];if(PERSIST.readable!==false)PERSIST.readable=true;
function persist(){PERSIST.schema=CFG.schema;window.__bcDesktopPersistDirty=(window.__bcDesktopPersistDirty||0)+1}
window.__bcDesktopPersistGet=function(){return JSON.stringify(PERSIST)};
var mediaGeneration=0, pendingMedia=new Set(), disposed=false;
function mediaVideo(el){
  if(el.tagName==='VIDEO')return el;
  try{return el.tagName==='IFRAME'&&el.contentDocument?el.contentDocument.querySelector('video'):null}catch(e){return null}
}
function releaseMedia(el){
  var video=mediaVideo(el);
  if(video){video.pause();video.removeAttribute('src');video.load()}
  var url=el.dataset.blobUrl;
  if(url){
    try{var urls=el.tagName==='IFRAME'?el.contentWindow&&el.contentWindow.URL:URL;if(urls)urls.revokeObjectURL(url)}catch(e){}
    delete el.dataset.blobUrl;
  }
  el.remove();
}
function invalidateMedia(){
  mediaGeneration++;pendingMedia.forEach(function(cancel){cancel()});pendingMedia.clear();
  var pending=window.__bcDesktopPendingFile;
  if(pending&&pending.requestId)receipt(pending.requestId,{status:'error',error:'stale media selection'});
  window.__bcDesktopPendingFile=null;
}
function clearMedia(){invalidateMedia();stage.querySelectorAll('.bc-media').forEach(releaseMedia);root.removeAttribute('data-bc-active');root.removeAttribute('data-bc-media')}
window.__bcDesktopDispose=function(){disposed=true;clearMedia();aborter.abort();window.__bcDesktopApplyResult={};delete window.__bcDesktopPendingFile};
function receipt(id,result){if(disposed)return;var results=window.__bcDesktopApplyResult;results[id]=result;var keys=Object.keys(results);while(keys.length>64)delete results[keys.shift()]}
function setVars(){root.style.setProperty('--bc-scrim-val',String(Math.max(0,Math.min(100,+PERSIST.dim||0))/100));root.style.setProperty('--bc-bg-blur',(Math.max(0,Math.min(100,+PERSIST.blur||0))*.09).toFixed(2)+'px');root.style.setProperty('--bc-surface-alpha-pct',(100-Math.max(0,Math.min(100,+PERSIST.alpha||0)))+'%');var b=Math.max(0,Math.min(100,+PERSIST.blur||0));if(b>0)root.setAttribute('data-bc-blur-user','');else root.removeAttribute('data-bc-blur-user')}
// Repainting the whole scrim/surface layer on every pointer sample makes a drag
// stutter and then jump. Coalesce visual updates to one per frame; the slider
// value itself still updates synchronously.
var varsFrame=null;
function queueVars(){
  if(varsFrame!==null)return;
  varsFrame=requestAnimationFrame(function(){varsFrame=null;if(!disposed)setVars()});
}
setVars();

var pop=document.createElement('div');pop.id=PANEL;pop.className=settingsMode?'bc-desktop-settings':'bc-desktop-pop';pop.setAttribute('data-bc-desktop',CFG.kind);if(!settingsMode)document.body.appendChild(pop);
function row(title,control,action,glyphKind){var r=node('div','bc-desktop-item'),t=node('span','bc-desktop-title',title),ctl=node('span','bc-desktop-ctl');var g=glyphKind?glyph(glyphKind):null;if(g)r.appendChild(g);else if(!settingsMode)r.appendChild(icon());ctl.appendChild(control);r.append(t,ctl);if(action)r.dataset.action=action;return r}
function pill(text,action){var b=document.createElement('button');b.type='button';b.className='bc-desktop-pill';b.textContent=text;if(action)b.dataset.action=action;return b}
function slider(value,label){
  var box=node('span'),input=node('input','bc-desktop-range'),val=node('span','bc-desktop-val');
  input.type='range';input.min='0';input.max='100';input.setAttribute('aria-label',label);
  function paint(){
    var text=input.value+'%';
    val.textContent=text;input.style.setProperty('--bc-range-pct',text);input.setAttribute('aria-valuetext',text);
  }
  box.setValue=function(next){input.value=String(next);paint();return Number(input.value)};
  box.setValue(value);input.addEventListener('input',paint);box.append(input,val);box.input=input;
  return box;
}
function switchBtn(action,pressed,label){var b=document.createElement('button');b.type='button';b.className='bc-switch';b.dataset.action=action;b.setAttribute('role','switch');b.setAttribute('aria-label',label);b.setAttribute('aria-checked',String(pressed));b.appendChild(document.createElement('span'));return b}
function chevron(){var ns='http://www.w3.org/2000/svg',s=document.createElementNS(ns,'svg');s.setAttribute('viewBox','0 0 16 16');s.setAttribute('class','bc-desktop-chevron');s.setAttribute('aria-hidden','true');var p=document.createElementNS(ns,'path');p.setAttribute('d','M6 3.5 10.5 8 6 12.5');p.setAttribute('fill','none');p.setAttribute('stroke','currentColor');p.setAttribute('stroke-width','1.6');p.setAttribute('stroke-linecap','round');p.setAttribute('stroke-linejoin','round');s.appendChild(p);return s}
function linkRow(title,hint,action,desc,glyphKind){var b=document.createElement('button');b.type='button';b.className='bc-desktop-item bc-desktop-link';b.dataset.action=action;var hintNode=node('span','bc-desktop-hint',hint);var titleNode=node('span','bc-desktop-title',title);var g=glyphKind?glyph(glyphKind):null;if(g)b.appendChild(g);if(desc){var copy=node('div','bc-desktop-copy');copy.append(titleNode,node('span','bc-desktop-desc',desc));b.append(copy,hintNode,chevron())}else b.append(titleNode,hintNode,chevron());b.hintNode=hintNode;return b}
function resetBtn(action){var b=document.createElement('button');b.type='button';b.className='bc-desktop-reset';b.dataset.action=action;b.setAttribute('aria-label','恢复默认');b.textContent='↺';return b}
var dim=slider(PERSIST.dim,CFG.strings.dim),blur=slider(PERSIST.blur,CFG.strings.blur),alpha=slider(PERSIST.alpha,CFG.strings.transparency),sound,themes,readability=null,alphaRow;
var themeCategory='image',inlineList=null,themePanel=null;
if(settingsMode){
  readability=switchBtn('readability',PERSIST.readable!==false,CFG.settings.readability);
  sound=switchBtn('sound',!PERSIST.muted,CFG.strings.sound);
  alphaRow=row(CFG.strings.transparency,alpha,null,'alpha');alphaRow.dataset.alphaRow='true';
  dim.appendChild(resetBtn('dim-reset'));blur.appendChild(resetBtn('blur-reset'));
  themePanel=node('div','bc-desktop-themes');
  var themeTabs=node('div','bc-desktop-tabs');
  ['image','video','scene'].forEach(function(kind){var tab=document.createElement('button');tab.type='button';tab.className='bc-desktop-tab';tab.dataset.themeTab=kind;tab.textContent=kind==='video'?CFG.strings.video:kind==='scene'?(CFG.strings.scene||'场景'):CFG.strings.image;if(kind==='image')tab.dataset.active='true';themeTabs.appendChild(tab)});
  inlineList=node('div','bc-desktop-theme-list');
  themePanel.append(node('div','bc-desktop-theme-head',CFG.strings.savedThemes),themeTabs,inlineList);
  var group=node('div','bc-desktop-group');
  pop.appendChild(node('h2',null,CFG.settings.title||CFG.strings.title));
  if(CFG.settings.intro)pop.appendChild(node('p','bc-desktop-intro',CFG.settings.intro));
  [row(CFG.settings.readability,readability,null,'readability'),row(CFG.strings.dim,dim,null,'dim'),alphaRow,row(CFG.strings.blur,blur,null,'blur'),row(CFG.strings.sound,sound,null,'sound'),linkRow(CFG.strings.importBackground,CFG.strings.chooseFile,'import','图片、MP4 / MOV 视频、场景预览','import'),themePanel,linkRow(CFG.strings.skinCenter,CFG.strings.open,'skin','浏览并一键应用在线皮肤','skin'),linkRow(CFG.strings.wallpaperLibrary,'','library','使用本机已经安装的壁纸','library'),linkRow(CFG.strings.clearBackground,CFG.strings.clear,'clear','恢复原来的外观','clear')].forEach(function(item){group.appendChild(item)});
  pop.appendChild(group);
}else{
  sound=pill(PERSIST.muted?CFG.strings.soundOff:CFG.strings.soundOn,'sound');themes=pill(CFG.strings.choose,'themes');
  alphaRow=row(CFG.strings.transparency,alpha);alphaRow.dataset.alphaRow='true';
  var items=[row(CFG.strings.dim,dim),row(CFG.strings.blur,blur),alphaRow,row(CFG.strings.sound,sound,'sound'),row(CFG.strings.importBackground,pill(CFG.strings.chooseFile,'import'),'import'),row(CFG.strings.savedThemes,themes,'themes'),row(CFG.strings.skinCenter,pill(CFG.strings.open,'skin'),'skin'),row(CFG.strings.clearBackground,pill(CFG.strings.clear,'clear'),'clear')];
  items.forEach(function(r,i){pop.appendChild(r);if(i<items.length-1){var s=document.createElement('div');s.className='bc-desktop-sep';pop.appendChild(s)}});
}
function syncSound(){if(settingsMode)sound.setAttribute('aria-checked',String(!PERSIST.muted));else sound.textContent=PERSIST.muted?CFG.strings.soundOff:CFG.strings.soundOn}
function syncReadability(){
  if(!settingsMode)return;
  var on=PERSIST.readable!==false;
  readability.setAttribute('aria-checked',String(on));alphaRow.dataset.disabled=String(on);alpha.input.disabled=on;
  if(on)root.removeAttribute('data-bc-readable-surfaces');else root.setAttribute('data-bc-readable-surfaces','false');
}
syncReadability();syncSound();
var msg=document.createElement('div');msg.className='bc-desktop-msg';pop.appendChild(msg);function say(t){msg.textContent=String(t||'')};window.__bcDesktopMessage=say;
var input=document.createElement('input');input.type='file';input.accept=CFG.imageExtensions.concat(CFG.videoExtensions).join(',');input.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;opacity:0';input.dataset.id='fileInput';pop.appendChild(input);

var nameDialog=node('div','bc-desktop-dialog');nameDialog.hidden=true;nameDialog.setAttribute('data-bc-desktop',CFG.kind);var nameCard=node('div','bc-desktop-card'),nameTitle=node('h2'),nameFile=node('p'),nameInput=node('input'),nameError=node('p','bc-desktop-error'),nameActions=node('div','bc-desktop-actions'),nameCancel=node('button','bc-desktop-pill'),nameConfirm=node('button','bc-desktop-pill');nameCard.setAttribute('role','dialog');nameCard.setAttribute('aria-modal','true');nameFile.setAttribute('data-file','');nameInput.type='text';nameInput.maxLength=80;nameError.setAttribute('data-error','');nameError.hidden=true;nameCancel.setAttribute('data-cancel','');nameConfirm.setAttribute('data-confirm','');nameActions.append(nameCancel,nameConfirm);nameCard.append(nameTitle,nameFile,nameInput,nameError,nameActions);nameDialog.appendChild(nameCard);document.body.appendChild(nameDialog);
nameTitle.textContent=CFG.strings.saveTheme;nameInput.placeholder=CFG.strings.themeNamePlaceholder;nameCancel.textContent=CFG.strings.cancel;nameConfirm.textContent=CFG.strings.saveAndApply;
var pendingImport=null;
function closeName(){pendingImport=null;nameDialog.hidden=true;nameInput.value=''}
nameDialog.querySelector('[data-cancel]').onclick=closeName;

var savedDialog=node('div','bc-desktop-dialog'),savedCard=node('div','bc-desktop-card'),savedTitle=node('h2',null,CFG.strings.savedThemes),savedList=node('div'),savedEmpty=node('p',null,CFG.strings.noThemes),savedActions=node('div','bc-desktop-actions'),savedClose=node('button','bc-desktop-pill',CFG.strings.close);savedDialog.hidden=true;savedDialog.setAttribute('data-bc-desktop',CFG.kind);savedCard.setAttribute('role','dialog');savedCard.setAttribute('aria-modal','true');savedList.setAttribute('data-list','');savedEmpty.setAttribute('data-empty','');savedClose.setAttribute('data-close','');savedActions.appendChild(savedClose);savedCard.append(savedTitle,savedList,savedEmpty,savedActions);savedDialog.appendChild(savedCard);document.body.appendChild(savedDialog);savedClose.onclick=function(){savedDialog.hidden=true};
function kindLabel(type){
  return type==='video'?CFG.strings.video:type==='scene'?(CFG.strings.scene||CFG.strings.image):CFG.strings.image;
}
function syncThemes(){
  if(themes)themes.textContent=PERSIST.themes.length?String(PERSIST.themes.length):CFG.strings.choose;
  if(settingsMode)renderThemes();
}
function renderThemes(){
  var list=inlineList||savedList;
  list.textContent='';
  var shown=inlineList?PERSIST.themes.filter(function(t){return t.type===themeCategory}):PERSIST.themes;
  savedEmpty.hidden=shown.length>0;
  if(inlineList&&!shown.length)list.appendChild(node('p','bc-desktop-desc',CFG.strings.noThemes));
  shown.forEach(function(t){
    var b=node('button','bc-desktop-theme');
    b.type='button';b.dataset.active=String(t.id===PERSIST.activeThemeId);
    b.append(node('span','bc-desktop-dot'),node('span','bc-desktop-theme-name',t.name),node('span','bc-desktop-kind',kindLabel(t.type)));
    b.onclick=function(){
      invalidateMedia();savedDialog.hidden=true;
      window.__bcDesktopApplyRequest={requestId:Date.now()+'-'+Math.random(),mode:'theme',path:t.path,name:t.name,themeId:t.id,save:false};
    };
    list.appendChild(b);
  });
}
syncThemes();

function themeStem(name){
  var base=String(name||'').trim();
  return (base.replace(/\\.[^.]+$/,'').trim()||base).slice(0,80);
}
function mediaKind(file){
  var ext='.'+String(file.name).split('.').pop().toLowerCase();
  return CFG.videoExtensions.indexOf(ext)!==-1?'video':CFG.imageExtensions.indexOf(ext)!==-1?'image':null;
}
function mountMedia(file,kind,el,framed){
  return new Promise(function(resolve,reject){
    var media=null,done=false;
    var readyEvent=kind==='video'?'loadeddata':'load';
    function finish(error){
      if(done)return;done=true;clearTimeout(timer);pendingMedia.delete(cancel);
      el.removeEventListener('load',frameReady);
      if(media){media.removeEventListener(readyEvent,ready);media.removeEventListener('error',failed)}
      error?reject(error):resolve();
    }
    function ready(){finish()}
    function failed(){finish(new Error('media load failed'))}
    function cancel(){finish(new Error('stale media selection'));releaseMedia(el)}
    function start(target,urls){
      media=target;
      if(kind==='video'){media.loop=true;media.playsInline=true;media.muted=PERSIST.muted;media.preload='auto'}
      el.dataset.blobUrl=urls.createObjectURL(file);
      media.addEventListener(readyEvent,ready,{once:true});
      media.addEventListener('error',failed,{once:true});
      media.src=el.dataset.blobUrl;
    }
    function frameReady(){
      try{
        var video=el.contentDocument&&el.contentDocument.querySelector('video');
        if(!video)return;
        el.removeEventListener('load',frameReady);
        start(video,el.contentWindow.URL);
      }catch(error){finish(error)}
    }
    var timer=setTimeout(function(){finish(new Error('media timeout'))},30000);
    pendingMedia.add(cancel);
    if(framed){
      el.hidden=true;el.setAttribute('aria-hidden','true');el.tabIndex=-1;
      el.addEventListener('load',frameReady);
      el.srcdoc='<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}video{width:100%;height:100%;object-fit:cover}</style><video muted playsinline loop preload="auto"></video>';
      stage.appendChild(el);
    }else{
      try{start(el,URL)}catch(error){finish(error)}
    }
  });
}
async function applyFile(file,meta){
  invalidateMedia();
  var generation=mediaGeneration,kind=mediaKind(file);
  if(!kind){say(CFG.strings.unsupportedFile);throw new Error('unsupported media')}
  var themeName=meta.save?String(meta.name||'').trim().slice(0,80):'';
  if(meta.save&&!themeName)throw new Error('theme name required');
  var framed=kind==='video'&&CFG.videoFrame;
  var el=document.createElement(framed?'iframe':kind==='video'?'video':'img');
  try{
    await mountMedia(file,kind,el,framed);
    if(disposed||generation!==mediaGeneration)throw new Error('stale media selection');
  }catch(error){releaseMedia(el);throw error}
  var old=[].slice.call(stage.querySelectorAll('.bc-media'));
  el.className='bc-media';el.hidden=false;
  if(!framed)stage.appendChild(el);
  old.forEach(releaseMedia);
  root.setAttribute('data-bc-active','true');root.setAttribute('data-bc-media',kind);
  var video=mediaVideo(el);
  if(video){video.muted=PERSIST.muted;video.play().catch(function(){})}
  var storedType=settingsMode&&kind==='image'&&meta.themeType==='scene'?'scene':kind;
  var storedPath=meta.themePath||meta.path;
  PERSIST.wallpaper=storedPath;PERSIST.cleared=false;
  if(meta.save){
    var found=PERSIST.themes.find(function(t){return t.path===storedPath||(meta.provenance&&t.provenance&&t.provenance.source==='hnnulwh'&&t.provenance.sourceSkinId===meta.provenance.sourceSkinId)});
    if(!found){found={id:meta.themeId||('theme-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7))};PERSIST.themes.push(found)}
    found.name=themeName;found.type=storedType;found.path=storedPath;
    if(meta.provenance)found.provenance=meta.provenance;
    PERSIST.activeThemeId=found.id;
  }else if(meta.themeId){PERSIST.activeThemeId=meta.themeId}
  persist();syncThemes();
  say(storedType==='scene'?CFG.strings.appliedScene||CFG.strings.appliedImage:kind==='video'?CFG.strings.appliedVideo:CFG.strings.appliedImage);
  return true;
}
window.__bcDesktopPrepareFile=function(meta,expectedRequestId){
  if(expectedRequestId){
    if(window.__bcDesktopApplyRequest?.requestId!==expectedRequestId)return false;
    window.__bcDesktopApplyRequest=null;
  }
  invalidateMedia();window.__bcDesktopPendingFile=meta||null;return true;
};
function openName(meta,label,suggestion){
  pendingImport=meta;nameFile.textContent=label;nameError.hidden=true;nameInput.value=suggestion;
  nameDialog.hidden=false;nameInput.focus();nameInput.setSelectionRange(nameInput.value.length,nameInput.value.length);
}
input.addEventListener('change',function(){
  var file=input.files&&input.files[0],meta=window.__bcDesktopPendingFile;
  window.__bcDesktopPendingFile=null;input.value='';
  if(!file||!meta)return;
  if(meta.mode==='import'){
    openName({file:file,meta:meta},file.name,settingsMode?(meta.suggestedName||themeStem(file.name)):'');
    return;
  }
  applyFile(file,meta).then(function(){receipt(meta.requestId,{status:'ok'})}).catch(function(e){
    receipt(meta.requestId,{status:'error',error:String(e&&e.message||e)});
    if(!disposed&&String(e&&e.message)!=='stale media selection')say(CFG.strings.importFailed);
  });
});
nameConfirm.onclick=function(){
  var name=String(nameInput.value||'').trim();
  if(!name){nameError.textContent=CFG.strings.nameRequired;nameError.hidden=false;nameInput.focus();return}
  var pending=pendingImport;
  if(!pending)return;
  closeName();
  if(pending.libraryId){
    invalidateMedia();
    window.__bcDesktopApplyRequest={requestId:Date.now()+'-'+Math.random(),mode:'library',libraryId:pending.libraryId,name:name,save:true};
    return;
  }
  applyFile(pending.file,Object.assign({},pending.meta,{name:name,save:true})).catch(function(error){
    if(!disposed&&String(error&&error.message)!=='stale media selection')say(CFG.strings.importFailed);
  });
};
nameInput.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();nameDialog.querySelector('[data-confirm]').click()}else if(e.key==='Escape')closeName()});

dim.input.oninput=function(){PERSIST.dim=+dim.input.value;queueVars();persist()};
blur.input.oninput=function(){PERSIST.blur=+blur.input.value;queueVars();persist()};
alpha.input.oninput=function(){PERSIST.alpha=+alpha.input.value;queueVars();persist()};
function closePop(){if(!settingsMode)pop.style.display='none'}
function openPop(){if(settingsMode)return;pop.style.display='block';var safeTop=Math.max(0,Number(CFG.popupTopInset)||12),safeMin=safeTop+1,bottom=12;pop.style.maxHeight=Math.max(0,innerHeight-safeMin-bottom)+'px';var r=entry.getBoundingClientRect(),w=pop.offsetWidth||340,h=pop.offsetHeight||520,x=Math.max(12,Math.min(r.left,innerWidth-w-12)),y=r.bottom+8;if(y+h>innerHeight-bottom)y=r.top-h-8;y=Math.max(safeMin,Math.min(y,innerHeight-bottom-h));pop.style.left=x+'px';pop.style.top=y+'px'}
if(!settingsMode){
  entry.addEventListener('click',function(e){e.preventDefault();e.stopImmediatePropagation();pop.style.display==='block'?closePop():openPop()},{capture:true,signal:aborter.signal});
  entry.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();entry.click()}},{capture:true,signal:aborter.signal});
  document.addEventListener('mousedown',function(e){if(pop.style.display==='block'&&!pop.contains(e.target)&&!entry.contains(e.target))closePop()},{signal:aborter.signal});
}

var libraryDialog, libraryRequestId, libraryTrigger, requestLibrary;
function closeLibrary(){
  libraryDialog.hidden=true;
  libraryRequestId=null;
  window.__bcDesktopLibraryRequest=null;
  if(libraryTrigger&&libraryTrigger.isConnected)libraryTrigger.focus();
}
if(settingsMode){
  libraryDialog=node('div','bc-desktop-dialog');
  libraryDialog.hidden=true;libraryDialog.setAttribute('data-bc-desktop',CFG.kind);
  var libraryCard=node('div','bc-desktop-card'),libraryTitle=node('h2',null,CFG.strings.wallpaperLibrary);
  var libraryList=node('div'),libraryStatus=node('p'),libraryActions=node('div','bc-desktop-actions');
  var libraryPrevious=pill('上一页'),libraryNext=pill('下一页'),libraryClose=pill(CFG.strings.close);
  libraryTitle.id=BC+'-library-title';
  libraryCard.setAttribute('role','dialog');libraryCard.setAttribute('aria-modal','true');libraryCard.setAttribute('aria-labelledby',libraryTitle.id);
  libraryStatus.setAttribute('role','status');libraryList.dataset.list='library';
  libraryActions.append(libraryPrevious,libraryNext,libraryClose);
  libraryCard.append(libraryTitle,libraryStatus,libraryList,libraryActions);
  libraryDialog.append(libraryCard);document.body.append(libraryDialog);
  libraryClose.onclick=closeLibrary;

  requestLibrary=function(offset, refresh){
    libraryRequestId=Date.now()+'-'+Math.random();
    libraryDialog.hidden=false;
    libraryStatus.textContent='正在读取本机壁纸库…';libraryList.replaceChildren();
    libraryPrevious.disabled=true;libraryNext.disabled=true;libraryClose.focus();
    window.__bcDesktopLibraryRequest={requestId:libraryRequestId,offset:offset,refresh:refresh===true};
  };
  window.__bcDesktopShowLibrary=function(requestId,page){
    if(disposed||libraryDialog.hidden||requestId!==libraryRequestId)return false;
    libraryStatus.textContent=page.items.length?'':'没有找到可用的本机壁纸。';
    page.items.forEach(function(item){
      var b=node('button','bc-desktop-theme');b.type='button';
      b.append(node('span','bc-desktop-theme-name',item.title),node('span','bc-desktop-kind',kindLabel(item.type)));
      b.onclick=function(){closeLibrary();openName({libraryId:item.id},item.title,item.title)};
      libraryList.append(b);
    });
    libraryPrevious.disabled=page.offset===0;
    libraryPrevious.onclick=function(){requestLibrary(Math.max(0,page.offset-page.limit))};
    libraryNext.disabled=page.offset+page.limit>=page.total;
    libraryNext.onclick=function(){requestLibrary(page.offset+page.limit)};
    return true;
  };
}

pop.addEventListener('click',function(e){
  var tab=e.target.closest('[data-theme-tab]');
  if(tab){
    themeCategory=tab.dataset.themeTab;
    pop.querySelectorAll('[data-theme-tab]').forEach(function(n){n.dataset.active=String(n===tab)});
    renderThemes();return;
  }
  var a=e.target.closest('[data-action]');
  if(!a)return;
  switch(a.dataset.action){
    case 'readability':
      PERSIST.readable=!PERSIST.readable;syncReadability();persist();break;
    case 'import':
      window.__bcDesktopPickRequest=Date.now();say(CFG.strings.chooseFile);closePop();break;
    case 'themes':
      renderThemes();savedDialog.hidden=false;closePop();break;
    case 'skin':
      window.__bcDesktopSkinCenterRequest=Date.now();closePop();break;
    case 'library':
      if(requestLibrary){libraryTrigger=a;requestLibrary(0,true)}break;
    case 'dim-reset':
      PERSIST.dim=dim.setValue(49);setVars();persist();break;
    case 'blur-reset':
      PERSIST.blur=blur.setValue(0);setVars();persist();break;
    case 'sound':
      PERSIST.muted=!PERSIST.muted;
      stage.querySelectorAll('.bc-media').forEach(function(el){var v=mediaVideo(el);if(v)v.muted=PERSIST.muted});
      syncSound();persist();break;
    case 'clear':
      clearMedia();closeName();window.__bcDesktopApplyRequest=null;window.__bcDesktopPendingFile=null;
      PERSIST.wallpaper=null;PERSIST.cleared=true;PERSIST.activeThemeId=null;persist();closePop();break;
  }
},{signal:aborter.signal});
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape')return;
  if(!nameDialog.hidden)closeName();
  else if(libraryDialog&&!libraryDialog.hidden)closeLibrary();
  else if(!savedDialog.hidden)savedDialog.hidden=true;
  else{closePop();return}
  e.preventDefault();e.stopPropagation();
},{capture:true,signal:aborter.signal});

if(settingsMode){
  function ownText(el){
    return [...el.childNodes].filter(function(child){return child.nodeType===3}).map(function(child){return child.textContent}).join('').trim();
  }
  function appearanceHost(){
    var modal=document.querySelector(CFG.settings.modalSelector);
    if(!modal)return null;
    var visible=function(el){return el.getClientRects().length>0&&getComputedStyle(el).visibility==='visible'};
    var title=[...modal.querySelectorAll('*')].find(function(el){return ownText(el)===CFG.settings.pageTitle&&visible(el)});
    for(var host=title;host&&host!==modal;host=host.parentElement){
      if((host.innerText||'').includes(CFG.settings.pageMarker))return host;
    }
    return null;
  }
  function placeSettings(){
    var host=appearanceHost();
    var parent=host||root;
    if(pop.parentElement!==parent)parent.append(pop);
    pop.hidden=!host;
    if(!host&&!libraryDialog.hidden)closeLibrary();
  }
  var settingsObserver=new MutationObserver(function(records){
    if(records.every(function(record){return pop.contains(record.target)||libraryDialog.contains(record.target)}))return;
    placeSettings();
  });
  placeSettings();
  settingsObserver.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});
  aborter.signal.addEventListener('abort',function(){settingsObserver.disconnect()},{once:true});
}

window.__bcDesktopRestoreState=function(raw){
  try{
    var s=typeof raw==='string'?JSON.parse(raw):raw;
    if(!s||typeof s!=='object'||Array.isArray(s))return false;
    PERSIST.schema=CFG.schema;
    PERSIST.wallpaper=typeof s.wallpaper==='string'?s.wallpaper:null;
    PERSIST.cleared=!!s.cleared;
    PERSIST.dim=dim.setValue(Number.isFinite(+s.dim)?+s.dim:49);
    PERSIST.blur=blur.setValue(Number.isFinite(+s.blur)?+s.blur:0);
    PERSIST.alpha=alpha.setValue(Number.isFinite(+s.alpha)?+s.alpha:100);
    PERSIST.muted=s.muted!==false;
    PERSIST.readable=s.readable!==false;
    PERSIST.themes=Array.isArray(s.themes)?s.themes.filter(function(t){
      return t&&typeof t.id==='string'&&typeof t.name==='string'&&typeof t.path==='string'&&(t.type==='image'||t.type==='video'||(settingsMode&&t.type==='scene'));
    }).slice(0,200):[];
    PERSIST.activeThemeId=typeof s.activeThemeId==='string'?s.activeThemeId:null;
    syncSound();syncReadability();setVars();syncThemes();
    if(PERSIST.cleared)clearMedia();
    else if(PERSIST.wallpaper){
      var t=PERSIST.themes.find(function(x){return x.id===PERSIST.activeThemeId||x.path===PERSIST.wallpaper});
      window.__bcDesktopApplyRequest={requestId:'restore-'+Date.now(),mode:'restore',path:PERSIST.wallpaper,name:t?t.name:'',themeId:t?t.id:null,save:false};
    }
    return true;
  }catch(e){return false}
};
window.__bcDesktopApplyGallery=function(path,name,provenance){window.__bcDesktopApplyRequest={requestId:'gallery-'+Date.now(),mode:'gallery',path:String(path),name:String(name||'Skin'),provenance:provenance||null,themeId:null,save:true};return true};
root.setAttribute('data-bc-desktop-host',CFG.kind);root.setAttribute('data-bc-desktop-build',CFG.build);return 'ok';
})()`;
}

export function buildDesktopBackgroundCleanup(kind: DesktopCdpHostKind): string {
  return `(()=>{
    if(window.__bcDesktopDispose)window.__bcDesktopDispose();
    if(window.__bcDesktopAbort)window.__bcDesktopAbort.abort();
    if(window.__bcDesktopHistoryRestore)window.__bcDesktopHistoryRestore();
    if(window.__bcDesktopSettingsObserver)window.__bcDesktopSettingsObserver.disconnect();
    if(window.__bcDesktopThemeObserver)window.__bcDesktopThemeObserver.disconnect();
    document.querySelectorAll('[data-bc-desktop="${kind}"]').forEach(n=>n.remove());
    const root=document.documentElement;
    for(const attr of ['desktop-host','desktop-build','active','media','light','theme','blur-user','settings','readable-surfaces']){
      root.removeAttribute('data-bc-'+attr);
    }
    for(const name of ['--bc-scrim-val','--bc-bg-blur','--bc-surface-alpha-pct'])root.style.removeProperty(name);
    for(const key of ['Abort','ThemeObserver','ThemeMedia','SettingsObserver','HistoryRestore','PersistStore',
      'PersistGet','PersistDirty','RestoreState','PrepareFile','ApplyResult','PendingFile','Dispose','ApplyGallery',
      'ApplyRequest','PickRequest','SkinCenterRequest','LibraryRequest','ShowLibrary','Message']){
      delete window['__bcDesktop'+key];
    }
    return 'cleaned';
  })()`;
}

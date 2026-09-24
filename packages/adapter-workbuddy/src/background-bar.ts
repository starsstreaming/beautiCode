/**
 * background-bar.ts — WorkBuddy 侧栏「自定义背景」注入模块（v6 · 宿主菜单项风格）
 *
 * beautiCode 的 WorkBuddy 适配层功能块：payload 字符串由 scripts/wb-cdp-runner.mjs
 * 通过 `Runtime.evaluate` 注入。壁纸与三滑杆由守护落盘 state.json 恢复。
 *
 * UI 交互（v5→v6）：点击「自定义背景」浮出弹窗，复刻宿主用户名菜单（.user-menu-popover
 * 实测配方：portal 到 body、fixed、z-index:1100、宽 320、圆角 16px、0.5px 描边、
 * 双层投影、padding 4px 0、从触发器上方弹出；深 bg rgb(36,36,36) / 浅 html.light 变体）。
 * v6 变更（用户要求）：
 *   - 菜单项**复用宿主类** user-menu-item / user-menu-item-icon（hover 免费继承）
 *   - **无小字注释**：每项只有「图标 + 标题 + 右侧控件」
 *   - **每项之间都有分隔线**（复用宿主 user-menu-separator）
 *   - 每项前有同风格小图标：16×16、currentColor、1.3 圆头描边（与侧栏条目图标同族）
 *
 * 视频显示协议（不可动）：契约 poster-first —— video 默认 opacity:0，须 <html> 带
 *   data-bc-active=true + data-bc-media=video + data-bc-video-ready=true（首帧呈现）才显示；
 *   此时 img display:none（视频压过图片的层级设计）。
 *
 * 文件选择（跨系统）：面板发 __bcPickRequest，守护开系统原生选择器
 *   （macOS osascript / Windows PowerShell -STA / Linux zenity→kdialog），
 *   路径经 CDP DOM.setFileInputFiles 塞回隐藏 input → change → blob: URL。
 *
 * 真实锚点（CDP 探查运行时 DOM）：.conversation-list / .conversation-list-tabs /
 *   .conversation-list-tab-button；asar 里的 cb-sidebar-nav 当前视图不渲染，不可用作选择器。
 */

/** 注入节点共用的 data-bc-injected 值。 */
export const BACKGROUND_BAR_STYLE_ID = 'beauticode-workbuddy-bg';

/**
 * payload 世代戳：每次改 payload 内容时递增。守卫用它判断页面上的注入
 * 是否为「当前代」——旧代按钮的闭包攥着已分离的节点引用，必须全拆重建。
 */
export const BACKGROUND_BAR_VERSION = 'v10.1';

/** 注入 IIFE 字符串；幂等（守卫同时校验 entry 是否仍在 DOM，侧栏收起/重挂后可重建）。 */
export const BACKGROUND_BAR_INJECTION: string = (function () {
  return `(function () {
var BC = ${JSON.stringify(BACKGROUND_BAR_STYLE_ID)};
var BUILD = ${JSON.stringify(BACKGROUND_BAR_VERSION)};

var list = document.querySelector('.conversation-list');
var tabs = list && list.querySelector('.conversation-list-tabs');
if (!list || !tabs) return 'no-list-found';

// ── 幂等守卫（版本感知）：「存在」不等于「健康」——旧代 payload 装的按钮，
//    闭包里攥着已被新版重装删掉的节点引用（点它 = 对空气开关，实测踩过）。
//    所以必须校验 <html> 上的版本戳；版本不符/节点缺失 → 全拆重建（舞台与媒体保留）。
var verAlive = document.documentElement.getAttribute('data-bc-bg-ver');
var entryAlive = document.getElementById(BC + '-entry');
var panelAlive = document.getElementById(BC + '-panel');
if (window.__bcBackgroundDemoInstalled && verAlive === BUILD && entryAlive && panelAlive) {
  return 'already-installed';
}
window.__bcBackgroundDemoInstalled = true;

// 全拆：入口/面板/样式（含重复安装产生的多份同 id 节点）；舞台与媒体保留
document.querySelectorAll(
  '[id="' + BC + '-entry"],[id="' + BC + '-panel"],[id="' + BC + '-style"]'
).forEach(function (n) { n.remove(); });
document.querySelectorAll('[data-bc-injected="' + BC + '"]').forEach(function (n) {
  if (n.closest('#beauticode-bg-stage')) return;
  if (n.tagName === 'IMG' || n.tagName === 'VIDEO') return;
  n.remove();
});

// ── 样式：舞台协议层 + 弹窗表面（宿主 popover 配方） ──
var styleEl = document.createElement('style');
styleEl.id = BC + '-style';
styleEl.setAttribute('data-bc-injected', BC);
styleEl.textContent = [
  '#beauticode-bg-stage{background-color:#101114}',
  // 蒙版：!important 压过契约的字面量规则（html:root 前缀特异性更高，不用 !important 赢不了）；
  // 颜色跟主题（深=黑纱 / 浅=白纱），浓度由滑杆驱动的 --bc-scrim-val 控制，0 = 主题默认
  'html:root #beauticode-bg-stage::after{background:rgba(0,0,0,var(--bc-scrim-val,0)) !important}',
  'html.light #beauticode-bg-stage::after{background:rgba(255,255,255,var(--bc-scrim-val,0)) !important}',
  '#beauticode-bg-stage .bc-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
  'html[data-bc-bg-blur] #beauticode-bg-stage .bc-media{filter:blur(var(--bc-bg-blur,0px))}',
  // 弹窗表面（宿主 popover 配方实测值，深/浅两套）
  '.beauticode-popover{position:fixed;z-index:1100;width:320px;max-height:min(600px,calc(100vh - 90px));overflow-y:auto;overflow-x:hidden;' +
    'padding:4px 0;border-radius:16px;background:rgb(36,36,36);color:rgba(228,228,228,.92);' +
    'box-shadow:color(srgb 0 0 0/.4) 0 24px 48px -8px,color(srgb 0 0 0/.3) 0 6px 12px -4px;' +
    'outline:.5px solid rgba(255,255,255,.14);outline-offset:-.5px;' +
    'font:15px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;display:none}',
  'html.light .beauticode-popover{background:rgb(252,252,252);color:rgba(28,28,30,.92);' +
    'box-shadow:color(srgb 0 0 0/.14) 0 24px 48px -8px,color(srgb 0 0 0/.1) 0 6px 12px -4px;' +
    'outline-color:rgba(0,0,0,.1)}',
  // 菜单项（复用宿主 user-menu-item / user-menu-item-icon / user-menu-separator）
  '.beauticode-popover,.beauticode-popover *{box-sizing:border-box}',
  '.beauticode-popover .user-menu-item{display:flex;align-items:center;gap:10px;width:100%;padding:8px 16px;margin:0}',
  '.beauticode-popover .user-menu-item:hover{background:rgba(255,255,255,.06)}',
  'html.light .beauticode-popover .user-menu-item:hover{background:rgba(0,0,0,.05)}',
  '.beauticode-popover .user-menu-item-icon{display:flex;flex:none;color:inherit;opacity:.9}',
  '.beauticode-popover .user-menu-item-icon svg{width:16px;height:16px;display:block}',
  '.beauticode-popover .bc-title{flex:1;font-size:13px;font-weight:500;min-width:0}',
  '.beauticode-popover .bc-ctl{flex:none;display:flex;align-items:center;gap:6px;max-width:60%}',
  '.beauticode-popover .bc-sliderval{min-width:2.6em;font-size:11px;opacity:.62;text-align:right;font-variant-numeric:tabular-nums}',
  '.beauticode-popover input[type=range]{width:96px;max-width:100%;accent-color:currentColor;cursor:pointer}',
  '.beauticode-popover .bc-pill{padding:4px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.14);' +
    'background:rgba(255,255,255,.08);color:inherit;font:12px inherit;cursor:pointer;white-space:nowrap}',
  '.beauticode-popover .bc-pill:hover{background:rgba(255,255,255,.15)}',
  'html.light .beauticode-popover .bc-pill{border-color:rgba(0,0,0,.16);background:rgba(0,0,0,.06)}',
  'html.light .beauticode-popover .bc-pill:hover{background:rgba(0,0,0,.12)}',
  '.beauticode-popover .bc-lock{font:10px ui-monospace,monospace;opacity:.65;border:1px solid currentColor;border-radius:999px;padding:3px 9px;white-space:nowrap}',
        // 皮肤中心浮窗（DSH gallery 对齐；配色/字体/圆角与弹窗同族）
  '.beauticode-gal{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}',
  '.beauticode-gal[hidden]{display:none}',
  '.beauticode-gal .bcg-panel{width:min(880px,calc(100vw - 32px));height:min(640px,calc(100vh - 32px));display:flex;flex-direction:column;border-radius:20px;background:rgb(36,36,36);color:rgba(228,228,228,.92);outline:.5px solid rgba(255,255,255,.14);overflow:hidden;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}',
  'html.light .beauticode-gal .bcg-panel{background:rgb(252,252,252);color:rgba(28,28,30,.92);outline-color:rgba(0,0,0,.1)}',
  '.beauticode-gal .bcg-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:.5px solid rgba(255,255,255,.12)}',
  'html.light .beauticode-gal .bcg-head{border-bottom-color:rgba(0,0,0,.1)}',
  '.beauticode-gal .bcg-head h2{margin:0;font-size:15px;font-weight:500}',
  '.beauticode-gal .bcg-head input,.beauticode-gal .bcg-head select{height:30px;padding:0 8px;border:.5px solid rgba(255,255,255,.14);border-radius:10px;background:rgba(255,255,255,.08);color:inherit;font:inherit;font-size:13px}',
  '.beauticode-gal .bcg-head input:focus,.beauticode-gal .bcg-head select:focus{outline:none;box-shadow:0 0 0 2px rgba(255,255,255,.2)}',
  'html.light .beauticode-gal .bcg-head input,html.light .beauticode-gal .bcg-head select{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.14)}',
  '.beauticode-gal .bcg-grid{flex:1;overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;align-content:start}',
  '.beauticode-gal .bcg-card{border:.5px solid rgba(255,255,255,.14);border-radius:14px;overflow:hidden;background:rgba(255,255,255,.04);color:inherit;text-align:left;cursor:pointer;padding:0;font:inherit}',
  '.beauticode-gal .bcg-card:hover{background:rgba(255,255,255,.09)}',
  'html.light .beauticode-gal .bcg-card{background:rgba(0,0,0,.03)}',
  'html.light .beauticode-gal .bcg-card:hover{background:rgba(0,0,0,.07)}',
  '.beauticode-gal .bcg-card img,.beauticode-gal .bcg-card video{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:rgb(24,24,24)}',
  '.beauticode-gal .bcg-card span{display:block;padding:8px 10px;font-size:13px}',
  '.beauticode-gal .bcg-msg,.beauticode-gal .bcg-foot{padding:0 14px 12px;color:rgba(228,228,228,.55);font-size:12px;line-height:18px}',
  'html.light .beauticode-gal .bcg-msg,html.light .beauticode-gal .bcg-foot{color:rgba(28,28,30,.55)}',
  '.beauticode-gal .bcg-foot a{color:inherit}',
  '.beauticode-gal .bcg-close{margin-left:auto;height:30px;padding:0 12px;border:.5px solid rgba(255,255,255,.14);border-radius:10px;background:rgba(255,255,255,.08);color:inherit;font:inherit;font-size:13px;cursor:pointer}',
  '.beauticode-gal .bcg-close:hover{background:rgba(255,255,255,.15)}',
  'html.light .beauticode-gal .bcg-close{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.14)}',
  // 主题命名与已保存主题选择：沿用 WorkBuddy popover 的深浅色配方。
  '.beauticode-theme-dialog{position:fixed;inset:0;z-index:3200;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.55)}',
  '.beauticode-theme-dialog[hidden]{display:none}',
  '.beauticode-theme-card{display:flex;flex-direction:column;gap:12px;width:min(420px,calc(100vw - 48px));max-height:min(600px,calc(100vh - 48px));padding:18px;border-radius:18px;background:rgb(36,36,36);color:rgba(228,228,228,.92);outline:.5px solid rgba(255,255,255,.14);box-shadow:color(srgb 0 0 0/.4) 0 24px 48px -8px;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}',
  'html.light .beauticode-theme-card{background:rgb(252,252,252);color:rgba(28,28,30,.92);outline-color:rgba(0,0,0,.1)}',
  '.beauticode-theme-card h2{margin:0;font-size:16px;font-weight:600}',
  '.beauticode-theme-file,.beauticode-theme-empty,.beauticode-theme-error{margin:0;font-size:12px;line-height:18px;opacity:.65;overflow-wrap:anywhere}',
  '.beauticode-theme-error{color:#ff8f8f;opacity:1}',
  '.beauticode-theme-card input{height:38px;padding:0 11px;border:.5px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(255,255,255,.08);color:inherit;font:inherit}',
  'html.light .beauticode-theme-card input{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.16)}',
  '.beauticode-theme-actions{display:flex;justify-content:flex-end;gap:8px}',
  '.beauticode-theme-actions button,.beauticode-theme-row{cursor:pointer;border:.5px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:inherit;font:inherit}',
  '.beauticode-theme-actions button{height:34px;padding:0 13px;border-radius:10px}',
  '.beauticode-theme-actions button[data-theme-confirm]{background:rgba(255,255,255,.16)}',
  'html.light .beauticode-theme-actions button,html.light .beauticode-theme-row{border-color:rgba(0,0,0,.14);background:rgba(0,0,0,.04)}',
  '.beauticode-theme-list{display:flex;flex-direction:column;gap:8px;overflow:auto;min-height:0}',
  '.beauticode-theme-row{display:flex;align-items:center;gap:10px;width:100%;min-height:46px;padding:8px 11px;border-radius:12px;text-align:left}',
  '.beauticode-theme-row:hover{background:rgba(255,255,255,.12)}',
  'html.light .beauticode-theme-row:hover{background:rgba(0,0,0,.08)}',
  '.beauticode-theme-dot{width:8px;height:8px;border-radius:50%;background:transparent;border:1px solid currentColor;flex:none}',
  '.beauticode-theme-row[data-active="true"] .beauticode-theme-dot{background:#27d7a1;border-color:#27d7a1}',
  '.beauticode-theme-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.beauticode-theme-kind{font-size:11px;opacity:.58}',
].join('');
document.head.appendChild(styleEl);

// ── 侧栏条目 ─────────────────────────────────────────────────────────
var btn = document.createElement('button');
btn.type = 'button';
btn.id = BC + '-entry';
btn.setAttribute('data-bc-injected', BC);
btn.setAttribute('aria-expanded', 'false');
btn.className = 'conversation-list-tab-button conversation-list-tab-button-box';
// 图标对齐宿主 tab 统一风格：16x16 填充式 wb-icon，svg 直接作为按钮首子元素
btn.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" width="16" height="16" class="wb-icon" aria-hidden="true"><path fill-rule="evenodd" d="M3.6 2.4h8.8A2.2 2.2 0 0 1 14.6 4.6v6.8a2.2 2.2 0 0 1-2.2 2.2H3.6a2.2 2.2 0 0 1-2.2-2.2V4.6a2.2 2.2 0 0 1 2.2-2.2Zm0 1.4a.8.8 0 0 0-.8.8v6.8c0 .44.36.8.8.8h8.8c.44 0 .8-.36.8-.8V4.6a.8.8 0 0 0-.8-.8H3.6Z"/><circle cx="5.9" cy="6.1" r="1.05"/><path d="M3.9 11.7l2.7-2.8a.9.9 0 0 1 1.3 0l1.05 1.1 1.75-1.95a.9.9 0 0 1 1.34 0l2 2.25v.4H3.9Z"/></svg>');
var labelEl = document.createElement('span');
labelEl.className = 'conversation-list-tab-button-label';
labelEl.textContent = '自定义背景';
btn.appendChild(labelEl);
// 用户要求：放在「更多」前面；找不到则退回末尾
var moreBtn = null;
tabs.querySelectorAll('.conversation-list-tab-button').forEach(function (b) {
  var lbl = b.querySelector('.conversation-list-tab-button-label');
  if (lbl && lbl.textContent.trim() === '更多') moreBtn = b;
});
if (moreBtn) tabs.insertBefore(btn, moreBtn); else tabs.appendChild(btn);

// ── 弹窗（portal 到 body，复刻宿主 popover） ─────────────────────────
var pop = document.createElement('div');
pop.className = 'beauticode-popover';
pop.id = BC + '-panel';
pop.setAttribute('data-bc-injected', BC);
pop.setAttribute('role', 'menu');
pop.setAttribute('aria-label', '背景');

// 菜单项构造：图标（宿主 user-menu-item-icon 槽）+ 标题 + 右侧控件
function iconSvg(inner) {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
}
var ICONS = {
  dim: iconSvg('<circle cx="8" cy="8" r="5.2"/><path d="M8 2.8a5.2 5.2 0 0 1 0 10.4z" fill="currentColor" stroke="none"/>'),
  blur: iconSvg('<path d="M8 2.6c2.5 2.6 3.9 4.4 3.9 6.1a3.9 3.9 0 1 1-7.8 0c0-1.7 1.4-3.5 3.9-6.1z"/>'),
  sound: iconSvg('<path d="M3.2 6.3v3.4h2.1L8.4 12.4V3.6L5.3 6.3H3.2z"/><path d="M10.4 5.6a3.2 3.2 0 0 1 0 4.8"/><path d="M12 4.1a5.3 5.3 0 0 1 0 7.8"/>'),
  media: iconSvg('<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.6"/><path d="M2.4 10.2l3-2.6 2.4 2 2.2-2.4 3.2 3"/><circle cx="6.2" cy="6.2" r=".9" fill="currentColor" stroke="none"/>'),
  clear: iconSvg('<path d="M3.1 4.6h9.8"/><path d="M6.3 4.6V3.3h3.4v1.3"/><path d="M4.4 4.6l.6 8h6l.6-8"/><path d="M6.7 6.9v3.8M9.3 6.9v3.8"/>'),
  lock: iconSvg('<path d="M2.8 8 8 5.1 13.2 8 8 10.9z"/><path d="M2.8 10.9 8 13.8 13.2 10.9"/>'),
  store: iconSvg('<path fill-rule="evenodd" d="M8 1.2c1.66 0 3 1.34 3 3v.8h1.9c.66 0 1.2.54 1.2 1.2v6.6c0 1.33-1.08 2.4-2.4 2.4H4.3c-1.32 0-2.4-1.07-2.4-2.4V6.2c0-.66.54-1.2 1.2-1.2H5v-.8c0-1.66 1.34-3 3-3Zm0 1.3c-.94 0-1.7.76-1.7 1.7v.8h3.4v-.8c0-.94-.76-1.7-1.7-1.7Z"/>')
};
function menuItem(iconInner, title, control, clickable) {
  var r = document.createElement('div');
  r.className = 'user-menu-item';
  if (clickable) r.setAttribute('role', 'menuitem');
  var ic = document.createElement('span');
  ic.className = 'user-menu-item-icon';
  ic.innerHTML = iconSvg(iconInner);
  r.appendChild(ic);
  var titleEl = document.createElement('span');
  titleEl.className = 'bc-title';
  titleEl.textContent = title;
  r.appendChild(titleEl);
  if (control) {
    var ctl = document.createElement('span');
    ctl.className = 'bc-ctl';
    ctl.appendChild(control);
    r.appendChild(ctl);
  }
  return r;
}
function pill(text2, act) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'bc-pill';
  b.setAttribute('data-act', act);
  b.textContent = text2;
  return b;
}
function slider(cls, label) {
  var s = document.createElement('input');
  s.type = 'range'; s.className = cls; s.min = '0'; s.max = '100'; s.step = '1';
  s.value = '0'; s.setAttribute('aria-label', label);
  return s;
}
function sliderValue() {
  var v = document.createElement('span');
  v.className = 'bc-sliderval';
  v.textContent = '自动';
  return v;
}

// 每项之间都有分隔线（用户要求）
// 控件先声明为外层变量（监听器在后面引用它们——v6 曾因内联进表达式导致
// "dimSlider is not defined"，payload 每次执行即崩、监听器从未挂上）
var dimSlider = slider('bc-dim-slider', '背景阴影');
var dimValue = sliderValue();
dimValue.setAttribute('data-id', 'dimValue');
pop.appendChild(menuItem(ICONS.dim, '背景阴影', (function(){ var w = document.createElement('span'); w.style.cssText = 'display:flex;align-items:center;gap:6px'; w.appendChild(dimSlider); w.appendChild(dimValue); return w; })()));
var blurSlider = slider('bc-blur-slider', '背景磨砂');
var blurValue = sliderValue();
blurValue.textContent = '0%';
blurValue.setAttribute('data-id', 'blurValue');
pop.appendChild(menuItem(ICONS.blur, '背景磨砂', (function(){ var w = document.createElement('span'); w.style.cssText = 'display:flex;align-items:center;gap:6px'; w.appendChild(blurSlider); w.appendChild(blurValue); return w; })()));
// 面板透明度滑杆（用户要求移到「背景磨砂」下面，且可调）：
// 'input' 只更新标签；松手（change）才挂请求 —— 守护按新 α 重造覆盖层（字面量必须重生成）
var alphaSlider = slider('bc-alpha-slider', '面板透明度');
alphaSlider.value = '18';
var alphaValue = sliderValue();
alphaValue.textContent = '18%';
alphaValue.setAttribute('data-id', 'alphaValue');
pop.appendChild(menuItem(ICONS.lock, '面板透明度', (function(){ var w = document.createElement('span'); w.style.cssText = 'display:flex;align-items:center;gap:6px'; w.appendChild(alphaSlider); w.appendChild(alphaValue); return w; })()));
var soundBtn = pill('已关', 'sound');
soundBtn.setAttribute('aria-pressed', 'false');
soundBtn.setAttribute('data-id', 'soundBtn');
pop.appendChild(menuItem(ICONS.sound, '声音', soundBtn, true));
pop.appendChild(menuItem(ICONS.media, '导入背景', pill('选择文件', 'media'), true));
var themesBtn = pill('选择', 'themes');
themesBtn.setAttribute('data-id', 'themesBtn');
pop.appendChild(menuItem(ICONS.media, '已保存主题', themesBtn, true));
pop.appendChild(menuItem(ICONS.store, '皮肤中心', pill('打开', 'store'), true));
pop.appendChild(menuItem(ICONS.clear, '清除背景', pill('清除', 'clear'), true));

// 隐藏文件输入框（离屏定位；原生选择 → DOM.setFileInputFiles → change → blob）
var fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.setAttribute('data-id', 'fileInput');
fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,video/mp4,video/quicktime,video/webm';
fileInput.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
pop.appendChild(fileInput);
fileInput.addEventListener('change', function (ev) {
  if (ev.target.files && ev.target.files[0]) requestThemeName(ev.target.files[0]);
  ev.target.value = '';
});

document.body.appendChild(pop);

// ── 皮肤中心浮窗（DSH gallery 对齐） ──
var GPORT = parseInt('__BC_GALLERY_PORT__', 10) || 9337;
var GTOKEN = __BC_GALLERY_TOKEN__;
var CENTER_URL = __BC_CENTER_URL__;
function safeCenterUrl(raw) {
  try {
    var parsed = new URL(String(raw || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href;
  } catch { return ''; }
}
function galleryUrl(pathname, extra) {
  var u = 'http://127.0.0.1:' + GPORT + pathname + '?t=' + encodeURIComponent(GTOKEN);
  if (extra) u += extra;
  return u;
}
var gal = document.createElement('div');
gal.className = 'beauticode-gal';
gal.setAttribute('data-bc-injected', BC);
gal.hidden = true;
gal.innerHTML = '<div class="bcg-panel" role="dialog" aria-modal="true"><div class="bcg-head"><h2>皮肤中心</h2><input class="bcg-q" placeholder="搜索"><select class="bcg-type"><option value="">全部</option><option value="image">图片</option><option value="video">视频</option></select><button type="button" class="bcg-close">关闭</button></div><div class="bcg-grid"></div><p class="bcg-msg"></p><p class="bcg-foot"></p></div>';
document.body.appendChild(gal);
var galGrid = gal.querySelector('.bcg-grid');
var galMsg = gal.querySelector('.bcg-msg');
var galFoot = gal.querySelector('.bcg-foot');
var galBusy = false;
function galRender(list) {
  galGrid.textContent = '';
  list.forEach(function (s2) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'bcg-card';
    card.dataset.id = String(s2.id || '');
    card.dataset.name = String(s2.name || '');
    var media = document.createElement(s2.type === 'video' ? 'video' : 'img');
    if (s2.type === 'video') { media.muted = true; media.preload = 'metadata'; }
    else { media.alt = ''; }
    media.src = galleryUrl('/media', '&id=' + encodeURIComponent(s2.id || ''));
    var span = document.createElement('span');
    span.textContent = s2.name + (s2.type === 'video' ? ' · 视频' : '');
    card.appendChild(media);
    card.appendChild(span);
    galGrid.appendChild(card);
  });
}
function galFootFill() {
  galFoot.textContent = '';
  var href = safeCenterUrl(CENTER_URL);
  if (!href) { galFoot.textContent = '未配置皮肤中心地址。'; return; }
  galFoot.appendChild(document.createTextNode('上传与审核在 '));
  var a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = '皮肤中心网站';
  galFoot.appendChild(a);
  galFoot.appendChild(document.createTextNode('。点卡片直接应用到 WorkBuddy。'));
}
function galLoad() {
  galMsg.textContent = '正在读取目录…';
  fetch(galleryUrl('/api/catalog'), { headers: { 'x-beauticode-media-token': GTOKEN } }).then(function (r2) { return r2.json(); }).then(function (d) {
    var q = (gal.querySelector('.bcg-q').value || '').trim();
    var ty = gal.querySelector('.bcg-type').value;
    var list = (d.skins || []).filter(function (s2) { return (!q || s2.name.indexOf(q) >= 0) && (!ty || s2.type === ty); });
    galRender(list);
    galMsg.textContent = list.length ? '' : '目录是空的。';
    galFootFill();
  }).catch(function () {
    galGrid.textContent = '';
    galMsg.textContent = '皮肤中心服务未响应（beautiCode 守护在运行吗？）';
  });
}
function galOpen() { gal.hidden = false; galLoad(); }
function galCloseFn() { gal.hidden = true; }
gal.querySelector('.bcg-close').addEventListener('click', galCloseFn);
gal.addEventListener('click', function (ev) { if (ev.target === gal) galCloseFn(); });
gal.querySelector('.bcg-q').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); galLoad(); } });
gal.querySelector('.bcg-type').addEventListener('change', function () { galLoad(); });
galGrid.addEventListener('click', function (ev) {
  var card = ev.target.closest('[data-id]');
  if (!card || galBusy) return;
  galBusy = true;
  galMsg.textContent = '正在应用「' + card.dataset.name + '」…';
  fetch(galleryUrl('/apply'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beauticode-media-token': GTOKEN },
    body: JSON.stringify({ id: card.dataset.id }),
  }).then(function (r2) { return r2.json(); }).then(function (j) {
    galMsg.textContent = j.ok ? '已应用到 WorkBuddy。' : (j.error || '应用失败。');
  }).catch(function () { galMsg.textContent = '应用失败（皮肤中心服务未响应）。'; }).finally(function () { galBusy = false; });
});

// ── 导入命名 + 已保存主题选择 ───────────────────────────────────────
var nameDialog = document.createElement('div');
nameDialog.className = 'beauticode-theme-dialog';
nameDialog.setAttribute('data-bc-injected', BC);
nameDialog.hidden = true;
nameDialog.innerHTML = '<div class="beauticode-theme-card" role="dialog" aria-modal="true" aria-labelledby="bc-theme-name-title"><h2 id="bc-theme-name-title">保存背景主题</h2><p class="beauticode-theme-file"></p><input type="text" maxlength="80" aria-label="主题名称" placeholder="输入主题名称"><p class="beauticode-theme-error" hidden></p><div class="beauticode-theme-actions"><button type="button" data-theme-cancel>取消</button><button type="button" data-theme-confirm>保存并应用</button></div></div>';
document.body.appendChild(nameDialog);
var nameInput = nameDialog.querySelector('input');
var nameFile = nameDialog.querySelector('.beauticode-theme-file');
var nameError = nameDialog.querySelector('.beauticode-theme-error');
var pendingThemeFile = null;
function suggestedThemeName(file) {
  return String(file && file.name || '新背景').replace(/\\.[^.]+$/, '').trim() || '新背景';
}
function cancelThemeName() {
  pendingThemeFile = null;
  window.__bcPendingPickPath = '';
  nameDialog.hidden = true;
}
function requestThemeName(file) {
  pendingThemeFile = file;
  nameFile.textContent = String(file.name || '');
  nameInput.value = suggestedThemeName(file);
  nameError.hidden = true;
  nameError.textContent = '';
  nameDialog.hidden = false;
  closePop();
  setTimeout(function () { nameInput.focus(); nameInput.select(); }, 0);
}
function confirmThemeName() {
  var name = String(nameInput.value || '').trim();
  if (!name) {
    nameError.textContent = '请输入主题名称。';
    nameError.hidden = false;
    nameInput.focus();
    return;
  }
  var file = pendingThemeFile;
  if (!file) { cancelThemeName(); return; }
  var real = String(window.__bcPendingPickPath || '');
  if (!real) {
    nameError.textContent = '无法读取文件路径，请取消后重新选择。';
    nameError.hidden = false;
    return;
  }
  nameDialog.hidden = true;
  pendingThemeFile = null;
  applyBlob(file, name, real);
}
nameDialog.querySelector('[data-theme-cancel]').addEventListener('click', cancelThemeName);
nameDialog.querySelector('[data-theme-confirm]').addEventListener('click', confirmThemeName);
nameInput.addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') { ev.preventDefault(); confirmThemeName(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); cancelThemeName(); }
});
nameDialog.addEventListener('mousedown', function (ev) { if (ev.target === nameDialog) cancelThemeName(); });

var savedDialog = document.createElement('div');
savedDialog.className = 'beauticode-theme-dialog';
savedDialog.setAttribute('data-bc-injected', BC);
savedDialog.hidden = true;
savedDialog.innerHTML = '<div class="beauticode-theme-card" role="dialog" aria-modal="true" aria-labelledby="bc-saved-title"><h2 id="bc-saved-title">已保存主题</h2><div class="beauticode-theme-list"></div><p class="beauticode-theme-empty" hidden>还没有保存的主题。导入图片或视频后会自动保存。</p><div class="beauticode-theme-actions"><button type="button" data-theme-close>关闭</button></div></div>';
document.body.appendChild(savedDialog);
var savedList = savedDialog.querySelector('.beauticode-theme-list');
var savedEmpty = savedDialog.querySelector('.beauticode-theme-empty');
function themeRows() {
  return Array.isArray(PERSIST && PERSIST.themes) ? PERSIST.themes.filter(function (t) {
    return t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.path === 'string';
  }) : [];
}
function syncThemesButton() {
  var count = themeRows().length;
  themesBtn.textContent = count ? String(count) + ' 个' : '选择';
}
function renderSavedThemes() {
  var rows = themeRows();
  savedList.textContent = '';
  savedEmpty.hidden = rows.length > 0;
  rows.forEach(function (theme) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'beauticode-theme-row';
    row.dataset.themeId = theme.id;
    row.dataset.active = theme.id === PERSIST.activeThemeId ? 'true' : 'false';
    var dot = document.createElement('span'); dot.className = 'beauticode-theme-dot';
    var title = document.createElement('span'); title.className = 'beauticode-theme-name'; title.textContent = theme.name;
    var kind = document.createElement('span'); kind.className = 'beauticode-theme-kind'; kind.textContent = theme.type === 'video' ? '视频' : '图片';
    row.appendChild(dot); row.appendChild(title); row.appendChild(kind);
    savedList.appendChild(row);
  });
  syncThemesButton();
}
function openSavedThemes() { renderSavedThemes(); savedDialog.hidden = false; closePop(); }
function closeSavedThemes() { savedDialog.hidden = true; }
savedDialog.querySelector('[data-theme-close]').addEventListener('click', closeSavedThemes);
savedDialog.addEventListener('mousedown', function (ev) { if (ev.target === savedDialog) closeSavedThemes(); });
savedList.addEventListener('click', function (ev) {
  var row = ev.target.closest('[data-theme-id]');
  if (!row) return;
  var theme = themeRows().find(function (t) { return t.id === row.dataset.themeId; });
  if (!theme) return;
  applyPath(theme.path, theme.id);
  renderSavedThemes();
  closeSavedThemes();
});

// 文件卡片点击 → 600ms 短沉降幕：产物视图挂载重绘在幕后完成（防进入期频闪）。
// 监听挂在 document 上——聊天里的产物卡片与面板内的卡片都能触发。
document.addEventListener('mousedown', function (ev) {
  if (!ev.target.closest('[class*="artifact-slot-panel__card"]')) return;
  var d = document.documentElement;
  d.setAttribute('data-bc-panel-settling', '1');
  setTimeout(function () { d.removeAttribute('data-bc-panel-settling'); }, 600);
});

// ── 舞台 + 媒体层（契约 poster-first 协议） ─────────────────────────
document.documentElement.setAttribute('data-bc-active', 'true');
// 舞台引用每次实时解析：WorkBuddy 重挂/整页刷新会让闭包捕获的旧节点脱离 DOM
//（恢复写进幽灵节点 = 看起来"没生效"，实测踩过），绝不缓存元素引用
function stageEl() {
  var s2 = document.getElementById('beauticode-bg-stage');
  if (!s2 || !s2.isConnected) {
    s2 = document.createElement('div');
    s2.id = 'beauticode-bg-stage';
    s2.setAttribute('data-bc-injected', BC);
    s2.style.cssText = ['position:fixed', 'inset:0', 'z-index:0', 'overflow:hidden',
      'pointer-events:none', 'background-color:#101114'].join(';');
    document.documentElement.insertBefore(s2, document.body);
  }
  return s2;
}
function media(tag) {
  var st = stageEl();
  var el = st.querySelector(tag + '.bc-media');
  if (!el) {
    el = document.createElement(tag);
    el.className = 'bc-media';
    st.appendChild(el);
    applyBlurVar();
  }
  return el;
}
function clearMedia() {
  var st = stageEl();
  [...st.querySelectorAll('img.bc-media,video.bc-media')].forEach(function (el) {
    if (el.tagName === 'VIDEO') { el.pause(); el.removeAttribute('src'); el.load(); }
    el.remove();
  });
  st.style.backgroundImage = 'none';
  document.documentElement.removeAttribute('data-bc-media');
  document.documentElement.removeAttribute('data-bc-video-ready');
}
function markMedia(kind) {
  document.documentElement.setAttribute('data-bc-media', kind);
  if (kind === 'video') document.documentElement.removeAttribute('data-bc-video-ready');
}
function markVideoReady(el) {
  var mark = function () { document.documentElement.setAttribute('data-bc-video-ready', 'true'); };
  if (el.readyState >= 2) mark();
  else {
    el.addEventListener('loadeddata', mark, { once: true });
    el.addEventListener('playing', mark, { once: true });
  }
}

var currentUrl = null;
var muted = true;
// 用户要求：所有注释性小文字（状态条）一律不展示 —— 守护回填也静默
function msg() {}
function filePathToUrl(p) {
  // Windows 兼容：反斜杠转正斜杠；'C:/foo' 补前导 '/' → file:///C:/foo
  var abs = String(p).replace(/\\\\/g, '/');
  if (abs.charAt(0) !== '/') abs = '/' + abs;
  return 'file://' + encodeURI(abs).replace(/#/g, '%23');
}
function applyBlurVar() {
  var px = (Number(blurSlider.value) / 100) * 9;
  var root = document.documentElement;
  root.style.setProperty('--bc-bg-blur', px.toFixed(2) + 'px');
  if (Number(blurSlider.value) > 0) root.dataset.bcBgBlur = 'true';
  else delete root.dataset.bcBgBlur;
}
function applyMediaUrl(url, kind) {
  clearMedia();
  if (currentUrl && currentUrl.indexOf('blob:') === 0) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  markMedia(kind);
  if (kind === 'video') {
    var v = media('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.src = url;
    markVideoReady(v);
    var pr = v.play();
    if (pr && pr.then) {
      // 静音先启动（muted autoplay 永远放行）；播放成功后若用户开了声音再取消静音
      pr.then(function () { if (muted === false) v.muted = false; })
        .catch(function () { msg('视频被自动播放策略拦了，点一下页面任意处再试。'); });
    }
    msg('已应用视频背景（' + (muted ? '静音' : '有声') + '）。');
  } else {
    media('img').src = url;
    msg('已应用图片背景。');
  }
}
function newThemeId() {
  return 'wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function rememberImportedTheme(name, path, kind) {
  var rows = themeRows();
  var theme = rows.find(function (t) { return t.path === path; });
  if (theme) {
    theme.name = name;
    theme.type = kind;
  } else {
    theme = { id: newThemeId(), name: name, path: path, type: kind };
    rows.push(theme);
  }
  PERSIST.themes = rows;
  PERSIST.activeThemeId = theme.id;
  syncThemesButton();
}
function applyBlob(file, themeName, realPath) {
  var kind = (/\\.(mp4|mov|webm|m4v)$/i.test(file.name) || /^video\\//.test(file.type)) ? 'video'
    : (/\\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name) || /^image\\//.test(file.type)) ? 'image' : null;
  if (!kind) { msg('不认识的格式：支持 png/jpg/webp/gif/bmp/avif 和 mp4/mov/webm/m4v。'); return; }
  var u = URL.createObjectURL(file);
  applyMediaUrl(u, kind);
  currentUrl = u;
  // 路径记忆：守护选择文件后会把真实路径放到 __bcPendingPickPath——媒体显示用
  // blob URL（100% 可靠），但状态记真实路径（blob 跨重启失效，重启后靠路径恢复）
  var real = String(realPath || window.__bcPendingPickPath || '');
  window.__bcPendingPickPath = '';
  if (real) {
    PERSIST.wallpaper = real;
    PERSIST.blob = false;
    rememberImportedTheme(String(themeName || suggestedThemeName(file)).trim(), real, kind);
  }
  else { PERSIST.blob = true; }
  PERSIST.cleared = false;
}

// 滑杆行为（对齐 DSH console.js：input 即时生效，0 = 自动）
// 阴影驱动 --bc-scrim-val（挂在 <html> 上，由带 !important 的主题感知蒙版规则消费；
// 之前驱动 --bc-dim 的规则被契约的 html:root 字面量规则压死——滑杆因此完全无效）
dimSlider.addEventListener('input', function () {
  var n = Number(dimSlider.value);
  if (!Number.isFinite(n)) return;
  // 线性语义（用户要求）：0% = 无蒙版（原版），往右单调加深；颜色跟主题（深黑/浅白）
  document.documentElement.style.setProperty('--bc-scrim-val', String(n / 100));
  dimValue.textContent = n + '%';
  PERSIST.dim = n;
});
blurSlider.addEventListener('input', function () {
  var n = Number(blurSlider.value);
  if (!Number.isFinite(n)) return;
  applyBlurVar();
  blurValue.textContent = n + '%';
  PERSIST.blur = n;
});
// 面板透明度：'input' 只更新标签；松手（change）挂请求，守护 ≤1.5s 内按新 α 重造
alphaSlider.addEventListener('input', function () {
  var n = Number(alphaSlider.value);
  if (!Number.isFinite(n)) return;
  // 语义：n = 透明度（越高越透）。浮层面的不透明率 = 100 - n，
  // 通过 CSS 变量实时驱动（生成 CSS 时 α 槽已变量化），拖动即生效、零重造。
  alphaValue.textContent = n + '%';
  document.documentElement.style.setProperty('--bc-surface-alpha-pct', (100 - n) + '%');
  PERSIST.alpha = n;
});

// ── 状态记忆：页面维护实时状态，守护轮询落地 state.json，启动时 __bcRestoreState 恢复 ──
// 挂在 window 上跨 payload 重装存活——否则 applyAll 每轮重装都会把状态打回
// nulls，watcher 会把 nulls 覆盖进 state.json（实测把已保存的壁纸冲掉的真凶）
window.__bcPersistStore = window.__bcPersistStore || { wallpaper: null, dim: null, blur: null, alpha: null, cleared: false, themes: [], activeThemeId: null };
var PERSIST = window.__bcPersistStore;
if (!Array.isArray(PERSIST.themes)) PERSIST.themes = [];
if (typeof PERSIST.activeThemeId !== 'string') PERSIST.activeThemeId = null;
syncThemesButton();
window.__bcPersistGet = function () { return JSON.stringify(PERSIST); };
function persistMark(wallpaper, themeId) {
  if (wallpaper === null) {
    PERSIST.cleared = true;
    PERSIST.wallpaper = null;
    PERSIST.activeThemeId = null;
  } else {
    PERSIST.cleared = false;
    PERSIST.wallpaper = wallpaper;
    var matched = themeRows().find(function (t) { return t.id === themeId || (!themeId && t.path === wallpaper); });
    PERSIST.activeThemeId = matched ? matched.id : null;
  }
}
window.__bcRestoreState = function (stRaw) {
  try {
    var st = typeof stRaw === 'string' ? JSON.parse(stRaw) : stRaw;
    var rawThemes = Array.isArray(st.themes) ? st.themes : [];
    var seenThemeIds = Object.create(null);
    PERSIST.themes = rawThemes.slice(0, 200).map(function (t, index) {
      if (!t || typeof t.path !== 'string' || !t.path) return null;
      var kind = t.type === 'video' || isVideo(t.path) ? 'video' : 'image';
      var id = typeof t.id === 'string' && t.id ? t.id : 'legacy-' + index + '-' + String(t.path).length;
      if (seenThemeIds[id]) id += '-' + index;
      seenThemeIds[id] = true;
      return {
        id: id,
        name: typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 80) : String(t.path).split(/[\\\\/]/).pop().replace(/\\.[^.]+$/, ''),
        path: t.path,
        type: kind,
      };
    }).filter(Boolean);
    PERSIST.activeThemeId = typeof st.activeThemeId === 'string' && PERSIST.themes.some(function (t) { return t.id === st.activeThemeId; })
      ? st.activeThemeId : null;
    if (!PERSIST.activeThemeId && st.wallpaper) {
      var activeByPath = PERSIST.themes.find(function (t) { return t.path === st.wallpaper; });
      if (activeByPath) PERSIST.activeThemeId = activeByPath.id;
    }
    syncThemesButton();
    if (!savedDialog.hidden) renderSavedThemes();
    var qs = function (sel) { return document.querySelector('#beauticode-workbuddy-bg-panel ' + sel); };
    // 「值相同不派发事件」是为了不给拖动中的滑杆添乱；但状态播种必须无条件做——
    // 否则当存档值恰好等于滑杆默认值时（如磨砂 0%），不派发事件 ⇒ PERSIST 该字段
    // 停在 null ⇒ 下一次写盘把它存成 null ⇒ 之后 st.blur != null 永假、再也恢复不了
    //（实测踩过：state.json 出现 "blur":null 而界面显示 0%）。
    var restoreSlider = function (sel, key) {
      if (st[key] == null) return;
      var el = qs(sel);
      if (!el) return;
      if (el.value !== String(st[key])) { el.value = String(st[key]); el.dispatchEvent(new Event('input')); }
      PERSIST[key] = Number(st[key]);
    };
    restoreSlider('.bc-dim-slider', 'dim');
    restoreSlider('.bc-blur-slider', 'blur');
    restoreSlider('.bc-alpha-slider', 'alpha');
    var hasMediaEl = (function () { var s2 = document.getElementById('beauticode-bg-stage'); return !!(s2 && s2.querySelector('img.bc-media,video.bc-media')); })();
    if (st.wallpaper && (st.wallpaper !== PERSIST.wallpaper || !hasMediaEl)) applyPath(st.wallpaper, PERSIST.activeThemeId);
    else if (!st.wallpaper && st.cleared) { clearMedia(); persistMark(null); }
  } catch (e) {}
};

// ── 弹窗开关（对齐用户名菜单：点击开合、点外部/Esc 关闭、从触发器上方弹出） ──
function openPop() {
  pop.style.display = 'block';
  var r = btn.getBoundingClientRect();
  var pw = pop.offsetWidth || 320, ph = pop.offsetHeight || 480;
  var x = Math.max(12, Math.min(r.left, innerWidth - pw - 12));
  var y = r.top - ph - 10;
  if (y < 12) y = Math.min(r.bottom + 10, innerHeight - ph - 12);
  pop.style.left = Math.round(x) + 'px';
  pop.style.top = Math.round(Math.max(12, y)) + 'px';
  btn.classList.add('conversation-list-tab-button--active');
  btn.setAttribute('aria-expanded', 'true');
}
function closePop() {
  pop.style.display = 'none';
  btn.classList.remove('conversation-list-tab-button--active');
  btn.setAttribute('aria-expanded', 'false');
}
btn.addEventListener('click', function (ev) {
  ev.preventDefault(); ev.stopPropagation();
  if (pop.style.display === 'block') closePop(); else openPop();
});
document.addEventListener('mousedown', function (ev) {
  if (pop.style.display !== 'block') return;
  if (pop.contains(ev.target) || btn.contains(ev.target)) return;
  closePop();
});
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape' && !nameDialog.hidden) { cancelThemeName(); return; }
  if (ev.key === 'Escape' && !savedDialog.hidden) { closeSavedThemes(); return; }
  if (ev.key === 'Escape' && !gal.hidden) { gal.hidden = true; return; }
  if (ev.key === 'Escape' && pop.style.display === 'block') closePop();
});

pop.addEventListener('click', function (ev) {
  var el = ev.target.closest('[data-act]');
  if (!el) return;
  var act = el.getAttribute('data-act');
  if (act === 'media') {
    window.__bcPickRequest = 1;
    msg('正在打开系统文件选择器…（由 beautiCode 守护接管）');
  }
  else if (act === 'sound') {
    muted = !muted;
    var v0 = stageEl().querySelector('video.bc-media'); if (v0) v0.muted = muted;
    soundBtn.textContent = muted ? '已关' : '已开';
    soundBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    msg(muted ? '声音已关。' : '声音已开（当前视频已同步）。');
  }
  else if (act === 'store') {
    galOpen();
  }
  else if (act === 'themes') {
    openSavedThemes();
  }
  else if (act === 'clear') {
    clearMedia();
    if (currentUrl && currentUrl.indexOf('blob:') === 0) { URL.revokeObjectURL(currentUrl); }
    currentUrl = null;
    persistMark(null);
    PERSIST.blob = false;
    msg('已清除背景。');
  }
});

// 守护回填入口：原生选择器选中的路径 / 守护侧主动应用
window.__bcApplyBackgroundPath = function (p) { try { applyPath(String(p)); } catch (e) {} };
// 安装完成即自愈：WorkBuddy 重挂侧栏会重建弹窗/舞台（回默认），这里主动从
// store 恢复一次——重装即恢复，不依赖守护轮询的时机（时机盲区实测卡死在默认）
try { if (PERSIST.wallpaper) window.__bcRestoreState(JSON.parse(JSON.stringify(PERSIST))); } catch (e) {}
window.__bcBackgroundMsg = function (t) { try { msg(String(t)); } catch (e) {} };
function applyPath(p, themeId) {
  if (isImage(p)) { applyMediaUrl(filePathToUrl(p), 'image'); persistMark(p, themeId); }
  else if (isVideo(p)) { applyMediaUrl(filePathToUrl(p), 'video'); persistMark(p, themeId); }
  else msg('不认识的扩展名：支持 png/jpg/webp/gif/bmp/avif 和 mp4/mov/webm/m4v。');
}
function isImage(p) { return /\\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(p); }
function isVideo(p) { return /\\.(mp4|mov|webm|m4v)$/i.test(p); }

document.documentElement.setAttribute('data-bc-workbuddy-bg', 'installed');
document.documentElement.setAttribute('data-bc-bg-ver', BUILD);
return 'ok';
})();
`;
})();

/**
 * 清理一行命令（任何控制台都能跑）：删除注入节点、解除守卫、卸掉 html 属性。
 */
export const BACKGROUND_BAR_CLEANUP: string =
  `(() => {
const root = document.querySelectorAll('[data-bc-injected="${BACKGROUND_BAR_STYLE_ID}"]');
root.forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
delete window.__bcBackgroundDemoInstalled;
delete window.__bcApplyBackgroundPath;
delete window.__bcBackgroundMsg;
delete window.__bcPickRequest;
delete window.__bcPendingPickPath;
document.documentElement.removeAttribute('data-bc-workbuddy-bg');
document.documentElement.removeAttribute('data-bc-active');
document.documentElement.removeAttribute('data-bc-media');
document.documentElement.removeAttribute('data-bc-video-ready');
document.documentElement.style.removeProperty('--bc-surface-alpha-pct');
return 'cleaned';
})();`;

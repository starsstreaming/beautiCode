(() => {
  "use strict";
  if (window.__beauticodeConsoleLoaded) return;
  window.__beauticodeConsoleLoaded = true;

  // Saved backgrounds are listed one category at a time, split by the media
  // kind the host already reports for each saved theme.
  const THEME_CATEGORIES = [
    { id: "image", label: "图片" },
    { id: "video", label: "视频" },
  ];
  let themeCategory = "image";
  let themeCategoryPinned = false;
  // One dialog has to offer both kinds, so the accept list carries both. Every
  // mainstream browser filters by it and still reports the picked file's own
  // name, which is what decides image vs video on the host.
  const MEDIA_ACCEPT =
    ".jpg,.jpeg,.png,.webp,.avif,.mp4,.mov," +
    "image/jpeg,image/png,image/webp,image/avif,video/mp4,video/quicktime";

  const style = document.createElement("style");
  style.dataset.beauticodeConsole = "true";
  style.textContent = `
#beauticode-console-page{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}
#beauticode-console-page[hidden],#beauticode-console-page [hidden]{display:none !important}
#beauticode-console-page *{box-sizing:border-box;font-family:inherit}
#beauticode-console-page .bc-page-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
#beauticode-console-page .bc-page-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
#beauticode-console-page .bc-group{display:flex;flex-direction:column}
#beauticode-console-page .bc-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
#beauticode-console-page .bc-row-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}
#beauticode-console-page .bc-row-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
#beauticode-console-page .bc-row-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
#beauticode-console-page .bc-control{display:inline-flex;flex:none;align-items:center;gap:8px}
#beauticode-console-page .bc-pill{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:72px;height:36px;padding:0 14px;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:400;line-height:22px}
#beauticode-console-page .bc-pill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
#beauticode-console-page .bc-pill.on::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}
#beauticode-console-page .bc-link{cursor:pointer;height:auto;padding:0;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;text-decoration:underline;text-underline-offset:3px}
#beauticode-console-page .bc-link:hover{color:var(--dsw-alias-label-primary)}
#beauticode-console-page .bc-slider{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:18px;background:var(--dsw-alias-bg-module-platform)}
#beauticode-console-page .bc-blur-slider{-webkit-appearance:none;appearance:none;width:120px;height:4px;margin:0;padding:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
#beauticode-console-page .bc-blur-slider::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--dsw-alias-border-l3)}
#beauticode-console-page .bc-blur-slider::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border:.5px solid var(--dsw-alias-border-l4);border-radius:50%;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv1);cursor:pointer}
#beauticode-console-page .bc-blur-value{min-width:2.6em;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right}
/* Both reset buttons share one appearance. bc-dim-reset used to be missing from
   this sheet entirely, so the shadow row rendered a raw UA button next to the
   styled blur row; keep the two selectors together so they cannot drift again. */
#beauticode-console-page .bc-dim-reset,#beauticode-console-page .bc-blur-reset{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-tertiary)}
#beauticode-console-page .bc-dim-reset:hover,#beauticode-console-page .bc-blur-reset:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
#beauticode-console-page .bc-dim-slider{-webkit-appearance:none;appearance:none;width:120px;height:4px;margin:0;padding:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
#beauticode-console-page .bc-dim-slider::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--dsw-alias-border-l3)}
#beauticode-console-page .bc-dim-slider::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border:.5px solid var(--dsw-alias-border-l4);border-radius:50%;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv1);cursor:pointer}
#beauticode-console-page .bc-dim-value{min-width:2.6em;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right}
/* Title and tabs. The tab row is the one Settings -> 插件 puts above its two
   pages: a hairline rule with the tabs on it, the active one in label-primary
   with a 2px underline. */
#beauticode-console-page .bc-theme-head{align-items:baseline;gap:7px;padding:0 2px;display:flex}
#beauticode-console-page .bc-theme-title{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:600;line-height:20px}
#beauticode-console-page .bc-theme-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}
#beauticode-console-page .bc-tabs{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:flex-end;gap:22px;margin-top:6px;display:flex}
#beauticode-console-page .bc-tab{color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;position:relative}
#beauticode-console-page .bc-tab:hover,#beauticode-console-page .bc-tab[data-active="true"]{color:var(--dsw-alias-label-primary)}
#beauticode-console-page .bc-tab[data-active="true"]:after{background:var(--dsw-alias-label-primary);content:"";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}
#beauticode-console-page .bc-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;color:var(--dsw-alias-label-primary);border-radius:2px}
#beauticode-console-page .bc-theme-panel{min-width:0;padding-top:2px}
/* Rows follow the model rows in Settings -> 模型: each saved background is a
   card wrapped in a rounded outline, the source reads as a bordered tag, and
   the background in use carries the same 8px green state dot those rows use. */
#beauticode-console-page .bc-theme-list{display:flex;flex-direction:column;gap:8px;max-height:280px;margin:12px 0 0;padding:0;overflow:auto;scrollbar-width:thin}
#beauticode-console-page .bc-theme-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:0 0;padding:12px 14px}
#beauticode-console-page .bc-theme-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
#beauticode-console-page .bc-theme-item{cursor:pointer;display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
#beauticode-console-page .bc-theme-item:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
#beauticode-console-page .bc-theme-name{min-width:0;font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#beauticode-console-page .bc-source{flex:none;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;padding:1px 6px;font-size:11px;line-height:16px}
#beauticode-console-page .bc-theme-dot{box-sizing:border-box;corner-shape:round;border-radius:50%;flex:none;display:inline-block;width:8px;height:8px;background:var(--dsw-alias-state-success-primary)}
#beauticode-console-page .bc-theme-del{cursor:pointer;flex:none;box-sizing:border-box;width:28px;height:28px;margin-left:auto;padding:0;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:15px;line-height:28px;text-align:center}
#beauticode-console-page .bc-theme-del:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
#beauticode-console-page .bc-theme-del:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
#beauticode-console-page .bc-btn:disabled,#beauticode-console-page .bc-tab:disabled,#beauticode-console-page .bc-theme-item:disabled,#beauticode-console-page .bc-theme-del:disabled{opacity:.38;cursor:default}
#beauticode-console-page .bc-msg{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
#beauticode-console-page[data-busy="true"] .bc-page-title::before{content:"";display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);animation:bc-pulse .9s steps(2,end) infinite}
@keyframes bc-pulse{50%{opacity:.25}}
#beauticode-console-file{position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none}
div[role="dialog"][aria-modal="true"] nav button[data-bc-nav="console"]{box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:8px;width:100%;height:40px;padding:9px 16px 9px 12px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:400;line-height:22px;text-align:left}
div[role="dialog"][aria-modal="true"] nav button[data-bc-nav="console"] svg{flex:none;display:block}
div[role="dialog"][aria-modal="true"] nav button[data-bc-nav="console"]:hover{background:var(--dsw-specific-sidebar-nav-item-hover,var(--dsw-alias-interactive-bg-hover))}
div[role="dialog"][aria-modal="true"] nav button[data-bc-nav="console"][aria-current="true"]{background:var(--dsw-specific-sidebar-nav-item-active,var(--dsw-alias-interactive-bg-hover))}
div[role="dialog"][aria-modal="true"][data-bc-page="on"] div[data-slot="settings.section"]{display:none !important}
div[role="dialog"][aria-modal="true"][data-bc-page="on"] nav button[aria-current="true"]:not([data-bc-nav]){background:transparent}
div[role="dialog"][aria-modal="true"][data-bc-page="on"] nav button[aria-current="true"]:not([data-bc-nav]):hover{background:var(--dsw-specific-sidebar-nav-item-hover,var(--dsw-alias-interactive-bg-hover))}
#beauticode-name-dialog{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:24px;background:var(--dsw-alias-bg-mask-1);font:inherit}
#beauticode-name-dialog .bc-name-card{display:flex;flex-direction:column;gap:10px;width:min(380px,calc(100vw - 48px));padding:20px;border:0;border-radius:20px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent)}
#beauticode-name-dialog .bc-name-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
#beauticode-name-dialog .bc-name-file,#beauticode-name-dialog .bc-name-note,#beauticode-name-dialog .bc-name-error{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
#beauticode-name-dialog .bc-name-error{color:var(--dsw-alias-state-error-primary)}
#beauticode-name-dialog input{height:38px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
#beauticode-name-dialog input:focus{outline:none;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2),0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 80%,transparent)}
#beauticode-name-dialog .bc-name-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
#beauticode-name-dialog button{cursor:pointer;height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
#beauticode-name-dialog button:hover{background:var(--dsw-alias-interactive-bg-hover)}
#beauticode-name-dialog button[data-name="confirm"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
#beauticode-name-dialog button[data-name="confirm"]:hover{background:var(--dsw-alias-button-primary-hover)}
`;
  document.head.append(style);

  // The settings dialog is React-rendered and owns its own active section, so we
  // cannot register a real settings page: beauticode-dsh ships no dsh.client
  // entry, and even with one the nav would still be React state. Instead we add
  // our own nav cell and our own section, then take over the visible area while
  // our cell is selected. See setPageActive() for the handoff.
  const navButton = document.createElement("button");
  navButton.type = "button";
  navButton.setAttribute("data-bc-nav", "console");
  navButton.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" stroke="currentColor" stroke-width="1.25"/>' +
    '<path d="M2.5 11.25 5.6 8.2a1 1 0 0 1 1.35 0L9.2 10.4l1.05-.95a1 1 0 0 1 1.3.04L13.5 11.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="5.25" cy="6.25" r="1" fill="currentColor"/>' +
    "</svg>" +
    "<span>背景</span>";

  const page = document.createElement("div");
  page.id = "beauticode-console-page";
  page.hidden = true;
  page.innerHTML =
    '<h2 class="bc-page-title">背景</h2>' +
    '<p class="bc-page-intro">给 DSH 换一张背景图或视频。</p>' +
    '<p class="bc-msg" role="status" aria-live="polite" hidden></p>' +
    '<div class="bc-group">' +
    '<div class="bc-row" data-row="fullscreen"><div class="bc-row-text">' +
    '<span class="bc-row-title">全屏显示</span>' +
    '<span class="bc-row-desc">隐藏浏览器标签页和地址栏，Esc 退出</span>' +
    "</div>" +
    '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-act="fullscreen" aria-pressed="false">进入全屏</button></div></div>' +
    '<div class="bc-row"><div class="bc-row-text">' +
    '<span class="bc-row-title">背景阴影</span>' +
    '<span class="bc-row-desc">压暗背景，让内容更清楚</span>' +
    "</div>" +
    '<div class="bc-control">' +
    '<span class="bc-slider">' +
    '<input type="range" class="bc-dim-slider" min="0" max="100" step="1" value="0" aria-label="背景阴影"/>' +
    '<span class="bc-dim-value">自动</span>' +
    "</span>" +
    '<button type="button" class="bc-dim-reset" data-act="dim-reset" aria-label="恢复默认" title="恢复默认">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M13.2 10.4A5.6 5.6 0 1 1 12.9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M13.9 1.7 13.2 5.2l-3.5-.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>" +
    "</button>" +
    "</div></div>" +
    '<div class="bc-row"><div class="bc-row-text">' +
    '<span class="bc-row-title">背景磨砂</span>' +
    '<span class="bc-row-desc">把背景画面磨砂化，界面不受影响</span>' +
    "</div>" +
    '<div class="bc-control">' +
    '<span class="bc-slider">' +
    '<input type="range" class="bc-blur-slider" min="0" max="100" step="1" value="0" aria-label="背景磨砂"/>' +
    '<span class="bc-blur-value">0%</span>' +
    "</span>" +
    '<button type="button" class="bc-blur-reset" data-act="blur-reset" aria-label="恢复默认" title="恢复默认">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M13.2 10.4A5.6 5.6 0 1 1 12.9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M13.9 1.7 13.2 5.2l-3.5-.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>" +
    "</button>" +
    "</div></div>" +
    '<div class="bc-row"><div class="bc-row-text">' +
    '<span class="bc-row-title">声音</span>' +
    '<span class="bc-row-desc">播放视频背景的声音</span>' +
    "</div>" +
    '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-act="sound" aria-pressed="false">已关</button></div></div>' +
    "</div>" +
    '<div class="bc-group">' +
    '<div class="bc-row"><div class="bc-row-text">' +
    '<span class="bc-row-title">导入背景</span>' +
    '<span class="bc-row-desc" data-desc="media">支持常见图片格式和 MP4 / MOV 视频</span>' +
    "</div>" +
    '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-act="media">选择文件</button></div></div>' +
    "</div>" +
    '<div class="bc-group bc-themes" hidden>' +
    '<div class="bc-theme-head">' +
    '<h3 class="bc-theme-title">已保存的背景</h3>' +
    '<span class="bc-theme-count"></span>' +
    "</div>" +
    '<div class="bc-tabs" role="tablist" aria-label="背景分类">' +
    '<button type="button" role="tab" class="bc-tab" data-category="image" data-active="true" aria-selected="true">图片</button>' +
    '<button type="button" role="tab" class="bc-tab" data-category="video" aria-selected="false">视频</button>' +
    "</div>" +
    '<div class="bc-theme-panel">' +
    '<div class="bc-theme-list"></div>' +
    '<p class="bc-empty" hidden></p>' +
    "</div>" +
    "</div>" +
    '<div class="bc-group">' +
    '<div class="bc-row"><div class="bc-row-text">' +
    '<span class="bc-row-title">打开皮肤中心</span>' +
    '<span class="bc-row-desc">浏览并一键应用在线皮肤</span>' +
    "</div>" +
    '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-act="gallery">打开</button></div></div>' +
    '<div class="bc-row"><div class="bc-row-text">' +
    '<span class="bc-row-title">清除背景</span>' +
    '<span class="bc-row-desc">恢复 DSH 默认外观</span>' +
    "</div>" +
    '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-act="clear">清除</button></div></div>' +
    "</div>";

  const fileInput = document.createElement("input");
  fileInput.id = "beauticode-console-file";
  fileInput.type = "file";
  fileInput.accept = MEDIA_ACCEPT;

  document.body.append(fileInput);

  const soundBtn = page.querySelector('[data-act="sound"]');
  const dimSlider = page.querySelector(".bc-dim-slider");
  const dimValue = page.querySelector(".bc-dim-value");
  const dimReset = page.querySelector('[data-act="dim-reset"]');
  const blurSlider = page.querySelector(".bc-blur-slider");
  const blurValue = page.querySelector(".bc-blur-value");
  const blurReset = page.querySelector('[data-act="blur-reset"]');
  const fullscreenRow = page.querySelector('[data-row="fullscreen"]');
  const fullscreenBtn = page.querySelector('[data-act="fullscreen"]');
  const themesBox = page.querySelector(".bc-themes");
  const themeList = page.querySelector(".bc-theme-list");
  const themeEmpty = page.querySelector(".bc-empty");
  const themeCount = page.querySelector(".bc-theme-count");
  const themeTabs = Array.from(page.querySelectorAll(".bc-tab"));
  const msgEl = page.querySelector(".bc-msg");
  const mediaBtn = page.querySelector('[data-act="media"]');
  const AUTO_DIM_PERCENT = 0;
  let busy = false;
  let muted = true;
  let currentThemeId = "";
  // /ui/status reports whether the host lets the browser upload a managed copy.
  // It is true on every non-Windows platform, where /ui/pick can only answer
  // native_picker_unavailable. Cached here so the import buttons can decide
  // synchronously, inside the user gesture. Stay unset until that payload
  // arrives: treating the default as "Windows" would send the first macOS /
  // Linux click through /ui/pick and lose the gesture again.
  let importPolicyReady = false;
  let managedUploadAllowed = false;
  let dialogEl = null;
  let pageActive = false;
  let lastStatus = null;

  // The shadow is always a real percentage: an untouched profile reads the same
  // 0% the stylesheet falls back to, so the slider, the label and the veil can
  // never disagree about which state the page is in.
  function renderDim() {
    const current = globalThis.BeauticodeBackgroundDim?.get?.() ?? null;
    const percent = current == null ? AUTO_DIM_PERCENT : Math.round(current * 100);
    dimSlider.value = String(percent);
    dimValue.textContent = `${percent}%`;
  }

  function isOurs(node) {
    for (let el = node; el; el = el.parentElement ?? null) {
      if (String(el.id || "").startsWith("beauticode-")) return true;
    }
    return false;
  }

  // React renders the settings dialog only while it is open, and its class names
  // are build-generated hashes. Identify it structurally instead. Fail closed:
  // if any part of the signature is missing we inject nothing rather than guess
  // a container and land in the wrong place.
  function findSettingsDialog() {
    for (const el of document.querySelectorAll('[aria-modal="true"]')) {
      if (el.getAttribute("role") !== "dialog") continue;
      if (isOurs(el)) continue;
      if (!el.querySelector("nav")) continue;
      const anchors = el.querySelectorAll('[data-slot="settings.section"]');
      if (!anchors.length || !anchors[anchors.length - 1].parentElement) continue;
      return el;
    }
    return null;
  }

  // Never build a selector from aria-labelledby: React useId values look like
  // ":r1:" and are not valid CSS identifiers, so querySelector would throw.
  function findNavList(dialog, nav) {
    const titleId = dialog.getAttribute("aria-labelledby") || "";
    let fallback = null;
    for (const child of nav.children) {
      if (titleId && child.id === titleId) continue;
      if (child.querySelector("button")) return child;
      if (!fallback) fallback = child;
    }
    return fallback;
  }

  function lastChild(node) {
    return node.children[node.children.length - 1] ?? null;
  }

  // Idempotent: re-parents our two nodes only when React has moved or dropped
  // them, and reads no layout. Runs after every mutation batch.
  function mount(dialog) {
    const nav = dialog.querySelector("nav");
    if (!nav) return false;
    const list = findNavList(dialog, nav);
    if (!list) return false;
    const anchors = dialog.querySelectorAll('[data-slot="settings.section"]');
    const anchor = anchors[anchors.length - 1];
    const options = anchor.parentElement;
    if (!options) return false;
    if (navButton.parentElement !== list || lastChild(list) !== navButton) {
      list.append(navButton);
    }
    if (page.parentElement !== options || page.previousElementSibling !== anchor) {
      options.insertBefore(page, anchor.nextElementSibling);
    }
    return true;
  }

  function setPageActive(active) {
    if (active === pageActive && page.hidden === !active) return;
    pageActive = active;
    page.hidden = !active;
    if (!dialogEl) return;
    if (!active) {
      dialogEl.removeAttribute("data-bc-page");
      navButton.removeAttribute("aria-current");
      return;
    }
    dialogEl.setAttribute("data-bc-page", "on");
    navButton.setAttribute("aria-current", "true");
    renderDim();
  renderBlur();
    void refresh();
    const options = page.parentElement;
    if (options) options.scrollTop = 0;
  }

  function teardown() {
    if (dialogEl) dialogEl.removeEventListener?.("click", onDialogClick, true);
    dialogEl = null;
    pageActive = false;
    page.hidden = true;
    navButton.removeAttribute("aria-current");
    navButton.remove();
    page.remove();
  }

  // React changes its active section only from a nav-cell click, and buttons fire
  // click for keyboard activation too, so a capture-phase listener on the dialog
  // is a complete reverse switch — and it runs before React re-renders.

  // Mirrors renderDim(): the slider is the single source of truth and the value
  // label always shows the percentage that is actually applied.
  function renderBlur() {
    const current = globalThis.BeauticodeBackgroundBlur?.get?.() ?? 0;
    const percent = Math.round(current);
    if (blurSlider.value !== String(percent)) blurSlider.value = String(percent);
    const label = `${percent}%`;
    if (blurValue.textContent !== label) blurValue.textContent = label;
  }

  function onDialogClick(event) {
    if (!pageActive || !dialogEl) return;
    const nav = dialogEl.querySelector("nav");
    if (!nav || !nav.contains(event.target)) return;
    if (navButton.contains(event.target)) return;
    setPageActive(false);
  }

  function sync() {
    const found = findSettingsDialog();
    if (!found) {
      if (dialogEl) teardown();
      return;
    }
    if (found !== dialogEl) {
      // Closing and reopening settings mounts a brand-new dialog: reset to the
      // React page rather than restoring our section on a node React replaced.
      teardown();
      dialogEl = found;
      dialogEl.addEventListener("click", onDialogClick, true);
      void refresh();
    }
    if (!mount(dialogEl)) return;
    if (pageActive) {
      dialogEl.setAttribute("data-bc-page", "on");
      navButton.setAttribute("aria-current", "true");
      page.hidden = false;
    }
  }

  function showMessage(text) {
    if (!text) {
      msgEl.hidden = true;
      msgEl.textContent = "";
      return;
    }
    msgEl.hidden = false;
    msgEl.textContent = text;
  }

  function syncImportControls() {
    const locked = busy || !importPolicyReady;
    mediaBtn.disabled = locked;
  }

  function renderStatus(data) {
    lastStatus = data;
    if (!data?.ok) {
      if (data?.error) showMessage(data.error);
      syncImportControls();
      return;
    }
    if (typeof data?.importPolicy?.managedUploadAllowed === "boolean") {
      importPolicyReady = true;
      managedUploadAllowed = data.importPolicy.managedUploadAllowed === true;
    }
    syncImportControls();
    if (typeof data.themeId === "string" && data.themeId) {
      currentThemeId = data.themeId;
    } else if (data.atmosphere === "gallery") {
      currentThemeId = "builtin-gallery";
    } else {
      currentThemeId = "";
    }
    muted = data.muted !== false;
    soundBtn.classList.toggle("on", !muted);
    soundBtn.textContent = muted ? "已关" : "已开";
    soundBtn.setAttribute("aria-pressed", muted ? "false" : "true");
    const themes = Array.isArray(data.themes) ? data.themes : [];
    if (themes.length === 0) {
      themesBox.hidden = true;
      themeList.innerHTML = "";
      themeCount.textContent = "";
      return;
    }
    themesBox.hidden = false;
    // Follow the background in use until the user picks a category themselves,
    // so the list never opens on a category that hides the active entry.
    const active = themes.find((theme) => theme.id === currentThemeId);
    if (!themeCategoryPinned && active) themeCategory = categoryOfTheme(active);
    const visible = themes.filter((theme) => categoryOfTheme(theme) === themeCategory);
    themeList.innerHTML = visible
      .map((theme) => {
        const del =
          theme.bundled === true
            ? ""
            : `<button type="button" class="bc-theme-del" data-theme-delete="${escapeAttr(theme.id)}" data-theme-name="${escapeAttr(theme.name)}" aria-label="删除 ${escapeAttr(theme.name)}">×</button>`;
        const source =
          theme.sourceMode === "local" ? "本地" : theme.bundled ? "内置" : "托管";
        const selected = theme.id === currentThemeId;
        const current = selected ? ' aria-current="true"' : "";
        // The one in use is marked the way a configured model is marked: a
        // small green dot right after the name and its tag, nothing else.
        const dot = selected
          ? '<span class="bc-theme-dot" role="img" aria-label="当前使用" title="当前使用"></span>'
          : "";
        return `<div class="bc-theme-row"><button type="button" class="bc-theme-item" data-theme-id="${escapeAttr(theme.id)}"${current}><span class="bc-theme-name">${escapeText(theme.name)}</span><span class="bc-source">${source}</span>${dot}</button>${del}</div>`;
      })
      .join("");
    themeCount.textContent = String(visible.length);
    for (const tab of themeTabs) {
      const on = tab.dataset.category === themeCategory;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      if (on) tab.setAttribute("data-active", "true");
      else tab.removeAttribute("data-active");
    }
    themeEmpty.textContent = `还没有保存的${categoryLabelOf(themeCategory)}背景。`;
    themeEmpty.hidden = visible.length > 0;
  }

  function categoryOfTheme(theme) {
    return theme?.type === "video" ? "video" : "image";
  }

  function categoryLabelOf(id) {
    return THEME_CATEGORIES.find((category) => category.id === id)?.label ?? "图片";
  }

  function escapeText(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function escapeAttr(value) {
    return escapeText(value).replaceAll('"', "&quot;");
  }

  async function request(path, init, options = {}) {
    const timeoutMs = options.timeoutMs === 0 ? 0 : options.timeoutMs || 45_000;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(new Error("background_request_timeout")), timeoutMs)
      : null;
    try {
      const response = await fetch(path, {
        ...init,
        ...(controller ? { signal: controller.signal } : {}),
        headers: {
          ...(init?.headers || {}),
        },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok === false) {
        const error = new Error(body?.error || `请求失败（${response.status}）`);
        error.status = response.status;
        error.code = body?.code || "";
        throw error;
      }
      return body;
    } catch (error) {
      if (controller?.signal.aborted) {
        // The browser only cancels its own fetch; a slow backend transaction
        // (managed-video copy or verify) may still commit afterwards. Don't
        // claim the previous background was preserved — report honestly.
        throw new Error(
          "背景操作超时，控件已恢复。操作可能仍在后台进行，请先查看当前背景状态再重试。",
        );
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function refresh() {
    try {
      renderStatus(await request("/__beauticode/ui/status"));
    } catch (error) {
      renderStatus({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function run(task) {
    if (busy) return;
    busy = true;
    page.dataset.busy = "true";
    let afterRun = null;
    for (const button of page.querySelectorAll(".bc-btn, .bc-theme-item, .bc-theme-del, .bc-tab")) button.disabled = true;
    showMessage("正在处理，请稍候…");
    try {
      const result = await task();
      if (typeof result?.afterRun === "function") afterRun = result.afterRun;
      if (result?.theme?.id) currentThemeId = result.theme.id;
      if (result?.message) {
        const source =
          result.sourceMode === "local"
            ? "本地引用，未复制主媒体"
            : result.sourceMode === "managed"
              ? "托管副本"
              : "";
        const totalMs = Number(result.importTimings?.applyAndSaveMs ?? result.timings?.totalMs);
        const duration = Number.isFinite(totalMs) ? `${Math.round(totalMs)} ms` : "";
        showMessage([result.message, source, duration].filter(Boolean).join(" · "));
      } else {
        showMessage("");
      }
      await refresh();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      delete page.dataset.busy;
      for (const button of page.querySelectorAll(".bc-btn, .bc-theme-item, .bc-theme-del, .bc-tab")) button.disabled = false;
      syncImportControls();
    }
    if (afterRun) queueMicrotask(afterRun);
  }

  function validateThemeName(value) {
    const name = String(value || "").trim();
    if (!name) return "主题名不能为空。";
    if (name.length > 80) return "主题名不能超过 80 个字符。";
    if (/[<>:"/\\|?*]/.test(name) || ![...name].every((ch) => ch.codePointAt(0) > 31)) {
      return '主题名不能包含 < > : " / \\ | ? * 或控制字符。';
    }
    return "";
  }

  function defaultThemeName(fileName) {
    const suggested = String(fileName || "")
      .replace(/\.[^.]+$/, "")
      .trim()
      .slice(0, 80);
    return suggested || "新主题";
  }

  function askThemeName(fileName, suggestedName, options = {}) {
    return new Promise((resolve) => {
      const dialog = document.createElement("div");
      dialog.id = "beauticode-name-dialog";
      dialog.innerHTML =
        '<div class="bc-name-card" role="dialog" aria-modal="true" aria-labelledby="beauticode-name-title">' +
        '<p id="beauticode-name-title" class="bc-name-title">给主题取个名字</p>' +
        `<p class="bc-name-file">${escapeText(fileName)}</p>` +
        (options.compatibilityUpload
          ? '<p class="bc-name-note">原生选择器不可用，兼容模式会复制媒体文件。</p>'
          : "") +
        `<input type="text" maxlength="80" aria-label="主题名称" value="${escapeAttr(suggestedName || defaultThemeName(fileName))}"/>` +
        '<p class="bc-name-error" hidden></p>' +
        '<div class="bc-name-actions"><button type="button" data-name="cancel">取消</button><button type="button" data-name="confirm">保存并应用</button></div>' +
        "</div>";
      document.body.append(dialog);
      const input = dialog.querySelector('input[aria-label="主题名称"]');
      const errorEl = dialog.querySelector(".bc-name-error");
      let closed = false;

      const close = (value) => {
        if (closed) return;
        closed = true;
        dialog.remove();
        resolve(value);
      };
      const confirm = () => {
        const error = validateThemeName(input.value);
        if (error) {
          errorEl.hidden = false;
          errorEl.textContent = error;
          input.focus();
          return;
        }
        close(input.value.trim());
      };
      dialog.querySelector('[data-name="confirm"]').addEventListener("click", confirm);
      dialog.querySelector('[data-name="cancel"]').addEventListener("click", () => close(null));
      input.addEventListener("input", () => {
        errorEl.hidden = true;
        errorEl.textContent = "";
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") confirm();
        if (event.key === "Escape") close(null);
      });
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) close(null);
      });
      input.focus();
      input.select();
    });
  }

  async function pickAndImport() {
    let picked;
    try {
      picked = await request(
        "/__beauticode/ui/pick",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "media" }),
        },
        // The user controls how long the native dialog stays open. Import and
        // theme switching still use the bounded request timeout above.
        { timeoutMs: 0 },
      );
    } catch (error) {
      if (error?.code !== "native_picker_unavailable") throw error;
      return {
        ok: true,
        afterRun: () => {
          fileInput.dataset.compatibilityUpload = "true";
          fileInput.click();
        },
      };
    }
    if (picked.cancelled) return { ok: true };
    const themeName = await askThemeName(
      picked.name,
      picked.suggestedThemeName,
    );
    if (!themeName) return { ok: true };
    return request("/__beauticode/ui/import-selected", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectionId: picked.selectionId, themeName }),
    });
  }

  // "Fullscreen" here means hiding the browser's own chrome — tab strip, address
  // bar, toolbar — so the page reads as a standalone app instead of a tab. The
  // Fullscreen API is the only thing a page is allowed to call for that, and
  // browsers only honour the request from inside a user gesture, so the call has
  // to stay synchronous in the click handler for exactly the reason the file
  // picker above does. Esc always exits, which is why the button label is only
  // a convenience: we re-read the real state instead of tracking our own.
  const FULLSCREEN_ENTER = ["requestFullscreen", "webkitRequestFullscreen"];
  const FULLSCREEN_EXIT = ["exitFullscreen", "webkitExitFullscreen"];
  function callFullscreen(owner, names) {
    for (const name of names) {
      const fn = owner?.[name];
      if (typeof fn !== "function") continue;
      try {
        return Promise.resolve(fn.call(owner));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return null;
  }
  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function renderFullscreen() {
    const supported = FULLSCREEN_ENTER.some(
      (name) => typeof document.documentElement?.[name] === "function",
    );
    // Nothing to offer on a browser without the API, so drop the row rather
    // than leave a button that would do nothing.
    fullscreenRow.hidden = !supported;
    if (!supported) return;
    const on = fullscreenElement() != null;
    fullscreenBtn.textContent = on ? "退出全屏" : "进入全屏";
    fullscreenBtn.classList.toggle("on", on);
    fullscreenBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function toggleFullscreen() {
    const on = fullscreenElement() != null;
    const pending = callFullscreen(
      on ? document : document.documentElement,
      on ? FULLSCREEN_EXIT : FULLSCREEN_ENTER,
    );
    if (!pending) {
      showMessage("当前浏览器不支持全屏显示。");
      return;
    }
    pending.then(renderFullscreen, (error) => {
      showMessage(error instanceof Error ? error.message : String(error));
    });
  }

  navButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!pageActive) setPageActive(true);
  });
  // Safari (and WebKit generally) only opens a file picker when input.click()
  // runs synchronously inside the user-gesture handler, and refuses to open one
  // for an input hidden with display:none. On platforms that allow a managed
  // upload, open the picker right here rather than asking /ui/pick first: that
  // round trip pushed the click past the gesture, so the picker never appeared.
  function startImport() {
    if (!importPolicyReady) {
      showMessage("正在确认导入方式，请稍候再试。");
      return;
    }
    if (!managedUploadAllowed) {
      void run(() => pickAndImport());
      return;
    }
    fileInput.dataset.compatibilityUpload = "true";
    fileInput.click();
  }
  mediaBtn.addEventListener("click", () => {
    startImport();
  });
  syncImportControls();
  page.querySelector('[data-act="gallery"]').addEventListener("click", () => {
    // No setPageActive(false): the gallery is a fixed overlay above the dialog.
    if (window.BeauticodeGallery) {
      window.BeauticodeGallery.open().catch((error) => {
        showMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    showMessage("皮肤中心脚本尚未加载。");
  });
  page.querySelector('[data-act="clear"]').addEventListener("click", () => {
    void run(async () => {
      const result = await request("/__beauticode/ui/clear", { method: "POST" });
      currentThemeId = "";
      return result;
    });
  });
  soundBtn.addEventListener("click", () => {
    void run(() =>
      request("/__beauticode/ui/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ muted: !muted }),
      }),
    );
  });
  dimSlider.addEventListener("input", () => {
    const n = Number(dimSlider.value);
    if (!Number.isFinite(n)) return;
    globalThis.BeauticodeBackgroundDim?.set?.(n / 100);
    renderDim();
  });
  dimReset.addEventListener("click", (event) => {
    event.stopPropagation();
    // Write the value the row means by "default" instead of dropping back to a
    // separate auto state the slider cannot show.
    globalThis.BeauticodeBackgroundDim?.set?.(AUTO_DIM_PERCENT / 100);
    renderDim();
  });
  blurSlider.addEventListener("input", (event) => {
    event.stopPropagation();
    const n = Number(blurSlider.value);
    if (!Number.isFinite(n)) return;
    globalThis.BeauticodeBackgroundBlur?.set?.(n);
    renderBlur();
  });
  blurReset.addEventListener("click", (event) => {
    event.stopPropagation();
    globalThis.BeauticodeBackgroundBlur?.set?.(0);
    renderBlur();
  });
  renderDim();
  fullscreenBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFullscreen();
  });
  // Esc leaves fullscreen without going through our button, so the label is
  // driven by the browser's state rather than by what we last asked for.
  document.addEventListener("fullscreenchange", renderFullscreen);
  document.addEventListener("webkitfullscreenchange", renderFullscreen);
  renderFullscreen();
  // Tabs, with the arrow-key movement a tablist is expected to have.
  function selectThemeCategory(next) {
    themeCategory = next === "video" ? "video" : "image";
    themeCategoryPinned = true;
    if (lastStatus) renderStatus(lastStatus);
  }
  for (const tab of themeTabs) {
    tab.addEventListener("click", (event) => {
      event.stopPropagation();
      selectThemeCategory(tab.dataset.category);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = themeTabs.indexOf(tab);
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = themeTabs[(index + step + themeTabs.length) % themeTabs.length];
      selectThemeCategory(next.dataset.category);
      next.focus?.();
    });
  }
  themeList.addEventListener("click", (event) => {
    const del = event.target.closest("[data-theme-delete]");
    if (del) {
      event.stopPropagation();
      const id = del.getAttribute("data-theme-delete") || "";
      const name = del.getAttribute("data-theme-name") || "主题";
      if (!id) return;
      if (!window.confirm(`确定删除主题「${name}」？`)) return;
      void run(async () => {
        const result = await request("/__beauticode/ui/theme/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (currentThemeId === id) currentThemeId = "";
        return result;
      });
      return;
    }
    const item = event.target.closest("[data-theme-id]");
    if (!item) return;
    const targetThemeId = item.getAttribute("data-theme-id") || "";
    void run(async () => {
      const result = await request("/__beauticode/ui/theme/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: targetThemeId }),
      });
      currentThemeId = targetThemeId;
      globalThis.BeauticodeAtmosphere?.setWindowMode?.(
        currentThemeId === "builtin-gallery" ? "on" : "closed",
      );
      return result;
    });
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    const compatibilityUpload = fileInput.dataset.compatibilityUpload === "true";
    fileInput.value = "";
    delete fileInput.dataset.compatibilityUpload;
    if (!file) return;
    void run(async () => {
      const themeName = await askThemeName(file.name, defaultThemeName(file.name), {
        compatibilityUpload,
      });
      if (!themeName) return { ok: true };
      return request("/__beauticode/ui/import", {
        method: "POST",
        headers: {
          "x-beauticode-filename": encodeURIComponent(file.name),
          "x-beauticode-theme-name": encodeURIComponent(themeName),
        },
        body: file,
      });
    });
  });
  document.addEventListener("beauticode-gallery-installed", () => {
    void refresh();
  });

  let syncQueued = false;
  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      sync();
    });
  }
  new MutationObserver(scheduleSync).observe(document.documentElement, { childList: true, subtree: true });
  // Drift safety net: one query per second, no layout reads.
  setInterval(sync, 1000);
  sync();
})();

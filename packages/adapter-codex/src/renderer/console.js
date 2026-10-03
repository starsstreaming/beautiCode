(() => {
  "use strict";
  const CONSOLE_REV = 12;
  if (window.__beauticodeConsoleRev === CONSOLE_REV && window.__beauticodeConsoleLoaded) {
    try {
      window.__beauticodeConsolePlace?.();
    } catch {
      /* ignore */
    }
    return;
  }
  // Release the superseded instance before mounting this one: its observer, its
  // 500ms place() and its document listeners otherwise survive, and two consoles
  // then insert their hosts into the same rail slot in turn — an insert ping-pong
  // through their childList observers that wedges the Codex renderer (field: a hot
  // upgrade hung the window twice before this hook existed).
  try {
    window.__beauticodeConsoleDispose?.();
  } catch {
    /* ignore */
  }
  let disposed = false;
  window.__beauticodeConsoleLoaded = true;
  window.__beauticodeConsoleRev = CONSOLE_REV;
  window.__beauticodeGalleryLoaded = false;
  try {
    document.getElementById("beauticode-name-dialog")?.remove();
  } catch {
    /* ignore */
  }

  const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,.avif,image/jpeg,image/png,image/webp,image/avif";
  const VIDEO_ACCEPT = ".mp4,.mov,video/mp4,video/quicktime";

  // Reuse the existing shell rather than replacing it: an instance from a build
  // without __beauticodeConsoleDispose keeps driving the node it mounted, so that
  // node has to stay exactly where it is.
  const style = document.querySelector('style[data-beauticode-console="true"]') ??
    document.createElement("style");
  style.dataset.beauticodeConsole = "true";
  style.textContent = `
#beauticode-console{display:block;width:100%}
#beauticode-console .bc-trigger{cursor:pointer;width:100%;height:34px;margin:2px 0;padding:6px 10px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:22px;align-items:center;gap:8px;display:flex;overflow:hidden}
#beauticode-console .bc-trigger:hover{background:rgba(255,255,255,.06)}
#beauticode-console.rail .bc-trigger{width:36px;height:36px;margin:8px 0 10px;padding:0;border-radius:50%;justify-content:center;gap:0}
#beauticode-console.rail .bc-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
#beauticode-console .bc-icon{flex:none;display:block}
#beauticode-console .bc-label{white-space:nowrap;overflow:hidden}
#beauticode-console-pop{position:fixed;z-index:2000;box-sizing:border-box;width:256px;padding:0 14px 12px;border:1px solid rgba(23,26,29,.24);border-top:4px solid #252a30;border-radius:2px;background:#ece9e2;color:#202327;box-shadow:0 16px 36px rgba(0,0,0,.34);font:inherit;font-size:13px}
#beauticode-console-pop *{box-sizing:border-box;font-family:inherit}
body:not([data-ds-dark-theme]) #beauticode-console-pop{background:#f3f0e9;color:#202327;border-color:rgba(23,26,29,.22)}
#beauticode-console-pop .bc-head{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;padding:12px 0 10px;border-bottom:1px solid #b9b6af}
#beauticode-console-pop .bc-title{margin:0;font:650 16px/20px Georgia,"Songti SC","STSong",serif;letter-spacing:.02em}
#beauticode-console-pop .bc-status{min-width:0;max-width:142px;color:#686d71;font:10px/15px ui-monospace,"Cascadia Mono",monospace;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#beauticode-console-pop .bc-import{cursor:pointer;display:grid;grid-template-columns:34px minmax(0,1fr) 18px;align-items:center;width:100%;min-height:49px;padding:0;border:0;border-bottom:1px solid #c8c5be;background:transparent;color:inherit;text-align:left}
#beauticode-console-pop .bc-import:hover{background:rgba(32,35,39,.05)}
#beauticode-console-pop .bc-index{color:#74787b;font:10px ui-monospace,"Cascadia Mono",monospace}
#beauticode-console-pop .bc-import-copy{min-width:0}
#beauticode-console-pop .bc-import strong{display:block;font-size:13px;line-height:17px;font-weight:650}
#beauticode-console-pop .bc-import small{display:block;color:#717579;font-size:10px;line-height:14px}
#beauticode-console-pop .bc-arrow{font-size:16px;text-align:right}
#beauticode-console-pop .bc-controls{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #c8c5be}
#beauticode-console-pop .bc-dim{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 0;border-bottom:1px solid #c8c5be}
#beauticode-console-pop .bc-dim-label{color:#686d71;font:10px ui-monospace,"Cascadia Mono",monospace}
#beauticode-console-pop .bc-dim-slider{-webkit-appearance:none;appearance:none;flex:1;min-width:72px;height:4px;margin:0;padding:0;background:#c8c5be;border-radius:0}
#beauticode-console-pop .bc-dim-slider::-webkit-slider-runnable-track{height:4px;background:#c8c5be;border-radius:0}
#beauticode-console-pop .bc-dim-slider::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;margin-top:-3px;background:#252a30;border:0;border-radius:0;cursor:pointer}
#beauticode-console-pop .bc-dim-value{min-width:2.6em;color:#686d71;font:10px/15px ui-monospace,"Cascadia Mono",monospace;text-align:right}
#beauticode-console-pop .bc-link{cursor:pointer;height:auto;padding:0;border:0;background:transparent;color:#595e62;font-size:11px;line-height:18px;text-decoration:underline;text-underline-offset:3px}
#beauticode-console-pop .bc-link:hover{color:#171a1d}
#beauticode-console-pop .bc-theme-toggle{cursor:pointer;display:flex;align-items:center;justify-content:space-between;width:100%;height:31px;padding:8px 0 4px;border:0;background:transparent;color:#686d71;font:10px ui-monospace,"Cascadia Mono",monospace;letter-spacing:.08em;text-align:left}
#beauticode-console-pop .bc-theme-list{max-height:150px;overflow:auto;scrollbar-width:thin}
#beauticode-console-pop .bc-theme-row{display:flex;align-items:center;min-width:0;border-bottom:1px dotted #bbb8b1}
#beauticode-console-pop .bc-theme-row:last-child{border-bottom:0}
#beauticode-console-pop .bc-theme-item{cursor:pointer;display:flex;align-items:center;flex:1;min-width:0;height:31px;padding:0;border:0;background:transparent;color:inherit;font-size:12px;line-height:31px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#beauticode-console-pop .bc-theme-item::before{content:"";flex:none;width:16px;font-size:9px}
#beauticode-console-pop .bc-theme-item[aria-current="true"]{font-weight:650}
#beauticode-console-pop .bc-theme-item[aria-current="true"]::before{content:"●"}
#beauticode-console-pop .bc-theme-item:hover{background:rgba(32,35,39,.05)}
#beauticode-console-pop .bc-source{margin-left:auto;padding-left:6px;color:#777b7e;font:9px ui-monospace,"Cascadia Mono",monospace}
#beauticode-console-pop .bc-theme-del{cursor:pointer;flex:none;width:22px;height:28px;padding:0;border:0;background:transparent;color:#777b7e;font-size:15px;line-height:28px;opacity:.66}
#beauticode-console-pop .bc-theme-del:hover{color:#802f2f;opacity:1}
#beauticode-console-pop .bc-btn:disabled,#beauticode-console-pop .bc-theme-toggle:disabled,#beauticode-console-pop .bc-theme-item:disabled,#beauticode-console-pop .bc-theme-del:disabled{opacity:.38;cursor:default}
#beauticode-console-pop[data-busy="true"] .bc-head::before{content:"";width:5px;height:5px;margin:0 0 6px;background:#6d7f8c;animation:bc-pulse .9s steps(2,end) infinite}
#beauticode-console-pop .bc-msg{margin:9px 0 0;color:#656a6e;font-size:11px;line-height:16px;max-height:3.2em;overflow:hidden}
@keyframes bc-pulse{50%{opacity:.25}}
#beauticode-console-file{display:none !important}
#beauticode-name-dialog{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.42);font:inherit}
#beauticode-name-dialog .bc-name-card{display:flex;flex-direction:column;gap:10px;width:min(380px,calc(100vw - 48px));padding:20px;border:1px solid #aaa69e;border-top:4px solid #252a30;border-radius:2px;background:#ece9e2;color:#202327;box-shadow:0 18px 60px rgba(0,0,0,.35)}
#beauticode-name-dialog .bc-name-title{margin:0;font:650 17px Georgia,"Songti SC","STSong",serif}
#beauticode-name-dialog .bc-name-file,#beauticode-name-dialog .bc-name-note,#beauticode-name-dialog .bc-name-error{margin:0;color:#666b6f;font-size:12px;line-height:18px;overflow-wrap:anywhere}
#beauticode-name-dialog .bc-name-error{color:#8d3030}
#beauticode-name-dialog input{height:38px;padding:0 10px;border:1px solid #a8a49c;border-radius:0;background:#f7f4ed;color:inherit;font:inherit;font-size:13px}
#beauticode-name-dialog .bc-name-actions{display:flex;justify-content:flex-end;gap:8px}
#beauticode-name-dialog button{cursor:pointer;height:34px;padding:0 13px;border:1px solid #8d8a84;border-radius:0;background:transparent;color:inherit;font:inherit}
#beauticode-name-dialog button[data-name="confirm"]{background:#252a30;border-color:#252a30;color:#f7f4ed}
`;
  document.head.append(style);

  // Adopt the mounted shell when present so an older, non-disposable instance
  // cannot re-insert a second console underneath this one.
  const host = document.getElementById("beauticode-console") ?? document.createElement("div");
  host.id = "beauticode-console";
  host.innerHTML =
    '<button type="button" class="bc-trigger" aria-expanded="false" aria-controls="beauticode-console-pop">' +
    '<svg class="bc-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" stroke="currentColor" stroke-width="1.25"/>' +
    '<path d="M2.5 11.25 5.6 8.2a1 1 0 0 1 1.35 0L9.2 10.4l1.05-.95a1 1 0 0 1 1.3.04L13.5 11.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="5.25" cy="6.25" r="1" fill="currentColor"/>' +
    "</svg>" +
    '<span class="bc-label">背景</span></button>';

  const pop = document.getElementById("beauticode-console-pop") ?? document.createElement("div");
  pop.id = "beauticode-console-pop";
  pop.setAttribute("data-bc-ui", "true");
  pop.hidden = true;
  pop.innerHTML =
    '<header class="bc-head"><h2 class="bc-title">背景清单</h2><span class="bc-status">未就绪</span></header>' +
    '<button type="button" class="bc-btn bc-import" data-act="image"><span class="bc-index">01</span><span class="bc-import-copy"><strong>导入图片</strong><small>直接引用本地文件</small></span><span class="bc-arrow">→</span></button>' +
    '<button type="button" class="bc-btn bc-import" data-act="video"><span class="bc-index">02</span><span class="bc-import-copy"><strong>导入视频</strong><small>MP4 / MOV · 零复制播放</small></span><span class="bc-arrow">→</span></button>' +
    '<div class="bc-controls">' +
    '<button type="button" class="bc-btn bc-link" data-act="sound">声音已关</button>' +
    '<button type="button" class="bc-btn bc-link" data-act="clear">清除背景</button>' +
    '<button type="button" class="bc-btn bc-link" data-act="gallery">打开皮肤中心</button>' +
    "</div>" +
    '<div class="bc-dim">' +
    '<span class="bc-dim-label">阴影</span>' +
    '<input type="range" class="bc-dim-slider" min="0" max="100" step="1" value="42" aria-label="背景亮度"/>' +
    '<span class="bc-dim-value">自动</span>' +
    '<button type="button" class="bc-btn bc-link" data-act="dim-reset" hidden>恢复默认</button>' +
    "</div>" +
    '<div class="bc-dim">' +
    '<span class="bc-dim-label">模糊</span>' +
    '<input type="range" class="bc-dim-slider bc-blur-slider" min="0" max="100" step="1" value="0" aria-label="背景模糊"/>' +
    '<span class="bc-dim-value bc-blur-value">关</span>' +
    '<button type="button" class="bc-btn bc-link" data-act="blur-reset" hidden>恢复默认</button>' +
    "</div>" +
    '<div class="bc-themes" hidden>' +
    '<button type="button" class="bc-theme-toggle" aria-expanded="true"><span>SAVED / 00</span><span>−</span></button>' +
    '<div class="bc-theme-list" hidden></div>' +
    "</div>" +
    '<p class="bc-msg" hidden></p>';

  const fileInput = document.getElementById("beauticode-console-file") ??
    document.createElement("input");
  fileInput.id = "beauticode-console-file";
  fileInput.type = "file";

  // append() on a node that already sits in body is a no-op away from the end.
  if (!host.isConnected) document.body.append(pop, fileInput);

  const trigger = host.querySelector(".bc-trigger");
  const statusEl = pop.querySelector(".bc-status");
  const soundBtn = pop.querySelector('[data-act="sound"]');
  const dimSlider = pop.querySelector(".bc-dim-slider");
  const dimValue = pop.querySelector(".bc-dim-value");
  const dimLabel = pop.querySelector(".bc-dim-label");
  const dimReset = pop.querySelector('[data-act="dim-reset"]');
  const blurSlider = pop.querySelector(".bc-blur-slider");
  const blurValue = pop.querySelector(".bc-blur-value");
  const blurReset = pop.querySelector('[data-act="blur-reset"]');
  const themesBox = pop.querySelector(".bc-themes");
  const themeToggle = pop.querySelector(".bc-theme-toggle");
  const themeList = pop.querySelector(".bc-theme-list");
  const msgEl = pop.querySelector(".bc-msg");
  // Thumb position while the row reads 自动 — must match the renderer's shipped
  // default (background.css --bc-scrim-val fallback).
  const AUTO_DIM_PERCENT = 48;
  let busy = false;
  let muted = true;
  let currentThemeId = "";
  let themesExpanded = true;

  const DIM_STORAGE_KEY = "beauticode-dim";
  let userDim = null;

  function clampDim(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) return null;
    return n;
  }

  function readStoredDim() {
    try {
      const raw = globalThis.localStorage?.getItem(DIM_STORAGE_KEY);
      if (raw == null || raw === "") return null;
      return clampDim(raw);
    } catch {
      return null;
    }
  }

  function writeStoredDim(value) {
    try {
      if (value == null) globalThis.localStorage?.removeItem(DIM_STORAGE_KEY);
      else globalThis.localStorage?.setItem(DIM_STORAGE_KEY, String(value));
    } catch {
      /* private mode / quota */
    }
  }

  function applyUserDim(value) {
    const root = document.documentElement;
    if (value == null) {
      try {
        root.removeAttribute("data-bc-dim-user");
        root.style?.removeProperty?.("--bc-dim");
      } catch {
        /* ignore */
      }
      return null;
    }
    try {
      root.setAttribute("data-bc-dim-user", "true");
      root.style?.setProperty?.("--bc-dim", String(value));
    } catch {
      /* ignore */
    }
    return value;
  }

  function setUserDim(value) {
    const next = clampDim(value);
    if (next == null) return userDim;
    userDim = next;
    writeStoredDim(next);
    applyUserDim(next);
    return next;
  }

  function clearUserDim() {
    userDim = null;
    writeStoredDim(null);
    applyUserDim(null);
    return null;
  }

  userDim = readStoredDim();
  if (userDim != null) applyUserDim(userDim);
  globalThis.BeauticodeBackgroundDim = {
    get: () => userDim,
    set: setUserDim,
    clear: clearUserDim,
  };

  function renderDim() {
    const current = globalThis.BeauticodeBackgroundDim?.get?.() ?? null;
    if (current == null) {
      dimSlider.value = String(AUTO_DIM_PERCENT);
      dimValue.textContent = "自动";
      dimReset.hidden = true;
      return;
    }
    const percent = Math.round(current * 100);
    dimSlider.value = String(percent);
    dimValue.textContent = `${percent}%`;
    dimReset.hidden = false;
  }

  // Media blur is page-local and page-owned, persisted for the next injection.
  // The brightness row (shadow in a dark host, veil in a light one) is what keeps
  // light-mode text readable.
  const BLUR_STORAGE_KEY = "beauticode-bg-blur";
  const BLUR_MAX_PX = 9;
  // place() runs for every childList mutation in a very large page, so bound how
  // often it may re-insert the host: two actors moving it in turn (a stale
  // instance, or the host framework re-rendering the rail) would otherwise
  // ping-pong forever.
  const PLACE_INSERT_WINDOW_MS = 2000;
  const PLACE_MAX_INSERTS = 5;
  let insertWindowAt = 0;
  let insertCount = 0;
  let userBlur = null;

  function clampPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) return null;
    return n;
  }

  function readStoredPercent(key) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      if (raw == null || raw === "") return null;
      return clampPercent(raw);
    } catch {
      return null;
    }
  }

  function writeStoredPercent(key, value) {
    try {
      if (value == null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, String(value));
    } catch {
      /* private mode / quota */
    }
  }

  // Writing identical text still replaces the text node, which wakes the page's
  // childList observer and its forced layout.
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  // Mirrors the CSS tone selector: any light marker wins, so the row label can
  // never describe the opposite of what the stylesheet paints.
  function isLightTone() {
    const el = document.documentElement;
    if (
      el.getAttribute("data-bc-resolved-tone") === "light" ||
      el.getAttribute("data-theme") === "light" ||
      el.classList?.contains?.("light")
    ) {
      return true;
    }
    const body = document.body;
    return (
      body?.getAttribute("data-theme") === "light" ||
      Boolean(body?.classList?.contains?.("light"))
    );
  }

  function applyUserBlur(value) {
    const root = document.documentElement;
    if (value == null) {
      try {
        root.removeAttribute("data-bc-blur-user");
        root.style?.removeProperty?.("--bc-bg-blur");
      } catch {
        /* ignore */
      }
      return null;
    }
    try {
      // Blur bleeds at the edges; the attribute grows the media box to cover it.
      if (value > 0) {
        root.setAttribute("data-bc-blur-user", "true");
        root.style?.setProperty?.("--bc-bg-blur", `${(value * BLUR_MAX_PX).toFixed(2)}px`);
      } else {
        root.removeAttribute("data-bc-blur-user");
        root.style?.removeProperty?.("--bc-bg-blur");
      }
    } catch {
      /* ignore */
    }
    return value;
  }

  function setUserBlur(value) {
    const next = clampPercent(value);
    if (next == null) return userBlur;
    userBlur = next;
    writeStoredPercent(BLUR_STORAGE_KEY, next);
    applyUserBlur(next);
    return next;
  }

  function clearUserBlur() {
    userBlur = null;
    writeStoredPercent(BLUR_STORAGE_KEY, null);
    applyUserBlur(null);
    return null;
  }

  userBlur = readStoredPercent(BLUR_STORAGE_KEY);
  if (userBlur != null) applyUserBlur(userBlur);
  globalThis.BeauticodeBackgroundBlur = {
    get: () => userBlur,
    set: setUserBlur,
    clear: clearUserBlur,
  };

  function renderBlur() {
    const current = globalThis.BeauticodeBackgroundBlur?.get?.() ?? null;
    const percent = current == null ? 0 : Math.round(current * 100);
    blurSlider.value = String(percent);
    setText(blurValue, percent > 0 ? `${percent}%` : "关");
    blurReset.hidden = current == null;
    // The shadow row paints a white veil in a light host: same slider, and the
    // label has to describe the direction the picture actually moves.
    setText(dimLabel, isLightTone() ? "亮度" : "阴影");
  }

  function findExploreRow() {
    const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
    const candidates = nodes.filter((node) => {
      if (host.contains(node) || pop.contains(node)) return false;
      const text = String(node.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      return text === "探索" || text === "Explore";
    });
    // The updated Codex rail has an icon-only Explore button with sr-only
    // text. Do not mount after an equally named action in the content pane.
    return candidates.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 &&
        rect.left < 120 && (rect.width <= 120 || node.classList.contains("sidebar-item"));
    }) || null;
  }

  function placePop() {
    const rect = trigger.getBoundingClientRect();
    if (!rect.width) return;
    pop.style.left = `${Math.round(rect.left)}px`;
    pop.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`;
  }

  function isContents(node) {
    if (!node) return false;
    if (node.style?.display === "contents") return true;
    if (typeof getComputedStyle === "function") {
      try {
        return getComputedStyle(node).display === "contents";
      } catch {
        return false;
      }
    }
    return false;
  }

  function layoutParent(node) {
    let current = node?.parentElement ?? null;
    while (current && isContents(current)) current = current.parentElement;
    return current;
  }

  function place() {
    // A superseded instance must not keep moving the host it mounted.
    if (disposed) return;
    const now = Date.now();
    const explore = findExploreRow();
    if (!explore) {
      if (host.parentElement) host.remove();
      return;
    }
    let row = explore;
    const wrapper = explore.parentElement;
    if (
      wrapper &&
      wrapper.children.length === 1 &&
      !isContents(wrapper)
    ) {
      row = wrapper;
    }
    const list = layoutParent(row);
    if (!list) {
      if (host.parentElement) host.remove();
      return;
    }
    if (host.parentElement !== list || host.previousElementSibling !== row) {
      if (now - insertWindowAt > PLACE_INSERT_WINDOW_MS) {
        insertWindowAt = now;
        insertCount = 0;
      }
      if (insertCount >= PLACE_MAX_INSERTS) return;
      insertCount += 1;
      const after = row.nextElementSibling;
      if (after) list.insertBefore(host, after);
      else list.append(host);
    }
    host.classList.toggle("rail", row.getBoundingClientRect().width <= 56);
    // The rail's muted icon tone belongs to the host theme, including light
    // mode. Sample the adjacent native item so its hover/theme state follows.
    const nativeColor = getComputedStyle(explore).color;
    if (nativeColor && trigger.style.color !== nativeColor) trigger.style.color = nativeColor;
    if (!pop.hidden) placePop();
  }

  function setOpen(open) {
    pop.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      placePop();
      // Host appearance can flip while the pop is closed; sampling it on open
      // keeps a closed pop free of observers on a very large tree.
      renderBlur();
      void refresh();
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

  function renderStatus(data) {
    if (!data?.ok) {
      statusEl.textContent = data?.error || "未就绪";
      return;
    }
    const label =
      data.atmosphere === "gallery"
        ? "画窗"
        : data.media === "video"
          ? "视频"
          : data.media === "image"
            ? "图片"
            : "无背景";
    const sourceLabel =
      data.sourceMode === "local"
        ? "本地引用"
        : data.sourceMode === "managed"
          ? "托管副本"
          : "";
    if (typeof data.themeId === "string" && data.themeId) {
      currentThemeId = data.themeId;
    } else if (data.atmosphere === "gallery") {
      currentThemeId = "builtin-gallery";
    } else {
      currentThemeId = "";
    }
    muted = data.muted !== false;
    soundBtn.classList.toggle("on", !muted);
    soundBtn.textContent = muted ? "声音已关" : "声音已开";
    const themes = Array.isArray(data.themes) ? data.themes : [];
    const selected = themes.find((theme) => theme.id === currentThemeId);
    const currentLabel = selected?.name || label;
    const compactSource = sourceLabel === "本地引用" ? "本地" : sourceLabel === "托管副本" ? "托管" : "已应用";
    statusEl.textContent = `${currentLabel} / ${compactSource}`;
    if (themes.length === 0) {
      themesBox.hidden = true;
      themeList.innerHTML = "";
      themeList.hidden = true;
      themeToggle.setAttribute("aria-expanded", "false");
      return;
    }
    themesBox.hidden = false;
    themeList.innerHTML = themes
      .map((theme) => {
        const del =
          theme.bundled === true
            ? ""
            : `<button type="button" class="bc-theme-del" data-theme-delete="${escapeAttr(theme.id)}" data-theme-name="${escapeAttr(theme.name)}" aria-label="删除 ${escapeAttr(theme.name)}">×</button>`;
        const source =
          theme.sourceMode === "local" ? "本地" : theme.bundled ? "内置" : "托管";
        const current = theme.id === currentThemeId ? ' aria-current="true"' : "";
        return `<div class="bc-theme-row"><button type="button" class="bc-theme-item" data-theme-id="${escapeAttr(theme.id)}"${current}><span>${escapeText(theme.name)}</span><span class="bc-source">${source}</span></button>${del}</div>`;
      })
      .join("");
    themeToggle.innerHTML = `<span>SAVED / ${String(themes.length).padStart(2, "0")}</span><span>${themesExpanded ? "−" : "+"}</span>`;
    themeList.hidden = !themesExpanded;
    themeToggle.setAttribute("aria-expanded", themesExpanded ? "true" : "false");
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

  const pending = (window.__beauticodeBridgePending ||= new Map());
  window.__beauticodeBridgeResult = function (id, ok, payload) {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (ok) waiter.resolve(payload);
    else {
      const error = new Error(payload?.error || "请求失败");
      error.code = payload?.code || "";
      waiter.reject(error);
    }
  };

  async function request(path, init, options = {}) {
    if (typeof window.beauticodeConsole !== "function") {
      throw new Error("未发现注入CDP的Codex进程");
    }
    if (init?.body && typeof init.body !== "string") {
      throw new Error("Codex 需要使用系统文件选择器导入本地文件。");
    }
    const timeoutMs = options.timeoutMs === 0 ? 0 : options.timeoutMs || 45_000;
    let body = null;
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(
                new Error(
                  "背景操作超时，控件已恢复。操作可能仍在后台进行，请先查看当前背景状态再重试。",
                ),
              );
            }, timeoutMs)
          : null;
      pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      try {
        window.beauticodeConsole(
          JSON.stringify({
            id,
            path,
            method: init?.method || "GET",
            body,
          }),
        );
      } catch (error) {
        if (timer) clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).then((payload) => {
      if (payload?.ok === false) {
        const error = new Error(payload.error || "请求失败");
        error.code = payload.code || "";
        throw error;
      }
      return payload;
    });
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
    pop.dataset.busy = "true";
    let afterRun = null;
    for (const button of pop.querySelectorAll(".bc-btn, .bc-theme-toggle, .bc-theme-item, .bc-theme-del")) button.disabled = true;
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
      delete pop.dataset.busy;
      for (const button of pop.querySelectorAll(".bc-btn, .bc-theme-toggle, .bc-theme-item, .bc-theme-del")) button.disabled = false;
    }
    if (afterRun) queueMicrotask(afterRun);
  }

  function validateThemeName(value) {
    const name = String(value || "").trim();
    if (!name) return "主题名不能为空。";
    if (name.length > 80) return "主题名不能超过 80 个字符。";
    if (/[<>:"/\\|?*]/.test(name) || /[\u0000-\u001f]/.test(name)) {
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
      dialog.setAttribute("data-bc-ui", "true");
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

  async function pickAndImport(kind) {
    let picked;
    try {
      picked = await request(
        "/__beauticode/ui/pick",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind }),
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
          fileInput.accept = kind === "video" ? VIDEO_ACCEPT : IMAGE_ACCEPT;
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

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(pop.hidden);
  });
  pop.querySelector('[data-act="image"]').addEventListener("click", () => {
    void run(() => pickAndImport("image"));
  });
  pop.querySelector('[data-act="video"]').addEventListener("click", () => {
    void run(() => pickAndImport("video"));
  });
  pop.querySelector('[data-act="gallery"]').addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(false);
    if (window.BeauticodeGallery) {
      window.BeauticodeGallery.open().catch((error) => {
        showMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    showMessage("皮肤中心脚本尚未加载。");
  });
  pop.querySelector('[data-act="clear"]').addEventListener("click", () => {
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
    globalThis.BeauticodeBackgroundDim?.clear?.();
    renderDim();
  });
  renderDim();
  blurSlider.addEventListener("input", () => {
    const n = Number(blurSlider.value);
    if (!Number.isFinite(n)) return;
    globalThis.BeauticodeBackgroundBlur?.set?.(n / 100);
    renderBlur();
  });
  blurReset.addEventListener("click", (event) => {
    event.stopPropagation();
    globalThis.BeauticodeBackgroundBlur?.clear?.();
    renderBlur();
  });
  renderBlur();
  themeToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    themesExpanded = !themesExpanded;
    themeList.hidden = !themesExpanded;
    themeToggle.querySelector("span:last-child").textContent = themesExpanded ? "−" : "+";
    themeToggle.setAttribute("aria-expanded", themesExpanded ? "true" : "false");
  });
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
    themeList.hidden = true;
    themeToggle.setAttribute("aria-expanded", "false");
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

  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
  document.addEventListener("beauticode-gallery-installed", onGalleryInstalled);

  function onDocumentClick(event) {
    if (disposed || pop.hidden) return;
    if (pop.contains(event.target) || trigger.contains(event.target)) return;
    setOpen(false);
  }
  function onDocumentKeydown(event) {
    if (disposed) return;
    if (event.key === "Escape" && !pop.hidden) setOpen(false);
  }
  function onGalleryInstalled() {
    if (disposed) return;
    void refresh();
  }

  const observer = new MutationObserver(() => place());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", place);
  const placeTimer = setInterval(place, 500);
  window.__beauticodeConsolePlace = place;

  // A superseded instance must stop observing, re-placing and swallowing events.
  // Instances from an older build have no disposer; adopting their DOM above
  // keeps their place() a no-op so they cannot fight this one for the slot.
  window.__beauticodeConsoleDispose = () => {
    disposed = true;
    try {
      observer.disconnect();
      clearInterval(placeTimer);
      window.removeEventListener("resize", place);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeydown);
      document.removeEventListener("beauticode-gallery-installed", onGalleryInstalled);
      host.remove();
      pop.remove();
      style.remove();
      if (window.__beauticodeConsolePlace === place) delete window.__beauticodeConsolePlace;
      delete window.__beauticodeConsoleDispose;
    } catch {
      /* ignore */
    }
  };

  place();
})();

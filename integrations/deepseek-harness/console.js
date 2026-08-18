(() => {
  "use strict";
  if (window.__beauticodeConsoleLoaded) return;
  window.__beauticodeConsoleLoaded = true;

  const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,.avif,image/jpeg,image/png,image/webp,image/avif";
  const VIDEO_ACCEPT = ".mp4,video/mp4";

  const style = document.createElement("style");
  style.dataset.beauticodeConsole = "true";
  style.textContent = `
#beauticode-console{display:contents}
#beauticode-console .bc-trigger{cursor:pointer;width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:none;border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:22px;align-items:center;gap:8px;display:flex;overflow:hidden}
#beauticode-console .bc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
#beauticode-console.rail .bc-trigger{width:36px;height:36px;margin:8px 0 10px;padding:0;border-radius:50%;justify-content:center;gap:0}
#beauticode-console.rail .bc-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
#beauticode-console .bc-icon{flex:none;display:block}
#beauticode-console .bc-label{white-space:nowrap;overflow:hidden}
#beauticode-console-pop{position:fixed;z-index:2000;box-sizing:border-box;width:220px;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:#2c323c;color:#e8eaed;box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.28));font:inherit;font-size:13px}
#beauticode-console-pop *{box-sizing:border-box;font-family:inherit}
body:not([data-ds-dark-theme]) #beauticode-console-pop{background:#fff;color:#1b1f24;border-color:rgba(0,0,0,.08)}
#beauticode-console-pop .bc-status{color:var(--dsw-alias-label-secondary,#9aa3ad);font-size:12px;line-height:18px;margin:0 0 8px}
#beauticode-console-pop .bc-row{display:flex;gap:6px;margin:0 0 6px}
#beauticode-console-pop .bc-btn,#beauticode-console-pop .bc-theme-toggle{cursor:pointer;flex:1;min-width:0;height:32px;padding:0 8px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.06);color:inherit;font-size:13px;line-height:20px}
body:not([data-ds-dark-theme]) #beauticode-console-pop .bc-btn,
body:not([data-ds-dark-theme]) #beauticode-console-pop .bc-theme-toggle{border-color:rgba(0,0,0,.08);background:#f4f6f8}
#beauticode-console-pop .bc-btn:hover,#beauticode-console-pop .bc-theme-toggle:hover{background:rgba(255,255,255,.12)}
body:not([data-ds-dark-theme]) #beauticode-console-pop .bc-btn:hover,
body:not([data-ds-dark-theme]) #beauticode-console-pop .bc-theme-toggle:hover{background:#eceff3}
#beauticode-console-pop .bc-btn:disabled,#beauticode-console-pop .bc-theme-toggle:disabled,#beauticode-console-pop .bc-theme-item:disabled{opacity:.45;cursor:default}
#beauticode-console-pop .bc-btn.on{background:rgba(255,255,255,.16)}
#beauticode-console-pop .bc-theme-toggle{width:100%;text-align:left}
#beauticode-console-pop .bc-theme-list{margin:6px 0 0;max-height:160px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:#232830;padding:4px}
body:not([data-ds-dark-theme]) #beauticode-console-pop .bc-theme-list{border-color:rgba(0,0,0,.08);background:#f4f6f8}
#beauticode-console-pop .bc-theme-item{cursor:pointer;display:block;width:100%;height:32px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:inherit;font-size:13px;line-height:32px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#beauticode-console-pop .bc-theme-item:hover{background:rgba(255,255,255,.08)}
body:not([data-ds-dark-theme]) #beauticode-console-pop .bc-theme-item:hover{background:rgba(0,0,0,.06)}
#beauticode-console-pop .bc-msg{color:var(--dsw-alias-label-secondary,#9aa3ad);font-size:12px;line-height:16px;margin:6px 0 0;max-height:3.2em;overflow:hidden}
#beauticode-console-file{display:none !important}
`;
  document.head.append(style);

  const host = document.createElement("div");
  host.id = "beauticode-console";
  host.innerHTML =
    '<button type="button" class="bc-trigger" aria-expanded="false" aria-controls="beauticode-console-pop">' +
    '<svg class="bc-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" stroke="currentColor" stroke-width="1.25"/>' +
    '<path d="M2.5 11.25 5.6 8.2a1 1 0 0 1 1.35 0L9.2 10.4l1.05-.95a1 1 0 0 1 1.3.04L13.5 11.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="5.25" cy="6.25" r="1" fill="currentColor"/>' +
    "</svg>" +
    '<span class="bc-label">背景</span></button>';

  const pop = document.createElement("div");
  pop.id = "beauticode-console-pop";
  pop.hidden = true;
  pop.innerHTML =
    '<p class="bc-status">未就绪</p>' +
    '<div class="bc-row">' +
    '<button type="button" class="bc-btn" data-act="image">图片</button>' +
    '<button type="button" class="bc-btn" data-act="video">视频</button>' +
    "</div>" +
    '<div class="bc-row">' +
    '<button type="button" class="bc-btn" data-act="clear">清除</button>' +
    '<button type="button" class="bc-btn" data-act="sound">声音</button>' +
    "</div>" +
    '<div class="bc-themes" hidden>' +
    '<button type="button" class="bc-theme-toggle" aria-expanded="false">已保存主题</button>' +
    '<div class="bc-theme-list" hidden></div>' +
    "</div>" +
    '<p class="bc-msg" hidden></p>';

  const fileInput = document.createElement("input");
  fileInput.id = "beauticode-console-file";
  fileInput.type = "file";

  document.body.append(pop, fileInput);

  const trigger = host.querySelector(".bc-trigger");
  const statusEl = pop.querySelector(".bc-status");
  const soundBtn = pop.querySelector('[data-act="sound"]');
  const themesBox = pop.querySelector(".bc-themes");
  const themeToggle = pop.querySelector(".bc-theme-toggle");
  const themeList = pop.querySelector(".bc-theme-list");
  const msgEl = pop.querySelector(".bc-msg");
  let busy = false;
  let muted = true;
  let currentThemeId = "";

  function findSettingsTrigger() {
    const buttons = [...document.querySelectorAll('button[aria-haspopup="dialog"]')];
    const candidates = buttons.filter((button) => {
      if (host.contains(button) || pop.contains(button)) return false;
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left < 320 && rect.bottom > window.innerHeight * 0.35;
    });
    candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return candidates[0] || null;
  }

  function placePop() {
    const rect = trigger.getBoundingClientRect();
    if (!rect.width) return;
    pop.style.left = `${Math.round(rect.left)}px`;
    pop.style.bottom = `${Math.round(window.innerHeight - rect.top + 8)}px`;
  }

  function place() {
    const settings = findSettingsTrigger();
    if (!settings || !settings.parentElement) {
      if (host.parentElement) host.remove();
      return;
    }
    if (host.parentElement !== settings.parentElement || host.nextElementSibling !== settings) {
      settings.parentElement.insertBefore(host, settings);
    }
    host.classList.toggle("rail", settings.getBoundingClientRect().width <= 40);
    if (!pop.hidden) placePop();
  }

  function setOpen(open) {
    pop.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      placePop();
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
    const label = data.media === "video" ? "视频" : data.media === "image" ? "图片" : "无背景";
    statusEl.textContent = label;
    muted = data.muted !== false;
    soundBtn.classList.toggle("on", !muted);
    soundBtn.textContent = muted ? "声音" : "声音开";
    const themes = Array.isArray(data.themes) ? data.themes : [];
    if (themes.length === 0) {
      themesBox.hidden = true;
      themeList.innerHTML = "";
      themeList.hidden = true;
      themeToggle.setAttribute("aria-expanded", "false");
      return;
    }
    themesBox.hidden = false;
    themeList.innerHTML = themes
      .map(
        (theme) =>
          `<button type="button" class="bc-theme-item" data-theme-id="${escapeAttr(theme.id)}">${escapeText(theme.name)}</button>`,
      )
      .join("");
    const selected = themes.find((theme) => theme.id === currentThemeId);
    themeToggle.textContent = selected ? selected.name : "已保存主题";
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

  async function request(path, init) {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.headers || {}),
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error || `请求失败（${response.status}）`);
    }
    return body;
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
    for (const button of pop.querySelectorAll(".bc-btn, .bc-theme-toggle, .bc-theme-item")) button.disabled = true;
    showMessage("");
    try {
      const result = await task();
      if (result?.message) showMessage(result.message);
      await refresh();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      for (const button of pop.querySelectorAll(".bc-btn, .bc-theme-toggle, .bc-theme-item")) button.disabled = false;
    }
  }

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(pop.hidden);
  });
  pop.querySelector('[data-act="image"]').addEventListener("click", () => {
    fileInput.accept = IMAGE_ACCEPT;
    fileInput.click();
  });
  pop.querySelector('[data-act="video"]').addEventListener("click", () => {
    fileInput.accept = VIDEO_ACCEPT;
    fileInput.click();
  });
  pop.querySelector('[data-act="clear"]').addEventListener("click", () => {
    void run(() => request("/__beauticode/ui/clear", { method: "POST" }));
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
  themeToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = themeList.hidden;
    themeList.hidden = !open;
    themeToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  themeList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-theme-id]");
    if (!item) return;
    currentThemeId = item.getAttribute("data-theme-id") || "";
    themeList.hidden = true;
    themeToggle.setAttribute("aria-expanded", "false");
    void run(() =>
      request("/__beauticode/ui/theme/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: currentThemeId }),
      }),
    );
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    void run(() =>
      request("/__beauticode/ui/import", {
        method: "POST",
        headers: { "x-beauticode-filename": encodeURIComponent(file.name) },
        body: file,
      }),
    );
  });

  document.addEventListener("click", (event) => {
    if (pop.hidden) return;
    if (pop.contains(event.target) || trigger.contains(event.target)) return;
    setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pop.hidden) setOpen(false);
  });

  const observer = new MutationObserver(() => place());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", place);
  setInterval(place, 500);
  place();
})();

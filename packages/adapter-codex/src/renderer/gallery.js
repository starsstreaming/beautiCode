(() => {
  "use strict";
  if (window.__beauticodeGalleryLoaded) return;
  window.__beauticodeGalleryLoaded = true;

  // Reuse the mounted overlay when present: replacing it would drop the node an
  // older console instance still tracks.
  const style = document.querySelector('style[data-beauticode-gallery="true"]') ??
    document.createElement("style");
  style.dataset.beauticodeGallery = "true";
  style.textContent = `
#beauticode-gallery{position:fixed;inset:0;z-index:4000;display:flex;align-items:center;justify-content:center;background:rgba(11,13,18,.62);pointer-events:auto}
#beauticode-gallery[hidden]{display:none}
#beauticode-gallery .bcg-panel{width:min(880px,calc(100vw - 32px));height:min(640px,calc(100vh - 32px));display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:#2c323c;color:#e8eaed;overflow:hidden}
#beauticode-gallery .bcg-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
#beauticode-gallery .bcg-head h2{margin:0;font-size:15px;font-weight:600}
#beauticode-gallery .bcg-head input,#beauticode-gallery .bcg-head select{height:32px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.06);color:inherit;padding:0 8px}
#beauticode-gallery .bcg-grid{flex:1;overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;align-content:start}
#beauticode-gallery .bcg-card{display:flex;flex-direction:column;justify-content:flex-end;min-height:120px;border:none;padding:12px;border-radius:12px;background:#232830;color:inherit;text-align:left;cursor:pointer}
#beauticode-gallery .bcg-card span{display:block;font-size:13px}
#beauticode-gallery .bcg-msg,#beauticode-gallery .bcg-foot{padding:0 14px 12px;color:#9aa3ad;font-size:12px}
#beauticode-gallery .bcg-close{margin-left:auto}
#beauticode-gallery .bcg-btn{height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.06);color:inherit;cursor:pointer}
  `;
  document.head.append(style);

  const mounted = document.getElementById("beauticode-gallery");
  const host = mounted ?? document.createElement("div");
  host.id = "beauticode-gallery";
  // Marks the subtree as beautiCode's own UI: the renderer's readable-surface
  // rule must not repaint it (this panel keeps its own dark palette).
  host.setAttribute("data-bc-ui", "true");
  if (!mounted) host.hidden = true;
  host.innerHTML =
    '<div class="bcg-panel" role="dialog" aria-modal="true" aria-labelledby="bcg-title">' +
    '<div class="bcg-head">' +
    '<h2 id="bcg-title">皮肤中心</h2>' +
    '<input class="bcg-q" placeholder="搜索" />' +
    '<select class="bcg-type"><option value="">全部</option><option value="image">图片</option><option value="video">视频</option></select>' +
    '<button type="button" class="bcg-btn bcg-close">关闭</button>' +
    "</div>" +
    '<div class="bcg-grid"></div>' +
    '<p class="bcg-msg"></p>' +
    '<p class="bcg-foot"></p>' +
    "</div>";
  if (!mounted) document.body.append(host);

  const grid = host.querySelector(".bcg-grid");
  const msg = host.querySelector(".bcg-msg");
  const foot = host.querySelector(".bcg-foot");
  const queryInput = host.querySelector(".bcg-q");
  const typeSelect = host.querySelector(".bcg-type");
  const SKIN_ID = /^skin-[a-z0-9]{8,40}$/;
  let centerUrl = "";
  let busy = false;

  function escapeText(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function escapeAttr(value) {
    return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  async function request(path, init, timeoutMs) {
    if (typeof window.beauticodeConsole !== "function") {
      throw new Error("未发现注入CDP的Codex进程");
    }
    const id = crypto.randomUUID();
    const pending = (window.__beauticodeBridgePending ||= new Map());
    let body = null;
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    const payload = await new Promise((resolve, reject) => {
      const timer =
        timeoutMs === 0
          ? null
          : setTimeout(() => {
              pending.delete(id);
              reject(new Error("皮肤中心请求超时。"));
            }, timeoutMs || 45_000);
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
    });
    if (payload?.ok === false) {
      throw new Error(payload.error || "请求失败");
    }
    return payload;
  }

  async function load() {
    msg.textContent = "正在读取目录…";
    try {
      const params = new URLSearchParams();
      if (queryInput.value.trim()) params.set("q", queryInput.value.trim());
      if (typeSelect.value) params.set("type", typeSelect.value);
      const data = await request(`/__beauticode/ui/gallery/catalog?${params}`);
      centerUrl = data.url || centerUrl;
      grid.innerHTML = (data.skins || [])
        .filter((skin) => SKIN_ID.test(String(skin.id ?? "")))
        .map(
          (skin) =>
            `<button type="button" class="bcg-card" data-id="${escapeAttr(skin.id)}">` +
            `<span>${escapeText(skin.name)}${skin.type === "video" ? " · 视频" : ""}</span></button>`,
        )
        .join("");
      msg.textContent = data.skins?.length ? "" : "目录是空的。";
      foot.textContent = centerUrl
        ? `来源 ${centerUrl}。安装会下载到本机后再应用。`
        : "未配置皮肤中心地址。";
    } catch (error) {
      grid.innerHTML = "";
      msg.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async function open() {
    host.hidden = false;
    const config = await request("/__beauticode/ui/gallery/config");
    centerUrl = config.url || "";
    if (!config.enabled) {
      grid.innerHTML = "";
      msg.textContent = "尚未配置皮肤中心地址。";
      foot.textContent = "设置 BEAUTICODE_SKIN_CENTER 后重试。";
      return;
    }
    await load();
  }

  function close() {
    host.hidden = true;
  }

  host.querySelector(".bcg-close").addEventListener("click", close);
  host.addEventListener("click", (event) => {
    if (event.target === host) close();
  });
  queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void load();
    }
  });
  typeSelect.addEventListener("change", () => void load());
  grid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-id]");
    if (!card || busy) return;
    const id = card.getAttribute("data-id");
    busy = true;
    msg.textContent = "开始安装…";
    request(
      "/__beauticode/ui/gallery/install",
      {
        method: "POST",
        body: JSON.stringify({ id }),
      },
      0,
    )
      .then((result) => {
        msg.textContent = result.message || "已安装。";
        document.dispatchEvent(new CustomEvent("beauticode-gallery-installed"));
      })
      .catch((error) => {
        msg.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        busy = false;
      });
  });
  // Registered once per page: a console revision change re-runs this file, and
  // every extra keydown listener would close the same adopted overlay.
  if (!window.__beauticodeGalleryKeydown) {
    window.__beauticodeGalleryKeydown = (event) => {
      if (event.key === "Escape" && !host.hidden) {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", window.__beauticodeGalleryKeydown);
  }

  window.BeauticodeGallery = { open, close };
})();

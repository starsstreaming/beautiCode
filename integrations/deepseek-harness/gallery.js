(() => {
  "use strict";
  if (window.__beauticodeGalleryLoaded) return;
  window.__beauticodeGalleryLoaded = true;

  const style = document.createElement("style");
  style.textContent = `
#beauticode-gallery{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:rgba(11,13,18,.62)}
#beauticode-gallery[hidden]{display:none}
#beauticode-gallery .bcg-panel{width:min(880px,calc(100vw - 32px));height:min(640px,calc(100vh - 32px));display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:#2c323c;color:#e8eaed;box-shadow:0 16px 48px rgba(0,0,0,.4);overflow:hidden}
body:not([data-ds-dark-theme]) #beauticode-gallery .bcg-panel{background:#fff;color:#1b1f24;border-color:rgba(0,0,0,.08)}
#beauticode-gallery .bcg-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
#beauticode-gallery .bcg-head h2{margin:0;font-size:15px;font-weight:600}
#beauticode-gallery .bcg-head input,#beauticode-gallery .bcg-head select{height:32px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.06);color:inherit;padding:0 8px}
#beauticode-gallery .bcg-grid{flex:1;overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;align-content:start}
#beauticode-gallery .bcg-card{display:block;border:none;padding:0;border-radius:12px;overflow:hidden;background:#232830;color:inherit;text-align:left;cursor:pointer}
#beauticode-gallery .bcg-card img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:#111}
#beauticode-gallery .bcg-card span{display:block;padding:8px 10px;font-size:13px}
#beauticode-gallery .bcg-msg,#beauticode-gallery .bcg-foot{padding:0 14px 12px;color:#9aa3ad;font-size:12px}
#beauticode-gallery .bcg-close{margin-left:auto}
#beauticode-gallery .bcg-btn{height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.06);color:inherit;cursor:pointer}
#beauticode-gallery .bcg-btn.primary{background:#4d6bfe;border-color:transparent}
  `;
  document.head.append(style);

  const host = document.createElement("div");
  host.id = "beauticode-gallery";
  host.hidden = true;
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
  document.body.append(host);

  const grid = host.querySelector(".bcg-grid");
  const msg = host.querySelector(".bcg-msg");
  const foot = host.querySelector(".bcg-foot");
  const queryInput = host.querySelector(".bcg-q");
  const typeSelect = host.querySelector(".bcg-type");
  let centerUrl = "";
  let busy = false;

  function escapeText(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  async function request(path, init) {
    const response = await fetch(path, init);
    if ((response.headers.get("content-type") || "").includes("ndjson")) {
      return readNdjson(response);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.error || `请求失败（${response.status}）`);
    }
    return body;
  }

  async function readNdjson(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let last = null;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        last = JSON.parse(line);
        if (last.phase === "download" && last.total) {
          const pct = Math.round((last.done / last.total) * 100);
          msg.textContent = `正在下载${last.part === "video" ? "视频" : "图片"} ${pct}%`;
        } else if (last.phase === "import") {
          msg.textContent = "正在写入本机主题…";
        } else if (last.phase === "apply") {
          msg.textContent = "正在应用到当前窗口…";
        }
        if (last.ok === false) throw new Error(last.error || "安装失败。");
      }
      if (done) break;
    }
    if (last?.ok) return last;
    throw new Error(last?.error || "安装失败。");
  }

  async function load() {
    msg.textContent = "正在读取目录…";
    const params = new URLSearchParams();
    if (queryInput.value.trim()) params.set("q", queryInput.value.trim());
    if (typeSelect.value) params.set("type", typeSelect.value);
    const data = await request(`/__beauticode/ui/gallery/catalog?${params}`);
    centerUrl = data.url || centerUrl;
    grid.innerHTML = (data.skins || [])
      .map(
        (skin) =>
          `<button type="button" class="bcg-card" data-id="${escapeText(skin.id)}">` +
          `<img alt="" src="${escapeText(centerUrl)}/api/skins/${escapeText(skin.id)}/card">` +
          `<span>${escapeText(skin.name)}${skin.type === "video" ? " · 视频" : ""}</span></button>`,
      )
      .join("");
    msg.textContent = data.skins?.length ? "" : "目录是空的。";
    foot.innerHTML = centerUrl
      ? `上传与审核在 <a href="${escapeText(centerUrl)}" target="_blank" rel="noreferrer">皮肤中心网站</a>。安装会下载到本机后再应用。`
      : "未配置皮肤中心地址。在插件的 skin-center.json 或环境变量 BEAUTICODE_SKIN_CENTER 里填入你的域名。";
  }

  async function open() {
    host.hidden = false;
    const config = await request("/__beauticode/ui/gallery/config");
    centerUrl = config.url || "";
    if (!config.enabled) {
      grid.innerHTML = "";
      msg.textContent = "尚未配置皮肤中心地址。";
      foot.textContent = "设置 BEAUTICODE_SKIN_CENTER，或在 skin-center.json 填写站点 URL。";
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
    request("/__beauticode/ui/gallery/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    })
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
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !host.hidden) {
      event.stopPropagation();
      close();
    }
  });

  window.BeauticodeGallery = { open, close };
})();

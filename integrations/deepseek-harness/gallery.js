(() => {
  "use strict";
  if (window.__beauticodeGalleryLoaded) return;
  window.__beauticodeGalleryLoaded = true;

  const style = document.createElement("style");
  style.textContent = `
#beauticode-gallery{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1)}
#beauticode-gallery[hidden]{display:none}
#beauticode-gallery .bcg-panel{width:min(880px,calc(100vw - 32px));height:min(640px,calc(100vh - 32px));display:flex;flex-direction:column;border:0;border-radius:20px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}
#beauticode-gallery .bcg-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
#beauticode-gallery .bcg-head h2{margin:0;font-size:16px;font-weight:600;line-height:24px}
#beauticode-gallery .bcg-head input,#beauticode-gallery .bcg-head select{height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
#beauticode-gallery .bcg-head input:focus,#beauticode-gallery .bcg-head select:focus{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
#beauticode-gallery .bcg-grid{flex:1;overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;align-content:start}
#beauticode-gallery .bcg-card{display:block;border:.5px solid var(--dsw-alias-border-l4);padding:0;border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);color:inherit;text-align:left;cursor:pointer}
#beauticode-gallery .bcg-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
#beauticode-gallery .bcg-card img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:var(--dsw-alias-bg-skeleton)}
#beauticode-gallery .bcg-card span{display:block;padding:8px 10px;font-size:13px;line-height:20px}
#beauticode-gallery .bcg-msg,#beauticode-gallery .bcg-foot{padding:0 14px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
#beauticode-gallery .bcg-close{margin-left:auto}
#beauticode-gallery .bcg-btn{height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
#beauticode-gallery .bcg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
#beauticode-gallery .bcg-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
#beauticode-gallery .bcg-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
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

  let queryAbort=null, openAbort=null, polling=null;
  const operationKey="beauticode-gallery-operation";
  let operationId="";
  try { operationId=sessionStorage.getItem(operationKey)||""; } catch {}
  const cancelButton=document.createElement("button");cancelButton.type="button";cancelButton.className="bcg-btn";cancelButton.textContent="取消下载";cancelButton.hidden=true;
  host.querySelector(".bcg-head").append(cancelButton);
  function rememberOperation(id){operationId=id;try{id?sessionStorage.setItem(operationKey,id):sessionStorage.removeItem(operationKey);}catch{}}
  const operation=(action,body={})=>request("/__beauticode/ui/gallery/operation",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...body})});
  async function watchOperation(){
    polling?.abort();const controller=new AbortController();polling=controller;busy=true;cancelButton.hidden=false;
    const deadline=Date.now()+120000;
    try{
      while(!controller.signal.aborted&&!host.hidden){
        const state=await operation("status",{operationId});
        if(controller.signal.aborted||host.hidden)return;
        if(state.result){msg.textContent=state.result.message||state.result.error||(state.result.ok?"已安装。":"安装失败。");if(state.result.ok)document.dispatchEvent(new CustomEvent("beauticode-gallery-installed"));rememberOperation("");return;}
        cancelButton.disabled=state.phase==="apply";
        msg.textContent=state.phase==="apply"?"正在提交背景，可稍后重新打开查询结果。":"正在下载，可取消。";
        if(Date.now()>deadline){msg.textContent="操作仍在进行，关闭后重新打开可查询结果。";return;}
        await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener("abort",finish);resolve()};const timer=setTimeout(finish,400);controller.signal.addEventListener("abort",finish,{once:true})});
      }
    }catch(error){if(!controller.signal.aborted){msg.textContent=error.message;if(error.code==="operation_unknown")rememberOperation("");}}
    finally{if(polling===controller){polling=null;busy=false;cancelButton.hidden=!operationId;}}
  }
  cancelButton.onclick=()=>{if(operationId)void operation("cancel",{operationId}).then(state=>{if(state.message)msg.textContent=state.message;else msg.textContent="正在取消下载…";if(!host.hidden&&!busy)void watchOperation()}).catch(error=>{msg.textContent=error.message})};

  let loadGeneration = 0;

  let returnFocus = null;
  const focusables = () => [...host.querySelectorAll('button, input, select, a[href], [tabindex]')]
    .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
  function focusInside() { (focusables()[0] || host).focus(); }
  host.tabIndex = -1;
  document.addEventListener("focusin", (event) => {
    if (!host.hidden && !host.contains(event.target)) focusInside();
  });
  document.addEventListener("keydown", (event) => {
    if (host.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); close(); return;
    }
    if (event.key === "Tab") {
      const nodes = focusables(), current = nodes.indexOf(document.activeElement);
      event.preventDefault(); event.stopImmediatePropagation();
      if (!nodes.length) { host.focus(); return; }
      const next = (current + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
      nodes[next].focus();
    }
  }, true);


  // Mirrors gallery-host.mjs::isSafeSkinId — catalog ids are only safe to
  // render when they match the skin-<hex> shape the backend already validates.
  const SKIN_ID = /^skin-[a-z0-9]{8,40}$/;

  function escapeText(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  // Attribute context additionally needs quote escaping; escapeText alone lets
  // a malicious catalog id break out of data-id/src and inject handlers.
  function escapeAttr(value) {
    return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  async function request(path, init) {
    const response = await fetch(path, {
      ...init,
      signal:init?.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
      headers: { ...(init?.headers || {}), ...(globalThis.__beauticodeTransport?.headers() ?? {}) },
    });
    if ((response.headers.get("content-type") || "").includes("ndjson")) {
      return readNdjson(response);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
      throw Object.assign(new Error(body?.error || `请求失败（${response.status}）`),{code:body?.code});
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
    const generation = ++loadGeneration;
    queryAbort?.abort();queryAbort=new AbortController();const signal=queryAbort.signal;
    msg.textContent = "正在读取目录…";
    try {
      const params = new URLSearchParams();
      if (queryInput.value.trim()) params.set("q", queryInput.value.trim());
      if (typeSelect.value) params.set("type", typeSelect.value);
      const data = await request(`/__beauticode/ui/gallery/catalog?${params}`,{signal});
      if (generation !== loadGeneration || host.hidden) return;
      centerUrl = data.url || centerUrl;
      grid.innerHTML = (data.skins || [])
        .filter((skin) => SKIN_ID.test(String(skin.id ?? "")))
        .map(
          (skin) =>
            `<button type="button" class="bcg-card" data-id="${escapeAttr(skin.id)}">` +
            `<img alt="" src="${escapeAttr(centerUrl)}/api/skins/${escapeAttr(skin.id)}/card">` +
            `<span>${escapeText(skin.name)}${skin.type === "video" ? " · 视频" : ""}</span></button>`,
        )
        .join("");
      msg.textContent = data.skins?.length ? "" : "目录是空的。";
      foot.innerHTML = centerUrl
        ? `上传与审核在 <a href="${escapeAttr(centerUrl)}" target="_blank" rel="noreferrer">皮肤中心网站</a>。安装会下载到本机后再应用。`
        : "未配置皮肤中心地址。在插件的 skin-center.json 或环境变量 BEAUTICODE_SKIN_CENTER 里填入你的域名。";
    } catch (error) {
      if (generation !== loadGeneration || host.hidden) return;
      grid.innerHTML = "";
      msg.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async function open() {
    if (host.hidden) returnFocus = document.activeElement;
    host.hidden = false;
    focusInside();
    openAbort?.abort();openAbort=new AbortController();const opening=openAbort;
    if(operationId){void watchOperation();return;}
    try {
      let config;try{config=await request("/__beauticode/ui/gallery/config",{signal:opening.signal});}catch(error){if(!opening.signal.aborted)msg.textContent=error.message;return;}
      if(opening.signal.aborted||host.hidden)return;
    centerUrl = config.url || "";
      if (!config.enabled) {
        grid.innerHTML = "";
        msg.textContent = "尚未配置皮肤中心地址。";
        foot.textContent = "设置 BEAUTICODE_SKIN_CENTER，或在 skin-center.json 填写站点 URL。";
        return;
      }
      await load();
    } catch (error) {
      grid.innerHTML = "";
      msg.textContent = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  function close() {
    host.hidden = true;
    loadGeneration += 1;
    queryAbort?.abort();openAbort?.abort();polling?.abort();
    if(operationId)void operation('cancel',{operationId}).catch(()=>{});
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
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
    operation("start",{id}).then(state=>{rememberOperation(state.id);if(host.hidden){void operation("cancel",{operationId});return;}return watchOperation()})
      .catch(error=>{msg.textContent=error.message;})
      .finally(()=>{if(!polling)busy=false;});
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !host.hidden) {
      event.stopPropagation();
      close();
    }
  });

  window.BeauticodeGallery = { open, close };
})();

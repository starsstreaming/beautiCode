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
    const payload = await new Promise((resolve,reject)=>{
      const signal=init?.signal;let timer;
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);pending.delete(id)};
      const cancelRemote=()=>{try{window.beauticodeConsole(JSON.stringify({id:crypto.randomUUID(),path:"/__beauticode/ui/gallery/cancel-request",body:{requestId:id}}))}catch{}};
      const abort=()=>{cleanup();cancelRemote();reject(new DOMException("已取消","AbortError"))};
      timer=setTimeout(()=>{cleanup();cancelRemote();reject(new Error("皮肤中心请求超时，请重新打开查询结果。"))},timeoutMs||45000);
      if(signal?.aborted){abort();return;}
      signal?.addEventListener("abort",abort,{once:true});
      pending.set(id,{resolve(value){cleanup();resolve(value)},reject(error){cleanup();reject(error)}});
      try{window.beauticodeConsole(JSON.stringify({id,path,method:init?.method||"GET",body}));}
      catch(error){cleanup();reject(error);}
    });
    if (payload?.ok === false) {
      throw Object.assign(new Error(payload.error || "请求失败"),{code:payload.code});
    }
    return payload;
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
            `<span>${escapeText(skin.name)}${skin.type === "video" ? " · 视频" : ""}</span></button>`,
        )
        .join("");
      msg.textContent = data.skins?.length ? "" : "目录是空的。";
      foot.textContent = centerUrl
        ? `来源 ${centerUrl}。安装会下载到本机后再应用。`
        : "未配置皮肤中心地址。";
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
    let config;try{config=await request("/__beauticode/ui/gallery/config",{signal:opening.signal});}catch(error){if(!opening.signal.aborted)msg.textContent=error.message;return;}
    if(opening.signal.aborted||host.hidden)return;
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
    rememberOperation(crypto.randomUUID());
    operation("start",{id,operationId}).then(state=>{rememberOperation(state.id);if(host.hidden)return operation("cancel",{operationId});return watchOperation()})
      .catch(error=>{msg.textContent=error.message;})
      .finally(()=>{if(!polling)busy=false;});
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

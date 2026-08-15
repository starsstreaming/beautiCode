(() => {
  "use strict";
  if (window.__beauticodeBridgeLoaded) return;
  window.__beauticodeBridgeLoaded = true;
  window.__beauticodeBridgeVersion = 4;

  const clientId =
    globalThis.crypto?.randomUUID?.() ||
    `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const desiredModes = { fish: false, muted: true, tone: "dark" };
  let activePayload = null;
  let playbackBlocked = false;
  const systemDarkMedia = globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  let themeSyncQueued = false;

  const style = document.createElement("style");
  style.dataset.beauticodeBridge = "true";
  style.textContent = `
html[data-bc-active="true"],html[data-bc-active="true"] body{background:transparent!important}
html[data-bc-active="true"] body{
  --dsw-alias-bg-base:rgba(17,20,27,.26);
  --dsw-alias-bg-layer-1:rgba(26,30,39,.58);
  --dsw-alias-bg-layer-2:rgba(35,40,51,.68);
  --dsw-alias-bg-overlay:rgba(17,20,27,.74);
  --dsw-specific-sidebar-fill:rgba(23,27,35,.64);
}
html[data-bc-resolved-tone="light"][data-bc-active="true"] body{
  --dsw-alias-bg-base:rgba(248,250,252,.34);
  --dsw-alias-bg-layer-1:rgba(255,255,255,.64);
  --dsw-alias-bg-layer-2:rgba(248,250,252,.72);
  --dsw-alias-bg-overlay:rgba(255,255,255,.76);
  --dsw-specific-sidebar-fill:rgba(255,255,255,.68);
}
#beauticode-bg-stage{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:#11141b}
#beauticode-bg-stage::after{content:"";position:absolute;inset:0;z-index:2;background:rgba(0,0,0,.24);pointer-events:none}
html[data-bc-resolved-tone="light"] #beauticode-bg-stage{background:#f8fafc}
html[data-bc-resolved-tone="light"] #beauticode-bg-stage::after{background:rgba(255,255,255,.10)}
html[data-bc-active="true"]:has(#root [data-phase="hero"]) #beauticode-bg-stage::after{background:transparent}
#beauticode-bg-stage img,#beauticode-bg-stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
#beauticode-bg-stage img{z-index:0}
#beauticode-bg-stage video{z-index:1}
html[data-bc-active="true"] #root{position:relative;z-index:1;background:transparent!important}
html[data-bc-fish="true"] #root{opacity:0!important;visibility:hidden!important;pointer-events:none!important}
`;
  document.head.append(style);

  function resolvedTone() {
    if (desiredModes.tone !== "auto") return desiredModes.tone;
    return systemDarkMedia?.matches ? "dark" : "light";
  }

  function isDshThemeSynced(tone = resolvedTone()) {
    const body = document.body;
    if (!body) return false;
    return (
      body.hasAttribute("data-ds-dark-theme") === (tone === "dark") &&
      document.documentElement.style.colorScheme === tone
    );
  }

  function syncDshTheme() {
    const tone = resolvedTone();
    const root = document.documentElement;
    const body = document.body;
    root.dataset.bcResolvedTone = tone;
    if (root.style.colorScheme !== tone) root.style.colorScheme = tone;
    if (body) body.toggleAttribute("data-ds-dark-theme", tone === "dark");
    return isDshThemeSynced(tone);
  }

  function scheduleDshThemeSync() {
    if (themeSyncQueued) return;
    themeSyncQueued = true;
    queueMicrotask(() => {
      themeSyncQueued = false;
      syncDshTheme();
    });
  }

  const themeObserver = new MutationObserver(scheduleDshThemeSync);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });
  if (document.body) {
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-ds-dark-theme"],
    });
  }
  systemDarkMedia?.addEventListener("change", () => {
    if (desiredModes.tone === "auto") {
      syncDshTheme();
      void acknowledgeMode();
    }
  });
  syncDshTheme();

  function stage() {
    let node = document.getElementById("beauticode-bg-stage");
    if (!node) {
      node = document.createElement("div");
      node.id = "beauticode-bg-stage";
      document.body.prepend(node);
    }
    return node;
  }

  function activeVideo() {
    return document.querySelector("#beauticode-bg-stage video");
  }

  async function postAck(body) {
    await fetch("/__beauticode/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, ...body }),
    }).catch(() => {});
  }

  function playbackSnapshot(video) {
    if (!(video instanceof HTMLVideoElement)) return null;
    return {
      currentTime: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
      duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
      hasVideo: true,
      muted: video.muted,
      paused: video.paused,
      blocked: playbackBlocked,
    };
  }

  async function acknowledgeRender(payload, ok, visible, error = null) {
    await postAck({
      kind: "render",
      generation: payload.generation,
      media: payload.media,
      ok,
      visible,
      error,
      playback: payload.media === "video" ? playbackSnapshot(activeVideo()) : null,
    });
  }

  async function acknowledgeMode() {
    const video = activeVideo();
    const effectiveTone = resolvedTone();
    await postAck({
      kind: "mode",
      fish: document.documentElement.dataset.bcFish === "true",
      muted: video instanceof HTMLVideoElement ? video.muted : desiredModes.muted,
      tone: document.documentElement.dataset.bcTone || "dark",
      resolvedTone: effectiveTone,
      themeSynced: isDshThemeSynced(effectiveTone),
      blocked: playbackBlocked,
    });
  }

  function loadImage(url) {
    const image = new Image();
    image.alt = "";
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    return new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片加载失败"));
      image.src = url;
    });
  }

  function waitForVideo(video) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("MP4 加载或解码失败"));
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("error", failed);
      };
      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("error", failed, { once: true });
    });
  }

  function seekVideo(video, value) {
    const requested = Number(value);
    const duration = Number(video.duration);
    const safe =
      Number.isFinite(requested) &&
      requested >= 0 &&
      (!Number.isFinite(duration) || duration <= 0 || requested < duration)
        ? requested
        : 0;
    try {
      video.currentTime = safe;
    } catch {
      video.currentTime = 0;
    }
  }

  async function playWithPreference(video) {
    playbackBlocked = false;
    video.muted = desiredModes.muted;
    try {
      await video.play();
    } catch (error) {
      if (desiredModes.muted) throw error;
      playbackBlocked = true;
      video.muted = true;
      await video.play();
    }
  }

  async function applyBackground(payload) {
    if (!Number.isSafeInteger(payload?.generation)) return;
    activePayload = payload;
    document.documentElement.dataset.bcGeneration = String(payload.generation);
    if (payload.media === "clear") {
      desiredModes.fish = false;
      playbackBlocked = false;
      document.documentElement.removeAttribute("data-bc-active");
      document.documentElement.removeAttribute("data-bc-media");
      document.documentElement.removeAttribute("data-bc-fish");
      document.getElementById("beauticode-bg-stage")?.remove();
      await acknowledgeRender(payload, true, false);
      await acknowledgeMode();
      return;
    }
    if (typeof payload.imageUrl !== "string") return;
    try {
      const image = await loadImage(payload.imageUrl);
      if (activePayload !== payload) return;
      const node = stage();
      if (payload.media === "image") {
        playbackBlocked = false;
        node.replaceChildren(image);
        document.documentElement.dataset.bcActive = "true";
        document.documentElement.dataset.bcMedia = "image";
        const visible = image.naturalWidth > 0 && image.naturalHeight > 0;
        await acknowledgeRender(payload, visible, visible, visible ? null : "图片尺寸无效");
        await acknowledgeMode();
        return;
      }
      if (payload.media !== "video" || typeof payload.videoUrl !== "string") return;
      const video = document.createElement("video");
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.poster = payload.imageUrl;
      video.crossOrigin = "anonymous";
      video.src = payload.videoUrl;
      node.replaceChildren(image, video);
      await waitForVideo(video);
      if (activePayload !== payload) return;
      seekVideo(video, payload.startAt);
      await playWithPreference(video);
      document.documentElement.dataset.bcActive = "true";
      document.documentElement.dataset.bcMedia = "video";
      const visible = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused;
      await acknowledgeRender(payload, visible, visible, visible ? null : "视频未开始播放");
      await acknowledgeMode();
    } catch (error) {
      if (activePayload !== payload) return;
      await acknowledgeRender(
        payload,
        false,
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function applyModes(payload) {
    if (typeof payload.fish === "boolean") desiredModes.fish = payload.fish;
    if (typeof payload.muted === "boolean") desiredModes.muted = payload.muted;
    if (["dark", "light", "auto"].includes(payload.tone)) desiredModes.tone = payload.tone;
    document.documentElement.dataset.bcTone = desiredModes.tone;
    syncDshTheme();
    if (desiredModes.fish && document.documentElement.dataset.bcActive === "true") {
      document.documentElement.dataset.bcFish = "true";
    } else {
      document.documentElement.removeAttribute("data-bc-fish");
    }
    const video = activeVideo();
    if (video instanceof HTMLVideoElement) {
      try {
        await playWithPreference(video);
      } catch {
        playbackBlocked = desiredModes.muted === false;
      }
      if (activePayload?.media === "video") {
        await acknowledgeRender(activePayload, video.readyState >= 2 && !video.paused, true);
      }
    } else {
      playbackBlocked = false;
    }
    await acknowledgeMode();
  }

  const events = new EventSource(
    `/__beauticode/events?clientId=${encodeURIComponent(clientId)}`,
  );
  events.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === "mode") void applyModes(payload);
      else if (payload?.type === "apply") void applyBackground(payload);
    } catch {
      /* EventSource will continue with the next valid frame. */
    }
  };

  setInterval(() => {
    const video = activeVideo();
    if (activePayload?.media === "video" && video instanceof HTMLVideoElement) {
      void acknowledgeRender(activePayload, video.readyState >= 2 && !video.paused, true);
    }
  }, 1_000);
})();

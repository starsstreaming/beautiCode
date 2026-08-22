(() => {
  "use strict";
  if (window.__beauticodeBridgeLoaded) return;
  window.__beauticodeBridgeLoaded = true;
  window.__beauticodeBridgeVersion = 4;

  const clientId =
    globalThis.crypto?.randomUUID?.() ||
    `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const desiredModes = { fish: false, muted: true, tone: "auto" };
  // The DSH host owns a hard 10-second verification boundary. Keep the browser
  // transaction inside it so failures remain phase-specific instead of turning
  // into a generic host timeout.
  const CLIENT_APPLY_DEADLINE_MS = 8_000;
  const IMAGE_LOAD_TIMEOUT_MS = CLIENT_APPLY_DEADLINE_MS;
  const IMAGE_ATTEMPT_TIMEOUT_MS = 3_000;
  const IMAGE_MAX_ATTEMPTS = 2;
  const VIDEO_STARTUP_TIMEOUT_MS = CLIENT_APPLY_DEADLINE_MS;
  const VIDEO_PROBE_TIMEOUT_MS = 2_000;
  const DSH_STRUCTURE_TIMEOUT_MS = CLIENT_APPLY_DEADLINE_MS;
  const FRAME_FALLBACK_MS = 120;
  const VIDEO_FIRST_FRAME_PROGRESS_SEC = 0.03;
  const VIDEO_STABLE_FRAMES = 3;
  const VIDEO_STABLE_PROGRESS_SEC = 0.18;
  const CROSSFADE_MS = 180;
  let activePayload = null;
  let committedPayload = null;
  let renderPhase = "idle";
  let playbackBlocked = false;
  let currentSlot = null;
  let applyController = null;
  const systemDarkMedia = globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const reducedMotionMedia =
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  let themeSyncQueued = false;

  const style = document.createElement("style");
  style.dataset.beauticodeBridge = "true";
  style.textContent = `
html[data-bc-active="true"],html[data-bc-active="true"] body{background:transparent!important}
html[data-bc-active="true"] body{
  --dsw-alias-bg-base:rgba(17,20,27,.10);
  --dsw-alias-bg-layer-1:rgba(26,30,39,.28);
  --dsw-alias-bg-layer-2:rgba(35,40,51,.32);
  --dsw-alias-bg-overlay:rgba(17,20,27,.12);
  --dsw-specific-sidebar-fill:rgba(23,27,35,.28);
}
html[data-bc-resolved-tone="light"][data-bc-active="true"] body{
  --dsw-alias-bg-base:rgba(248,250,252,.12);
  --dsw-alias-bg-layer-1:rgba(255,255,255,.28);
  --dsw-alias-bg-layer-2:rgba(248,250,252,.32);
  --dsw-alias-bg-overlay:rgba(255,255,255,.14);
  --dsw-specific-sidebar-fill:rgba(255,255,255,.28);
}
html[data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --dsw-alias-bg-base:rgba(17,20,27,.42);
  --dsw-alias-bg-layer-1:rgba(26,30,39,.72);
  --dsw-alias-bg-layer-2:rgba(35,40,51,.80);
  --dsw-alias-bg-overlay:rgba(17,20,27,.86);
  --dsw-specific-sidebar-fill:rgba(23,27,35,.78);
}
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --dsw-alias-bg-base:rgba(248,250,252,.48);
  --dsw-alias-bg-layer-1:rgba(255,255,255,.74);
  --dsw-alias-bg-layer-2:rgba(248,250,252,.82);
  --dsw-alias-bg-overlay:rgba(255,255,255,.86);
  --dsw-specific-sidebar-fill:rgba(255,255,255,.78);
}
#beauticode-bg-stage{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:#11141b}
#beauticode-bg-stage::after{content:"";position:absolute;inset:0;z-index:3;background:transparent;pointer-events:none}
html[data-bc-resolved-tone="light"] #beauticode-bg-stage{background:#f8fafc}
html[data-bc-active="true"]:has(#root [data-phase="active"]) #beauticode-bg-stage::after,
html[data-bc-active="true"]:has(#root [data-phase="settling"]) #beauticode-bg-stage::after{background:rgba(0,0,0,.42)}
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="active"]) #beauticode-bg-stage::after,
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="settling"]) #beauticode-bg-stage::after{background:rgba(255,255,255,.22)}
html[data-bc-fish="true"] #beauticode-bg-stage::after{background:transparent!important}
#beauticode-bg-stage .beauticode-media-slot{position:absolute;inset:0;z-index:0;opacity:1;overflow:hidden;pointer-events:none;transition:opacity ${CROSSFADE_MS}ms ease;will-change:opacity}
#beauticode-bg-stage .beauticode-media-slot[data-bc-role="current"]{z-index:1;opacity:1}
#beauticode-bg-stage .beauticode-media-slot[data-bc-role="candidate"]{z-index:2;opacity:1}
#beauticode-bg-stage[data-bc-empty="true"] .beauticode-media-slot[data-bc-role="candidate"]{z-index:1}
#beauticode-bg-stage[data-bc-transitioning="true"] .beauticode-media-slot[data-bc-role="current"]{opacity:0}
#beauticode-bg-stage[data-bc-transitioning="true"] .beauticode-media-slot[data-bc-role="candidate"]{opacity:1}
#beauticode-bg-stage .beauticode-media-slot img,#beauticode-bg-stage .beauticode-media-slot video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;transition:opacity 120ms ease}
#beauticode-bg-stage .beauticode-media-slot img{z-index:2;opacity:1}
/* Keep cold candidate video paintable. Chromium may defer decoding media that
   is nearly transparent, which deadlocks the first-frame gate. The poster
   covers it until data-bc-video-ready is committed. */
#beauticode-bg-stage .beauticode-media-slot video{z-index:1;opacity:1}
#beauticode-bg-stage .beauticode-media-slot[data-bc-video-ready="true"] img{opacity:0}
#beauticode-bg-stage .beauticode-media-slot[data-bc-video-ready="true"] video{opacity:1}
@media (prefers-reduced-motion:reduce){#beauticode-bg-stage .beauticode-media-slot,#beauticode-bg-stage .beauticode-media-slot img,#beauticode-bg-stage .beauticode-media-slot video{transition:none!important}}
html[data-bc-active="true"] #root{position:relative;z-index:1;background:transparent!important}
html[data-bc-active="true"] [class*="_fade"]{display:none!important}
html[data-bc-fish="true"] #root{opacity:0!important;visibility:hidden!important;pointer-events:none!important}
`;
  document.head.append(style);

  function dshAppearance() {
    const body = document.body;
    if (body?.hasAttribute("data-ds-dark-theme")) return "dark";
    const scheme = document.documentElement.style.colorScheme;
    if (scheme === "dark" || scheme === "light") return scheme;
    return systemDarkMedia?.matches ? "dark" : "light";
  }

  function resolvedTone() {
    return dshAppearance();
  }

  function isDshThemeSynced(tone = resolvedTone()) {
    return document.documentElement.dataset.bcResolvedTone === tone;
  }

  function syncDshTheme() {
    const tone = resolvedTone();
    document.documentElement.dataset.bcResolvedTone = tone;
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
      void acknowledgeMode().catch(() => {});
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

  /**
   * Fail closed on DSH DOM drift: the injected CSS depends on `#root`.
   * If the shell no longer exposes it, report a clear error through the
   * render ack instead of silently painting a broken page.
   */
  function dshStructureIssue() {
    if (!document.getElementById("root")) {
      return "DSH 页面结构不兼容：未找到 #root。";
    }
    return null;
  }

  function waitForDshStructure(signal, timeoutMs = DSH_STRUCTURE_TIMEOUT_MS) {
    if (!dshStructureIssue()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const startedAt = performance.now();
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        signal?.removeEventListener?.("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(abortError());
      const timer = setInterval(() => {
        const issue = dshStructureIssue();
        if (!issue) {
          finish();
        } else if (performance.now() - startedAt >= timeoutMs) {
          finish(new Error(issue));
        }
      }, 50);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function mountedCurrentSlot() {
    const node = document.getElementById("beauticode-bg-stage");
    if (
      !currentSlot ||
      currentSlot.isConnected !== true ||
      currentSlot.parentElement !== node ||
      currentSlot.dataset.bcRole !== "current"
    ) {
      currentSlot = null;
      committedPayload = null;
      return null;
    }
    return currentSlot;
  }

  function activeVideo() {
    const video = mountedCurrentSlot()?.querySelector?.("video") ?? null;
    return video instanceof HTMLVideoElement ? video : null;
  }

  function pendingVideo() {
    const node = document.getElementById("beauticode-bg-stage");
    const video = node?.querySelector?.(
      '.beauticode-media-slot[data-bc-role="candidate"] video',
    );
    return video instanceof HTMLVideoElement ? video : null;
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
    if (activePayload === payload) {
      renderPhase = ok ? "ready" : "failed";
    }
    await postAck({
      kind: "render",
      generation: payload.generation,
      media: payload.media,
      ok,
      visible,
      error,
      playback:
        ok && committedPayload === payload && payload.media === "video"
          ? playbackSnapshot(activeVideo())
          : null,
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

  function abortError() {
    try {
      return new DOMException("Background apply superseded", "AbortError");
    } catch {
      const error = new Error("Background apply superseded");
      error.name = "AbortError";
      return error;
    }
  }

  function isAbortError(error) {
    return error?.name === "AbortError";
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }

  function releaseImage(image, { remove = false } = {}) {
    if (!image) return;
    image.onload = null;
    image.onerror = null;
    try {
      image.removeAttribute?.("src");
    } catch {
      image.src = "";
    }
    if (remove) image.remove?.();
  }

  function imageAttemptUrl(url, attempt) {
    if (attempt === 0) return url;
    try {
      const retryUrl = new URL(url, globalThis.location?.href);
      retryUrl.searchParams.set(
        "bcImageRetry",
        `${clientId}-${attempt}-${Date.now().toString(36)}`,
      );
      return retryUrl.href;
    } catch {
      return url;
    }
  }

  function waitForImageAttempt(image, url, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let decodeStarted = false;
      let decodeFallback = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (decodeFallback) clearTimeout(decodeFallback);
        signal?.removeEventListener?.("abort", aborted);
        image.onload = null;
        image.onerror = null;
      };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const acceptLoaded = () => {
        if (!(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)) {
          if (image.complete) finish(new Error("图片尺寸无效"));
          return;
        }
        if (!decodeStarted && typeof image.decode === "function") {
          decodeStarted = true;
          // decode() is a second readiness signal, but the per-attempt timer
          // remains authoritative. A loaded image is still accepted after a
          // short decode grace period if Chromium leaves decode() pending.
          decodeFallback = setTimeout(() => {
            if (
              image.isConnected === true &&
              image.complete &&
              image.naturalWidth > 0 &&
              image.naturalHeight > 0
            ) {
              finish();
            } else {
              finish(new Error("图片解码未完成"));
            }
          }, 750);
          let decodePromise;
          try {
            decodePromise = image.decode();
          } catch {
            finish(new Error("图片解码失败"));
            return;
          }
          Promise.resolve(decodePromise).then(
            () => finish(),
            () => finish(new Error("图片解码失败")),
          );
          return;
        }
        finish();
      };
      const failed = () => finish(new Error("图片请求失败"));
      const aborted = () => finish(abortError());
      const timer = setTimeout(
        () => finish(new Error("等待图片请求或解码超时")),
        timeoutMs,
      );
      image.onload = acceptLoaded;
      image.onerror = failed;
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) {
        aborted();
        return;
      }
      image.src = url;
      if (image.complete) queueMicrotask(acceptLoaded);
    });
  }

  function waitForRetryWindow(signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(abortError());
      const timer = setTimeout(() => finish(), timeoutMs);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  async function loadImage(slot, url, signal, timeoutMs = IMAGE_LOAD_TIMEOUT_MS) {
    const deadline = performance.now() + timeoutMs;
    const attempts = [];
    let lastError = null;

    const startAttempt = (attempt) => {
      throwIfAborted(signal);
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new Error("等待图片请求或解码超时");
      const controller = new AbortController();
      const parentAborted = () => controller.abort();
      signal?.addEventListener?.("abort", parentAborted, { once: true });
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      image.className = "beauticode-media-poster";
      slot.prepend(image);
      const promise = waitForImageAttempt(
        image,
        imageAttemptUrl(url, attempt),
        controller.signal,
        Math.max(1, remainingMs),
      )
        .then(() => image)
        .finally(() => signal?.removeEventListener?.("abort", parentAborted));
      const record = { controller, image, promise };
      attempts.push(record);
      return record;
    };

    const cleanupAttempts = (winner = null) => {
      for (const attempt of attempts) {
        if (attempt.image === winner) continue;
        attempt.controller.abort();
        releaseImage(attempt.image, { remove: true });
      }
    };

    try {
      const first = startAttempt(0);
      const firstWindow = await Promise.race([
        first.promise.then(
          (image) => ({ image }),
          (error) => ({ error }),
        ),
        waitForRetryWindow(
          signal,
          Math.max(1, Math.min(IMAGE_ATTEMPT_TIMEOUT_MS, deadline - performance.now())),
        ).then(() => ({ retry: true })),
      ]);
      if (firstWindow.image) {
        cleanupAttempts(firstWindow.image);
        return firstWindow.image;
      }
      if (isAbortError(firstWindow.error) || signal?.aborted) throw abortError();
      lastError = firstWindow.error ?? lastError;

      // Keep the original request alive. The cache-busted retry runs beside it
      // so a merely slow cold decode is never destroyed to recover a hung one.
      if (IMAGE_MAX_ATTEMPTS > 1) startAttempt(1);
      let winner;
      try {
        winner = await Promise.any(attempts.map((attempt) => attempt.promise));
      } catch (error) {
        const errors = Array.isArray(error?.errors) ? error.errors : [];
        lastError = errors.at(-1) ?? lastError ?? error;
        throw lastError;
      }
      cleanupAttempts(winner);
      return winner;
    } catch (error) {
      cleanupAttempts();
      if (isAbortError(error) || signal?.aborted) throw abortError();
      lastError = error ?? lastError;
      const visibility = document.visibilityState || "unknown";
      const online = globalThis.navigator?.onLine === false ? "offline" : "online";
      const phase = lastError?.message || "unknown";
      const summary =
        phase === "图片请求失败"
          ? "图片加载失败"
          : phase.includes("超时")
            ? "等待图片加载超时"
            : "图片校验失败";
      throw new Error(
        `${summary}（已尝试 ${attempts.length} 次；页面=${visibility}；网络=${online}；最后阶段=${phase}）`,
      );
    }
  }

  function safeOrigin(value) {
    try {
      return new URL(value, globalThis.location?.href).origin;
    } catch {
      return "unknown";
    }
  }

  function videoRequestContext(url) {
    return `页面Origin=${safeOrigin(globalThis.location?.href)}；媒体Origin=${safeOrigin(url)}；页面=${document.visibilityState || "unknown"}`;
  }

  async function probeVideoSource(url, signal, timeoutMs = VIDEO_PROBE_TIMEOUT_MS) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const parentAborted = () => controller.abort();
    signal?.addEventListener?.("abort", parentAborted, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, timeoutMs));
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-1" },
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        signal: controller.signal,
      });
      if (response.status !== 206) {
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        throw new Error(`视频媒体 Range 探针返回 HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== 2) {
        throw new Error(`视频媒体 Range 探针返回 ${bytes.byteLength} 字节`);
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const context = videoRequestContext(url);
      if (timedOut || isAbortError(error)) {
        throw new Error(`视频媒体 Range 探针超时；${context}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError) {
        throw new Error(`视频媒体不可达或被 CORS 拒绝；${context}；${detail}`);
      }
      throw new Error(`${detail}；${context}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", parentAborted);
    }
  }

  function describeVideoState(video, phase) {
    const mediaErrorNames = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
    };
    const code = Number(video?.error?.code) || 0;
    const mediaError = code ? mediaErrorNames[code] || `MEDIA_ERR_${code}` : "none";
    const src = video?.currentSrc || video?.src || "";
    return `${phase}；mediaError=${mediaError}；readyState=${video?.readyState ?? -1}；networkState=${video?.networkState ?? -1}；paused=${Boolean(video?.paused)}；${videoRequestContext(src)}`;
  }

  function waitForVideo(video, signal, timeoutMs = VIDEO_STARTUP_TIMEOUT_MS) {
    const frameReadyState = HTMLMediaElement.HAVE_CURRENT_DATA ?? 2;
    if (video.readyState >= frameReadyState) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => finish();
      const check = () => {
        if (video.readyState >= frameReadyState) done();
      };
      const failed = () => {
        finish(new Error(describeVideoState(video, "MP4 加载或解码失败")));
      };
      const aborted = () => {
        finish(signal?.aborted ? abortError() : new Error(describeVideoState(video, "视频加载已中止")));
      };
      const timer = setTimeout(() => {
        finish(new Error(describeVideoState(video, "等待视频首帧超时")));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", check);
        video.removeEventListener("canplay", done);
        video.removeEventListener("error", failed);
        video.removeEventListener("abort", aborted);
        signal?.removeEventListener?.("abort", aborted);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      video.addEventListener("loadeddata", check);
      video.addEventListener("canplay", done, { once: true });
      video.addEventListener("error", failed, { once: true });
      video.addEventListener("abort", aborted, { once: true });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function waitForSeek(video, signal, timeoutMs) {
    if (!video.seeking) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", done);
        video.removeEventListener("error", failed);
        signal?.removeEventListener?.("abort", aborted);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const done = () => finish();
      const failed = () => finish(new Error(describeVideoState(video, "视频跳转失败")));
      const aborted = () => finish(abortError());
      const timer = setTimeout(
        () => finish(new Error(describeVideoState(video, "等待视频跳转超时"))),
        timeoutMs,
      );
      video.addEventListener("seeked", done, { once: true });
      video.addEventListener("error", failed, { once: true });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function waitForPresentedFrame(video, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const initialTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      let frameSeen = false;
      let playingSeen =
        !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      let settled = false;
      let frameRequest = null;
      const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";

      const cleanup = () => {
        clearInterval(timer);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("timeupdate", check);
        video.removeEventListener("loadeddata", check);
        video.removeEventListener("canplay", check);
        video.removeEventListener("error", failed);
        video.removeEventListener("abort", aborted);
        signal?.removeEventListener?.("abort", aborted);
        if (frameRequest != null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(frameRequest);
        }
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const failed = () => {
        finish(new Error(describeVideoState(video, "视频解码器报告失败")));
      };
      const aborted = () => {
        finish(signal?.aborted ? abortError() : new Error(describeVideoState(video, "视频播放已中止")));
      };
      const check = () => {
        if (settled) return;
        if (video.error) {
          failed();
          return;
        }
        if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          playingSeen = true;
        }
        const current = Number.isFinite(video.currentTime) ? video.currentTime : initialTime;
        const progressed = current >= initialTime + VIDEO_FIRST_FRAME_PROGRESS_SEC;
        if (
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          !video.paused &&
          playingSeen &&
          (frameSeen || progressed)
        ) {
          finish();
          return;
        }
        if (performance.now() - startedAt >= timeoutMs) {
          finish(new Error(describeVideoState(video, "视频未在首帧窗口内完成呈现")));
        }
      };
      const onPlaying = () => {
        playingSeen = true;
        check();
      };
      const onFrame = () => {
        frameSeen = true;
        check();
      };
      const timer = setInterval(check, 80);
      video.addEventListener("playing", onPlaying);
      video.addEventListener("timeupdate", check);
      video.addEventListener("loadeddata", check);
      video.addEventListener("canplay", check);
      video.addEventListener("error", failed, { once: true });
      video.addEventListener("abort", aborted, { once: true });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (hasFrameCallback) frameRequest = video.requestVideoFrameCallback(onFrame);
      if (signal?.aborted) aborted();
      check();
    });
  }

  function waitForStablePlayback(video, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      let lastTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      let accumulatedProgress = 0;
      let advancingSamples = 0;
      let stableFrames = 0;
      let lastFrameTime = null;
      let playingSeen =
        !video.paused &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      let settled = false;
      let frameRequest = null;
      const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";

      const cleanup = () => {
        clearInterval(timer);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("timeupdate", check);
        video.removeEventListener("waiting", resetStableWindow);
        video.removeEventListener("stalled", resetStableWindow);
        video.removeEventListener("pause", resetStableWindow);
        video.removeEventListener("seeking", resetStableWindow);
        video.removeEventListener("error", failed);
        video.removeEventListener("abort", aborted);
        signal?.removeEventListener?.("abort", aborted);
        if (frameRequest != null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(frameRequest);
        }
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const failed = () => {
        finish(new Error(describeVideoState(video, "视频解码器报告失败")));
      };
      const aborted = () => {
        finish(signal?.aborted ? abortError() : new Error(describeVideoState(video, "视频播放已中止")));
      };
      const observeProgress = () => {
        const current = Number.isFinite(video.currentTime) ? video.currentTime : lastTime;
        let delta = current - lastTime;
        if (
          delta < 0 &&
          Number.isFinite(video.duration) &&
          video.duration > 0 &&
          lastTime > video.duration - 1 &&
          current < 1
        ) {
          delta = video.duration - lastTime + current;
        }
        if (delta > 0.003 && delta < 2) {
          accumulatedProgress += delta;
          advancingSamples += 1;
        }
        lastTime = current;
      };
      const resetStableWindow = () => {
        playingSeen = false;
        stableFrames = 0;
        advancingSamples = 0;
        accumulatedProgress = 0;
        lastTime = Number.isFinite(video.currentTime) ? video.currentTime : lastTime;
      };
      const check = () => {
        if (settled) return;
        if (video.error) {
          failed();
          return;
        }
        observeProgress();
        if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          playingSeen = true;
        }
        const framesReady = hasFrameCallback
          ? stableFrames >= VIDEO_STABLE_FRAMES
          : advancingSamples >= VIDEO_STABLE_FRAMES;
        if (
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          !video.paused &&
          playingSeen &&
          framesReady &&
          accumulatedProgress >= VIDEO_STABLE_PROGRESS_SEC
        ) {
          finish();
          return;
        }
        if (performance.now() - startedAt >= timeoutMs) {
          finish(new Error(describeVideoState(video, "视频未在稳定窗口内输出首帧")));
        }
      };
      const onPlaying = () => {
        playingSeen = true;
        check();
      };
      const onFrame = (_now, metadata) => {
        if (settled) return;
        const mediaTime = Number.isFinite(metadata?.mediaTime)
          ? metadata.mediaTime
          : video.currentTime;
        if (lastFrameTime == null || mediaTime > lastFrameTime + 0.001) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        lastFrameTime = mediaTime;
        check();
        if (!settled) frameRequest = video.requestVideoFrameCallback(onFrame);
      };
      const timer = setInterval(check, 80);
      video.addEventListener("playing", onPlaying);
      video.addEventListener("timeupdate", check);
      video.addEventListener("waiting", resetStableWindow);
      video.addEventListener("stalled", resetStableWindow);
      video.addEventListener("pause", resetStableWindow);
      video.addEventListener("seeking", resetStableWindow);
      video.addEventListener("error", failed, { once: true });
      video.addEventListener("abort", aborted, { once: true });
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (hasFrameCallback) frameRequest = video.requestVideoFrameCallback(onFrame);
      if (signal?.aborted) aborted();
      check();
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
    return safe;
  }

  async function playWithPreference(video, signal = null) {
    throwIfAborted(signal);
    const requestedMuted = desiredModes.muted;
    let blocked = false;
    video.muted = requestedMuted;
    try {
      await video.play();
    } catch (error) {
      throwIfAborted(signal);
      if (requestedMuted) throw error;
      blocked = true;
      video.muted = true;
      await video.play();
    }
    throwIfAborted(signal);
    video.dataset.bcPlaybackBlocked = blocked ? "true" : "false";
    return blocked;
  }

  async function startCandidatePlayback(video, signal, timeoutMs) {
    const playbackController = new AbortController();
    const parentAborted = () => playbackController.abort();
    signal?.addEventListener?.("abort", parentAborted, { once: true });
    let timer = null;
    let abortListener = null;
    const playback = playWithPreference(video, playbackController.signal);
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(describeVideoState(video, "等待视频开始播放超时")));
        playbackController.abort();
      }, timeoutMs);
      abortListener = () => reject(abortError());
      playbackController.signal.addEventListener("abort", abortListener, { once: true });
    });
    if (signal?.aborted) parentAborted();
    try {
      // The play() promise itself resolves only after playback has started, so
      // a second playing-event waiter would create an orphaned promise race.
      return await Promise.race([playback, deadline]);
    } catch (error) {
      playbackController.abort();
      try {
        video.pause();
      } catch {
        /* best effort: disposeSlot will release src as the final guard */
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", parentAborted);
      if (abortListener) {
        playbackController.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  function disposeVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    try {
      video.pause();
    } catch {
      /* best effort */
    }
    const objectUrl = video.dataset?.bcObjectUrl;
    if (
      objectUrl &&
      typeof URL !== "undefined" &&
      typeof URL.revokeObjectURL === "function"
    ) {
      URL.revokeObjectURL(objectUrl);
    }
    try {
      video.removeAttribute("src");
      video.srcObject = null;
      video.load();
    } catch {
      /* detached or already released */
    }
  }

  function disposeSlot(slot) {
    if (!slot) return;
    for (const video of slot.querySelectorAll?.("video") ?? []) disposeVideo(video);
    for (const image of slot.querySelectorAll?.("img") ?? []) {
      releaseImage(image);
    }
    slot.remove?.();
  }

  function createSlot(payload, video = null) {
    const slot = document.createElement("div");
    slot.className = "beauticode-media-slot";
    slot.dataset.bcRole = "candidate";
    slot.dataset.bcMedia = payload.media;
    slot.dataset.bcGeneration = String(payload.generation);
    slot.dataset.bcImageUrl = payload.imageUrl;
    if (payload.videoUrl) slot.dataset.bcVideoUrl = payload.videoUrl;
    if (payload.media === "video") {
      const startAt = Number(payload.startAt);
      slot.dataset.bcStartAt = String(Number.isFinite(startAt) && startAt >= 0 ? startAt : 0);
    }
    if (video) {
      video.className = "beauticode-media-video";
      slot.append(video);
    }
    return slot;
  }

  function slotMatchesPayload(slot, payload) {
    if (!slot || slot !== mountedCurrentSlot() || slot.dataset.bcMedia !== payload.media) {
      return false;
    }
    if (payload.media !== "video") {
      if (slot.dataset.bcImageUrl !== payload.imageUrl) return false;
      const image = slot.querySelector?.("img");
      return Boolean(
        image?.isConnected === true &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0,
      );
    }
    if (slot.dataset.bcVideoUrl !== payload.videoUrl) return false;
    const video = slot.querySelector?.("video");
    if (
      !(video instanceof HTMLVideoElement) ||
      video.error ||
      video.ended ||
      video.paused ||
      video.seeking ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return false;
    }
    // A local re-import can keep the exact same video handle while producing a
    // new poster token and resetting startAt. Reuse the live decoder; the
    // caller updates the poster metadata and seeks in place when needed.
    return true;
  }

  function updateCommittedDom(payload) {
    document.documentElement.dataset.bcGeneration = String(payload.generation);
    document.documentElement.removeAttribute("data-bc-pending-generation");
    if (payload.media === "clear") {
      document.documentElement.removeAttribute("data-bc-active");
      document.documentElement.removeAttribute("data-bc-media");
      document.documentElement.removeAttribute("data-bc-video-ready");
      return;
    }
    document.documentElement.dataset.bcActive = "true";
    document.documentElement.dataset.bcMedia = payload.media;
    if (payload.media === "video") document.documentElement.dataset.bcVideoReady = "true";
    else document.documentElement.removeAttribute("data-bc-video-ready");
  }

  function discardCandidates() {
    const node = document.getElementById("beauticode-bg-stage");
    if (!node) return;
    node.removeAttribute("data-bc-transitioning");
    node.removeAttribute("data-bc-empty");
    for (const slot of
      node.querySelectorAll?.('.beauticode-media-slot[data-bc-role="candidate"]') ?? []) {
      disposeSlot(slot);
    }
  }

  function attachCandidate(slot, payload) {
    const node = stage();
    discardCandidates();
    const previous = mountedCurrentSlot();
    slot.dataset.bcRole = "candidate";
    node.append(slot);
    if (!previous) {
      node.dataset.bcEmpty = "true";
      document.documentElement.dataset.bcActive = "true";
      document.documentElement.dataset.bcMedia =
        payload.media === "video" ? "video-pending" : payload.media;
      document.documentElement.removeAttribute("data-bc-video-ready");
    }
  }

  function nextFrame(signal) {
    if (typeof requestAnimationFrame !== "function") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let request = null;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (request != null && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(request);
        }
        signal?.removeEventListener?.("abort", aborted);
      };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => {
        finish(abortError());
      };
      request = requestAnimationFrame(() => {
        request = null;
        if (signal?.aborted) finish(abortError());
        else finish();
      });
      // Background or power-saved Chromium pages may suspend rAF entirely.
      // A short timer keeps the transaction bounded without skipping aborts.
      timer = setTimeout(() => finish(), FRAME_FALLBACK_MS);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function waitForCrossfade(slot, signal) {
    if (reducedMotionMedia?.matches) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        slot.removeEventListener("transitionend", ended);
        signal?.removeEventListener?.("abort", aborted);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const ended = (event) => {
        if (event.target === slot && (!event.propertyName || event.propertyName === "opacity")) finish();
      };
      const aborted = () => finish(abortError());
      const timer = setTimeout(() => finish(), CROSSFADE_MS + 80);
      slot.addEventListener("transitionend", ended);
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  async function commitCandidate(payload, slot, signal, remainingMs = () => Infinity) {
    throwIfAborted(signal);
    const node = stage();
    const previous = mountedCurrentSlot();
    const canAnimate =
      previous &&
      reducedMotionMedia?.matches !== true &&
      document.visibilityState === "visible" &&
      remainingMs() > CROSSFADE_MS + FRAME_FALLBACK_MS * 2 + 250;
    if (canAnimate) {
      await nextFrame(signal);
      await nextFrame(signal);
      throwIfAborted(signal);
      node.dataset.bcTransitioning = "true";
      await waitForCrossfade(previous, signal);
    }
    throwIfAborted(signal);
    if (previous && previous !== slot) disposeSlot(previous);
    slot.dataset.bcRole = "current";
    node.removeAttribute("data-bc-transitioning");
    node.removeAttribute("data-bc-empty");
    currentSlot = slot;
    committedPayload = payload;
    const video = activeVideo();
    playbackBlocked = video?.dataset?.bcPlaybackBlocked === "true";
    updateCommittedDom(payload);
    syncGallery(payload);
  }

  function restoreCommittedDom() {
    const node = document.getElementById("beauticode-bg-stage");
    node?.removeAttribute("data-bc-transitioning");
    node?.removeAttribute("data-bc-empty");
    if (committedPayload && mountedCurrentSlot()) {
      updateCommittedDom(committedPayload);
      playbackBlocked = activeVideo()?.dataset?.bcPlaybackBlocked === "true";
      return;
    }
    node?.remove();
    document.documentElement.removeAttribute("data-bc-active");
    document.documentElement.removeAttribute("data-bc-media");
    document.documentElement.removeAttribute("data-bc-video-ready");
  }

  function syncGallery(payload) {
    const on = payload?.atmosphere?.preset === "gallery";
    try {
      const sync = globalThis.BeauticodeAtmosphere?.setWindowMode?.(on ? "on" : "closed");
      if (sync && typeof sync.then === "function") void sync.catch(() => {});
    } catch {
      /* Atmosphere is optional and must never invalidate a rendered background. */
    }
  }

  async function applyBackground(payload, signal) {
    throwIfAborted(signal);
    const applyDeadline = performance.now() + CLIENT_APPLY_DEADLINE_MS;
    const remaining = () => Math.max(1, applyDeadline - performance.now());
    if (payload.media === "clear") {
      desiredModes.fish = false;
      playbackBlocked = false;
      document.documentElement.removeAttribute("data-bc-fish");
      discardCandidates();
      disposeSlot(currentSlot);
      currentSlot = null;
      committedPayload = payload;
      document.getElementById("beauticode-bg-stage")?.remove();
      updateCommittedDom(payload);
      syncGallery(payload);
      if (document.documentElement.dataset.bcGallery === "true") {
        document.documentElement.dataset.bcActive = "true";
      }
      await acknowledgeRender(payload, true, false);
      await acknowledgeMode();
      return;
    }
    if (typeof payload.imageUrl !== "string" || payload.imageUrl.length === 0) {
      await acknowledgeRender(payload, false, Boolean(mountedCurrentSlot()), "图片载荷无效");
      return;
    }
    let reusable = slotMatchesPayload(currentSlot, payload);
    if (reusable && payload.media === "video") {
      try {
        const reusableVideo = activeVideo();
        const requestedStartAt = Number(payload.startAt);
        const normalizedStartAt =
          Number.isFinite(requestedStartAt) && requestedStartAt >= 0 ? requestedStartAt : 0;
        const appliedStartAt = Number(currentSlot.dataset.bcStartAt);
        if (
          !Number.isFinite(appliedStartAt) ||
          Math.abs(appliedStartAt - normalizedStartAt) >= 0.25
        ) {
          const nextStartAt = seekVideo(reusableVideo, normalizedStartAt);
          currentSlot.dataset.bcStartAt = String(nextStartAt);
          await waitForSeek(reusableVideo, signal, remaining());
          await waitForVideo(reusableVideo, signal, remaining());
          await waitForPresentedFrame(reusableVideo, signal, remaining());
        } else {
          await waitForStablePlayback(reusableVideo, signal, Math.min(750, remaining()));
        }
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        reusable = false;
      }
    }
    if (reusable) {
      committedPayload = payload;
      currentSlot.dataset.bcGeneration = String(payload.generation);
      currentSlot.dataset.bcImageUrl = payload.imageUrl;
      if (payload.videoUrl) currentSlot.dataset.bcVideoUrl = payload.videoUrl;
      updateCommittedDom(payload);
      syncGallery(payload);
      await acknowledgeRender(payload, true, true);
      await acknowledgeMode();
      return;
    }
    let candidate = null;
    let candidateVideo = null;
    let committed = false;
    try {
      await waitForDshStructure(signal, remaining());
      if (payload.media === "image") {
        candidate = createSlot(payload);
        attachCandidate(candidate, payload);
        const image = await loadImage(candidate, payload.imageUrl, signal, remaining());
        throwIfAborted(signal);
        if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) throw new Error("图片尺寸无效");
        await commitCandidate(payload, candidate, signal, remaining);
        committed = true;
        await acknowledgeRender(payload, true, true);
        await acknowledgeMode();
        return;
      }
      if (payload.media !== "video" || typeof payload.videoUrl !== "string") {
        throw new Error("视频载荷无效");
      }
      const video = document.createElement("video");
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      // Set mute before src so Chromium may start the request immediately
      // without waiting for an audible autoplay decision.
      video.defaultMuted = true;
      video.muted = desiredModes.muted;
      video.setAttribute("muted", "");
      candidate = createSlot(payload, video);
      attachCandidate(candidate, payload);
      candidateVideo = video;
      video.src = payload.videoUrl;
      video.load();
      // Start the real media request before the diagnostic Range probe. During
      // a cold Chromium/decoder start, serial probing used part of the same
      // eight-second budget without advancing the frame that users can see.
      const sourceProbe = probeVideoSource(
        payload.videoUrl,
        signal,
        Math.min(VIDEO_PROBE_TIMEOUT_MS, remaining()),
      );
      const imageReady = loadImage(candidate, payload.imageUrl, signal, remaining());
      // play() is deliberately started alongside media readiness. Chromium is
      // allowed to ignore preload=auto for hidden/background media; waiting for
      // canplay before play() creates a circular stall at readyState=0.
      await Promise.all([
        sourceProbe,
        imageReady,
        waitForVideo(video, signal, remaining()),
        startCandidatePlayback(video, signal, remaining()),
      ]);
      throwIfAborted(signal);
      const appliedStartAt = seekVideo(video, payload.startAt);
      candidate.dataset.bcStartAt = String(appliedStartAt);
      await waitForSeek(video, signal, remaining());
      await waitForVideo(video, signal, remaining());
      // Transaction success means one frame was actually presented. Longer
      // three-frame stability remains useful for reusing an existing slot, but
      // must not turn a healthy cold decoder into a false first-frame failure.
      await waitForPresentedFrame(video, signal, remaining());
      throwIfAborted(signal);
      candidate.dataset.bcVideoReady = "true";
      await commitCandidate(payload, candidate, signal, remaining);
      committed = true;
      const visible = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused;
      await acknowledgeRender(payload, visible, visible, visible ? null : "视频未开始播放");
      await acknowledgeMode();
    } catch (error) {
      if (candidateVideo && candidateVideo.parentElement !== candidate) {
        disposeVideo(candidateVideo);
        candidateVideo.remove?.();
      }
      if (candidate && !committed) disposeSlot(candidate);
      if (isAbortError(error) || signal?.aborted || activePayload !== payload) return;
      restoreCommittedDom();
      await acknowledgeRender(
        payload,
        false,
        Boolean(currentSlot),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function scheduleBackground(payload) {
    if (!Number.isSafeInteger(payload?.generation)) return;
    // EventSource reconnects can replay the current frame while its first
    // render is still in flight. Restarting the same generation would discard
    // a healthy cold media request and move its deadline indefinitely.
    if (
      applyController &&
      activePayload?.generation === payload.generation &&
      activePayload?.media === payload.media
    ) {
      return;
    }
    if (
      Number.isSafeInteger(activePayload?.generation) &&
      payload.generation < activePayload.generation
    ) {
      return;
    }
    applyController?.abort();
    discardCandidates();
    const controller = new AbortController();
    applyController = controller;
    activePayload = payload;
    renderPhase = "pending";
    document.documentElement.dataset.bcPendingGeneration = String(payload.generation);
    void applyBackground(payload, controller.signal)
      .catch(async (error) => {
        if (isAbortError(error) || controller.signal.aborted || activePayload !== payload) return;
        restoreCommittedDom();
        await acknowledgeRender(
          payload,
          false,
          Boolean(mountedCurrentSlot()),
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (applyController !== controller) return;
        applyController = null;
        document.documentElement.removeAttribute("data-bc-pending-generation");
      })
      .catch(() => {});
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
    const candidate = pendingVideo();
    if (candidate instanceof HTMLVideoElement) candidate.muted = desiredModes.muted;
    if (video instanceof HTMLVideoElement) {
      try {
        playbackBlocked = await playWithPreference(video);
      } catch {
        playbackBlocked = desiredModes.muted === false;
      }
      if (
        committedPayload?.media === "video" &&
        activePayload === committedPayload &&
        renderPhase === "ready"
      ) {
        await acknowledgeRender(committedPayload, true, true);
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
      if (payload?.type === "mode") void applyModes(payload).catch(() => {});
      else if (payload?.type === "apply") scheduleBackground(payload);
    } catch {
      /* EventSource will continue with the next valid frame. */
    }
  };

  setInterval(() => {
    if (
      !committedPayload ||
      activePayload !== committedPayload ||
      renderPhase !== "ready"
    ) {
      return;
    }
    if (committedPayload.media === "clear") {
      void acknowledgeRender(committedPayload, true, false).catch(() => {});
      return;
    }
    const slot = mountedCurrentSlot();
    if (!slot) return;
    if (committedPayload.media === "image") {
      const image = slot.querySelector?.("img");
      if (
        image?.isConnected === true &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.naturalHeight > 0
      ) {
        void acknowledgeRender(committedPayload, true, true).catch(() => {});
      }
      return;
    }
    const video = activeVideo();
    if (
      committedPayload.media === "video" &&
      video instanceof HTMLVideoElement
    ) {
      // A heartbeat is observational, not a second render verdict. Playback can
      // briefly pause while Chromium changes modes or refills an 8K buffer; do
      // not downgrade an already-rendered generation or fail a pending one.
      void acknowledgeRender(committedPayload, true, true).catch(() => {});
    }
  }, 1_000);
})();

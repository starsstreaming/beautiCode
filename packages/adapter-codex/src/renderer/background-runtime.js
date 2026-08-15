/**
 * beautiCode background runtime — injected into the host renderer.
 * Background layer only. Generation-guarded video lifecycle.
 *
 * Anti-flicker (Codex-Dream-Skin session 019fa31c / PR #290 lineage):
 *   1. Same-generation reinject is a no-op when already healthy (watch loop
 *      must not rebuild a playable stage every poll).
 *   2. Cross-generation handoff keeps the previous playable <video> mounted
 *      until the replacement has a decoded frame; strip poster after ready.
 *   3. Detach superseded listeners on handoff so old error/visibility handlers
 *      cannot restart or fail the handed-off node.
 *   4. Transient abort/network/hidden errors retry; never race to a poster-only
 *      state while a frame is still valid. Hidden pages freeze the retry
 *      budget (the "flash then stick on image" root cause).
 *   5. Never wipe the stage while a handed-off video is covering.
 *
 * Codex Desktop CSP (app://):
 *   img-src / media-src: 'self' app: blob: data:  (NO http://127.0.0.1)
 *   connect-src: 'self' + openai hosts only        (NO loopback fetch)
 * So media MUST arrive as data: or blob: URLs.
 */
((cssText, imageDataUrl, videoConfig, generation, imageUrl, forceRebuild) => {
  const STAGE_ID = "beauticode-bg-stage";
  const STYLE_ID = "beauticode-bg-style";
  const VIDEO_INPUT_ID = "beauticode-video-input";
  const gen = Number(generation) || 0;

  const toChineseMediaError = (error) => {
    const message = String(error?.message || error || "").trim();
    if (/^(?:failed to fetch|fetch failed|fail fetch)$/i.test(message)) {
      return "未发现注入CDP的Codex进程";
    }
    if (/media fetch failed/i.test(message)) {
      return "背景媒体加载失败。";
    }
    if (/data url fetch failed/i.test(message)) {
      return "背景数据加载失败。";
    }
    if (/missing (?:media )?url|no video source/i.test(message)) {
      return "背景媒体地址缺失。";
    }
    if (/malformed data url/i.test(message)) {
      return "背景数据地址格式错误。";
    }
    if (/stale generation/i.test(message)) {
      return "背景版本已过期，正在重新加载。";
    }
    return message || "背景媒体加载失败。";
  };

  const root = document.documentElement;
  const previous = window.__BEAUTICODE_BG__;

  // ---- Same-generation short-circuit (critical anti-flash) ----
  // The tray watch loop re-publishes the active payload every ~1s. Rebuilding
  // the stage on every poll creates stacked <video> nodes + poster flashes.
  if (
    !forceRebuild &&
    previous &&
    previous.generation === gen &&
    typeof previous.snapshot === "function"
  ) {
    try {
      const snap = previous.snapshot();
      const wantsVideo = Boolean(
        videoConfig &&
          typeof videoConfig === "object" &&
          (videoConfig.mode === "blob" ||
            videoConfig.dataUrl ||
            videoConfig.srcUrl ||
            videoConfig.url),
      );
      const wantsClear = !imageDataUrl && !imageUrl && !wantsVideo;
      const healthyVideo =
        wantsVideo &&
        snap &&
        snap.active &&
        snap.videoReady &&
        !snap.videoFailed &&
        snap.hasVideo;
      const healthyImage =
        !wantsVideo &&
        !wantsClear &&
        snap &&
        snap.active &&
        snap.hasImage &&
        snap.media === "image";
      const healthyClear = wantsClear && snap && !snap.active && !snap.hasStage;
      if (healthyVideo || healthyImage || healthyClear) {
        // Refresh CSS text in place (style edits) without touching media.
        try {
          let style = document.getElementById(STYLE_ID);
          if (!style) {
            style = document.createElement("style");
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
          }
          if (typeof cssText === "string") style.textContent = cssText;
        } catch (_) {}
        return { skipped: true, generation: gen, reason: "same-generation" };
      }
    } catch (_) {
      /* fall through and rebuild */
    }
  }

  // Capture previous playable video before dispose.
  // Cross-generation always hands off. Same-generation rebuild (short-circuit
  // failed because stage was unhealthy) also hands off so we do not flash
  // poster while re-attaching the blob.
  let handedOffVideo = null;
  const canHandoff =
    previous && typeof previous.handoffVideo === "function";
  if (canHandoff) {
    try {
      const ho = previous.handoffVideo();
      // Only preserve a playable frame. Empty pending shells must be dropped
      // so cold blob re-attach does not stack two <video> nodes.
      if (ho && ho.video && ho.ready) {
        handedOffVideo = {
          stage: ho.stage || null,
          video: ho.video,
          objectUrl: ho.objectUrl || null,
          ready: true,
          preserve: true,
        };
      } else if (ho && ho.video) {
        // Tear down the non-ready shell immediately; we will rebuild.
        try {
          ho.video.pause?.();
        } catch (_) {}
        try {
          ho.video.removeAttribute?.("src");
          ho.video.removeAttribute?.("poster");
          ho.video.load?.();
        } catch (_) {}
        try {
          ho.video.remove?.();
        } catch (_) {}
        if (ho.objectUrl) {
          try {
            URL.revokeObjectURL(ho.objectUrl);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  // Always dispose the previous runtime when rebuilding — including same-gen
  // unhealthy rebuilds. Leaving old listeners attached was a flash source
  // (session 019fa31c / Dream Skin detachBackgroundVideoListeners).
  if (previous && typeof previous.dispose === "function") {
    try {
      previous.dispose({
        handoff: Boolean(handedOffVideo) || Boolean(videoConfig),
      });
    } catch (_) {}
  }

  const normalizedVideo =
    videoConfig && typeof videoConfig === "object" ? videoConfig : null;
  const videoMode =
    normalizedVideo?.mode === "blob"
      ? "blob"
      : normalizedVideo?.mode === "server"
        ? "server"
        : normalizedVideo?.mode === "data"
          ? "data"
          : null;
  const videoDataUrl =
    typeof normalizedVideo?.dataUrl === "string" && normalizedVideo.dataUrl
      ? normalizedVideo.dataUrl
      : null;
  const videoSrcRemote =
    typeof normalizedVideo?.srcUrl === "string"
      ? normalizedVideo.srcUrl
      : typeof normalizedVideo?.url === "string"
        ? normalizedVideo.url
        : null;
  const videoToken =
    typeof normalizedVideo?.token === "string" ? normalizedVideo.token : null;
  const videoEnabled = Boolean(
    videoMode === "blob" || videoDataUrl || videoSrcRemote,
  );

  const dataImageUrl =
    typeof imageDataUrl === "string" && imageDataUrl ? imageDataUrl : null;
  const remoteImageUrl =
    typeof imageUrl === "string" && imageUrl ? imageUrl : null;

  let disposed = false;
  let videoReady = false;
  let videoFailed = false;
  let videoError = null;
  let imageFailed = false;
  let imageObjectUrl = null;
  let videoObjectUrl = null;
  let videoEl = null;
  let stageEl = null;
  let imgEl = null;
  let resolvedPoster = dataImageUrl;
  let videoListeners = null; // { video, handlers, visibility }
  let retryTimer = null;
  let retryCount = 0;
  let pendingPlay = false;
  let lastPlaybackTime = -1;
  const MAX_RETRY = 20;

  // Fish mode (摸鱼): hide host chrome content, full-bleed media at native
  // brightness. Attribute-only — never rebuilds media. Survives same-gen
  // short-circuit (setFishMode API) and cross-gen reinject (preserve below).
  let fishMode = false;
  try {
    if (previous && typeof previous.isFishMode === "function") {
      fishMode = Boolean(previous.isFishMode());
    } else if (root.getAttribute("data-bc-fish") === "true") {
      fishMode = true;
    }
  } catch (_) {
    fishMode = false;
  }

  // Video mute preference (default muted). Independent of fish mode.
  // Start playback muted for autoplay policy, then unmute if preferred.
  // Process-local via previous runtime; not persisted across tray restarts.
  let videoMuted = true;
  try {
    if (previous && typeof previous.isMuted === "function") {
      videoMuted = Boolean(previous.isMuted());
    }
  } catch (_) {
    videoMuted = true;
  }

  // Background tone is a CSS-only preference. Keep dark as the legacy
  // default, and carry the preference across same-generation/rebuild paths.
  const normalizeTone = (value) =>
    value === "light" || value === "auto" ? value : "dark";
  let backgroundTone = "dark";
  try {
    if (previous && typeof previous.getBackgroundTone === "function") {
      backgroundTone = normalizeTone(previous.getBackgroundTone());
    } else {
      backgroundTone = normalizeTone(root.getAttribute("data-bc-tone"));
    }
  } catch (_) {
    backgroundTone = "dark";
  }

  // Optional initial seek for saved-theme restore (seconds). Applied once when
  // the live <video> has metadata. Invalid / past end → 0 (start over).
  let pendingStartAt = null;
  let startAtApplied = false;
  try {
    const rawStart =
      normalizedVideo && typeof normalizedVideo.startAt === "number"
        ? normalizedVideo.startAt
        : null;
    if (rawStart != null && Number.isFinite(rawStart) && rawStart > 0) {
      // Cap absurd values; host also clamps.
      pendingStartAt = Math.min(rawStart, 24 * 60 * 60);
    }
  } catch (_) {
    pendingStartAt = null;
  }

  // Focus dim: when the user is in a project/task thread (or the agent is
  // generating), set data-bc-working so CSS can slightly darken the RIGHT
  // main column only. LEFT sidebar + stage veil stay identical to home so
  // entering a project does not jump left-column brightness. Do NOT filter
  // the whole stage (that would shift art under the sidebar).
  // Media stays mounted and keeps playing — never pause/remove/hide the
  // <video>. Home/new-task stays bright. Fail open on detector errors.
  let working = false;
  let workObserver = null;
  let workPollTimer = null;
  let workRaf = 0;
  let workDebounceTimer = null;
  let workRouteHooked = false;
  const WORK_POLL_MS = 2000;
  const WORK_DEBOUNCE_MS = 200;
  const WORK_LABEL_RE =
    /^(stop|stop generating|stop response|cancel|abort|halt|停止|停止生成|取消|中止)$/i;
  const WORK_LABEL_LOOSE_RE =
    /\b(stop generating|stop response|stop run|stop task)\b|停止生成|停止响应/;

  const isCurrent = () =>
    !disposed &&
    window.__BEAUTICODE_BG__ &&
    window.__BEAUTICODE_BG__.generation === gen;

  const isDocHidden = () =>
    Boolean(
      (typeof document !== "undefined" &&
        (document.visibilityState === "hidden" || document.hidden)) ||
        false,
    );

  const revoke = (url) => {
    if (!url || typeof url !== "string" || !url.startsWith("blob:")) return;
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  };

  const clearRetry = () => {
    if (retryTimer) {
      try {
        clearTimeout(retryTimer);
      } catch (_) {}
      retryTimer = null;
    }
  };

  const setWorkingAttr = (next) => {
    working = Boolean(next);
    if (!resolvedPoster && !videoEnabled && !remoteImageUrl && !dataImageUrl) {
      root.removeAttribute("data-bc-working");
      return;
    }
    if (working) root.setAttribute("data-bc-working", "true");
    else root.removeAttribute("data-bc-working");
  };

  const textLooksLikeStop = (raw) => {
    if (!raw) return false;
    const t = String(raw).replace(/\s+/g, " ").trim();
    if (!t || t.length > 48) return false;
    if (WORK_LABEL_RE.test(t)) return true;
    if (WORK_LABEL_LOOSE_RE.test(t)) return true;
    return false;
  };

  const elLooksInteractive = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "button" || tag === "summary") return true;
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    if (role === "button" || role === "menuitem") return true;
    if (typeof el.closest === "function") {
      if (el.closest("button, [role='button'], [role='menuitem']")) return true;
    }
    return false;
  };

  const isVisibleEl = (el) => {
    if (!el || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect?.();
      if (r && (r.width < 1 || r.height < 1)) return false;
      const st =
        typeof window.getComputedStyle === "function"
          ? window.getComputedStyle(el)
          : null;
      if (
        st &&
        (st.display === "none" ||
          st.visibility === "hidden" ||
          Number(st.opacity) === 0)
      ) {
        return false;
      }
    } catch (_) {
      /* ignore */
    }
    return true;
  };

  /**
   * True on the Codex home / empty landing (bright art is welcome).
   * Uses the same home-icon hook already referenced by background.css.
   */
  const isHomeView = () => {
    try {
      const home = document.querySelector('[data-testid="home-icon"]');
      return Boolean(home && isVisibleEl(home));
    } catch (_) {
      return false;
    }
  };

  /**
   * True when a project task / conversation thread is open — the case the
   * user wants dimmed ("进入项目开始工作"). Prefer structural signals over
   * brittle chrome class names (#244).
   */
  const isTaskOrProjectView = () => {
    try {
      if (isHomeView()) return false;

      // Thread / message list (Codex desktop task conversation).
      const thread = document.querySelector(
        [
          ".thread-scroll-container",
          "[data-message-author-role]",
          '[data-testid*="conversation"]',
          '[data-testid*="thread"]',
          '[data-testid*="turn"]',
          'body > #root main [data-message-id]',
        ].join(", "),
      );
      if (thread && isVisibleEl(thread)) return true;

      // Open task header: folder glyph + title in the main app header
      // (matches the project task chrome in Codex Desktop).
      const header = document.querySelector(
        "body > #root main header.app-header-tint, body > #root main header",
      );
      if (header && isVisibleEl(header)) {
        const headerText = (header.textContent || "").replace(/\s+/g, " ").trim();
        // Home header is short / generic; task headers carry the task title.
        if (headerText.length >= 2 && !/^(codex|chatgpt|home|首页)?$/i.test(headerText)) {
          // Require composer or main role so empty shells do not false-dim.
          const workSurface = document.querySelector(
            "body > #root main .composer-surface-chrome, body > #root main [role='main'], body > #root main .thread-scroll-container",
          );
          if (workSurface && isVisibleEl(workSurface)) return true;
        }
      }

      // Sidebar: a selected project task row (not the "无任务" empty label).
      const selectedTask = document.querySelector(
        [
          'aside.app-shell-left-panel [aria-current="page"]',
          "aside.app-shell-left-panel [aria-selected='true']",
          "aside.app-shell-left-panel button[aria-pressed='true']",
          "aside.app-shell-left-panel a[aria-current='true']",
        ].join(", "),
      );
      if (selectedTask && isVisibleEl(selectedTask)) {
        const t = (selectedTask.textContent || "").replace(/\s+/g, " ").trim();
        if (t && !/^(无任务|no tasks?|new task|新建任务)$/i.test(t)) {
          // Only count as task view when main is not the home hero.
          if (!isHomeView()) return true;
        }
      }

      return false;
    } catch (_) {
      return false;
    }
  };

  /** Agent actively generating — keep as an extra dim trigger on any page. */
  const isAgentBusy = () => {
    try {
      const marked = document.querySelector(
        '[data-is-streaming="true"], [data-streaming="true"], [data-agent-running="true"], [data-bc-host-working="true"]',
      );
      if (marked) return true;

      const busyMain = document.querySelector(
        '[role="main"][aria-busy="true"], main[aria-busy="true"], [aria-busy="true"][data-message-author-role]',
      );
      if (busyMain) return true;

      const candidates = document.querySelectorAll(
        'button, [role="button"], [aria-label], [title]',
      );
      const limit = Math.min(candidates.length, 400);
      for (let i = 0; i < limit; i += 1) {
        const el = candidates[i];
        if (!el || !el.isConnected) continue;
        if (el.id === STAGE_ID || el.id === VIDEO_INPUT_ID) continue;
        if (stageEl && stageEl.contains(el)) continue;

        const aria = el.getAttribute?.("aria-label") || "";
        const title = el.getAttribute?.("title") || "";
        const text = (el.textContent || "").slice(0, 64);
        const hit =
          textLooksLikeStop(aria) ||
          textLooksLikeStop(title) ||
          textLooksLikeStop(text);
        if (!hit) continue;
        if (!elLooksInteractive(el) && !aria && !title) continue;
        // Layout/computed-style reads are expensive. Only do them after the
        // cheap text/attribute checks found a likely stop control.
        if (!isVisibleEl(el)) continue;
        return true;
      }

      const progress = document.querySelector(
        '[role="progressbar"][aria-valuenow], [role="status"]',
      );
      if (progress && progress.isConnected) {
        const label = (
          progress.getAttribute("aria-label") ||
          progress.textContent ||
          ""
        )
          .toLowerCase()
          .slice(0, 80);
        if (
          /generat|running|working|thinking|executing|in progress|生成|运行|思考|执行/.test(
            label,
          )
        ) {
          return true;
        }
      }
      return false;
    } catch (_) {
      return false;
    }
  };

  /**
   * Dim when inside a project/task thread, or while the agent is generating.
   * Home / new-task landing stays bright. Attribute on <html> only.
   */
  const detectWorking = () => {
    try {
      if (typeof document === "undefined" || !document.body) return false;
      if (isTaskOrProjectView()) return true;
      if (isAgentBusy()) return true;
      return false;
    } catch (_) {
      // Fail open: never dim on detector errors.
      return false;
    }
  };

  const refreshWorking = () => {
    if (!isCurrent()) return;
    const next = detectWorking();
    if (next !== working) {
      setWorkingAttr(next);
    }
  };

  const scheduleWorkingRefresh = () => {
    if (!isCurrent()) return;
    if (workDebounceTimer || workRaf) return;
    workDebounceTimer = setTimeout(() => {
      workDebounceTimer = null;
      try {
        workRaf = requestAnimationFrame(() => {
          workRaf = 0;
          refreshWorking();
        });
      } catch (_) {
        workRaf = 0;
        refreshWorking();
      }
    }, WORK_DEBOUNCE_MS);
  };

  const onRouteMaybeChanged = () => {
    scheduleWorkingRefresh();
  };

  const stopWorkingWatch = () => {
    if (workObserver) {
      try {
        workObserver.disconnect();
      } catch (_) {}
      workObserver = null;
    }
    if (workPollTimer) {
      try {
        clearInterval(workPollTimer);
      } catch (_) {}
      workPollTimer = null;
    }
    if (workRaf) {
      try {
        cancelAnimationFrame(workRaf);
      } catch (_) {}
      workRaf = 0;
    }
    if (workDebounceTimer) {
      try {
        clearTimeout(workDebounceTimer);
      } catch (_) {}
      workDebounceTimer = null;
    }
    if (workRouteHooked) {
      try {
        window.removeEventListener("popstate", onRouteMaybeChanged);
        window.removeEventListener("hashchange", onRouteMaybeChanged);
        window.removeEventListener("focus", onRouteMaybeChanged);
      } catch (_) {}
      workRouteHooked = false;
    }
    working = false;
    try {
      root.removeAttribute("data-bc-working");
    } catch (_) {}
  };

  const startWorkingWatch = () => {
    if (!isCurrent()) return;
    if (workObserver || workPollTimer) {
      scheduleWorkingRefresh();
      return;
    }
    try {
      if (typeof MutationObserver === "function" && document.body) {
        workObserver = new MutationObserver(() => {
          scheduleWorkingRefresh();
        });
        workObserver.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [
            "aria-label",
            "aria-busy",
            "aria-current",
            "aria-selected",
            "aria-pressed",
            "title",
            "data-is-streaming",
            "data-streaming",
            "data-agent-running",
            "data-bc-host-working",
            "data-message-author-role",
            "data-testid",
            "disabled",
            "hidden",
          ],
        });
      }
    } catch (_) {
      workObserver = null;
    }
    // Poll as a safety net (SPA swaps / closed shadow roots).
    try {
      workPollTimer = setInterval(() => {
        if (!isCurrent()) return;
        refreshWorking();
      }, WORK_POLL_MS);
      workPollTimer.unref?.();
    } catch (_) {
      workPollTimer = null;
    }
    if (!workRouteHooked) {
      try {
        window.addEventListener("popstate", onRouteMaybeChanged);
        window.addEventListener("hashchange", onRouteMaybeChanged);
        window.addEventListener("focus", onRouteMaybeChanged);
        workRouteHooked = true;
      } catch (_) {
        workRouteHooked = false;
      }
    }
    refreshWorking();
  };

  const hasBackgroundMedia = () =>
    Boolean(resolvedPoster || videoEnabled || remoteImageUrl || dataImageUrl);

  const applyFishAttr = () => {
    try {
      if (fishMode && hasBackgroundMedia()) {
        root.setAttribute("data-bc-fish", "true");
      } else {
        root.removeAttribute("data-bc-fish");
        if (!hasBackgroundMedia()) fishMode = false;
      }
    } catch (_) {}
  };

  const setFishMode = (enabled) => {
    if (!isCurrent()) return false;
    const want = Boolean(enabled);
    if (want && !hasBackgroundMedia()) {
      fishMode = false;
      applyFishAttr();
      return false;
    }
    fishMode = want;
    applyFishAttr();
    if (want) {
      // Light input guard: drop focus so typing is less likely to hit composer.
      try {
        const ae = document.activeElement;
        if (ae && typeof ae.blur === "function") ae.blur();
      } catch (_) {}
    }
    return true;
  };

  const listStageVideos = () => {
    const out = [];
    const stage = stageEl || document.getElementById(STAGE_ID);
    if (stage) {
      try {
        for (const v of stage.querySelectorAll("video")) {
          if (v && out.indexOf(v) === -1) out.push(v);
        }
      } catch (_) {}
    }
    if (videoEl && out.indexOf(videoEl) === -1) out.push(videoEl);
    return out;
  };

  /**
   * Apply preferred mute state to live <video> nodes.
   * Always starts from the preference; callers that need autoplay-safe cold
   * start should mute first, play, then call this again.
   */
  const applyMuteState = () => {
    const videos = listStageVideos();
    let anyStillMuted = false;
    for (const v of videos) {
      try {
        if (videoMuted) {
          v.muted = true;
          v.defaultMuted = true;
          v.setAttribute("muted", "");
        } else {
          v.muted = false;
          v.defaultMuted = false;
          v.removeAttribute("muted");
        }
        if (v.muted) anyStillMuted = true;
      } catch (_) {
        anyStillMuted = true;
      }
    }
    return {
      preferredMuted: Boolean(videoMuted),
      // Blocked only when we wanted sound but every/any live node stayed muted.
      blocked: !videoMuted && videos.length > 0 && anyStillMuted,
      hasVideo: videos.length > 0,
    };
  };

  /**
   * Set mute preference. Does not rebuild media.
   * Returns { ok, muted, blocked, hasVideo }.
   * muted = preferred state (true = silent). blocked = wanted sound but element stayed muted.
   */
  const setMuted = (muted) => {
    if (!isCurrent()) {
      return {
        ok: false,
        muted: Boolean(videoMuted),
        blocked: false,
        hasVideo: false,
      };
    }
    videoMuted = Boolean(muted);
    const applied = applyMuteState();
    return {
      ok: true,
      muted: Boolean(videoMuted),
      blocked: Boolean(applied.blocked),
      hasVideo: Boolean(applied.hasVideo),
    };
  };

  const setBackgroundTone = (tone) => {
    if (!isCurrent()) return false;
    backgroundTone = normalizeTone(tone);
    setAttrs();
    return true;
  };

  /**
   * Clamp a desired seek time against live duration.
   * Invalid / NaN / negative / past end → 0 (start over, per product rule).
   */
  const clampSeekSeconds = (sec, duration) => {
    const t = typeof sec === "number" ? sec : Number(sec);
    if (!Number.isFinite(t) || t <= 0) return 0;
    const d = typeof duration === "number" ? duration : Number(duration);
    if (Number.isFinite(d) && d > 0 && t >= d) return 0;
    if (t > 24 * 60 * 60) return 0;
    return t;
  };

  /**
   * Apply pendingStartAt once metadata is available. Fail-soft → 0.
   * Returns the seconds actually seeked to (or null if not yet applied).
   */
  const applyPendingStartAt = (video) => {
    if (startAtApplied || pendingStartAt == null) return null;
    if (!video || !isCurrent()) return null;
    let duration = NaN;
    try {
      duration = Number(video.duration);
    } catch (_) {
      duration = NaN;
    }
    // Wait for metadata when duration is still unknown.
    if (!(Number.isFinite(duration) && duration > 0) && (video.readyState || 0) < 1) {
      return null;
    }
    const target = clampSeekSeconds(pendingStartAt, duration);
    startAtApplied = true;
    pendingStartAt = null;
    try {
      video.currentTime = target;
    } catch (_) {
      try {
        video.currentTime = 0;
      } catch (_) {}
      return 0;
    }
    return target;
  };

  /** Current playback position for continuous theme progress writes. */
  const getPlaybackPosition = () => {
    if (!isCurrent()) {
      return { ok: false, currentTime: 0, duration: 0, hasVideo: false };
    }
    const videos = listStageVideos();
    const live =
      (videoEl && videoEl.isConnected && videoEl) ||
      videos[videos.length - 1] ||
      null;
    if (!live) {
      return { ok: true, currentTime: 0, duration: 0, hasVideo: false };
    }
    let currentTime = 0;
    let duration = 0;
    try {
      const t = Number(live.currentTime);
      if (Number.isFinite(t) && t >= 0) currentTime = t;
    } catch (_) {}
    try {
      const d = Number(live.duration);
      if (Number.isFinite(d) && d > 0) duration = d;
    } catch (_) {}
    return {
      ok: true,
      currentTime,
      duration,
      hasVideo: true,
    };
  };

  /**
   * Seek live video. Invalid / past end → 0. Does not rebuild media.
   */
  const seekTo = (seconds) => {
    if (!isCurrent()) {
      return { ok: false, currentTime: 0, hasVideo: false };
    }
    const videos = listStageVideos();
    const live =
      (videoEl && videoEl.isConnected && videoEl) ||
      videos[videos.length - 1] ||
      null;
    if (!live) {
      // Remember for when the blob attaches.
      const t = clampSeekSeconds(seconds, NaN);
      pendingStartAt = t > 0 ? t : null;
      startAtApplied = false;
      return { ok: true, currentTime: t, hasVideo: false };
    }
    let duration = NaN;
    try {
      duration = Number(live.duration);
    } catch (_) {
      duration = NaN;
    }
    const target = clampSeekSeconds(seconds, duration);
    startAtApplied = true;
    pendingStartAt = null;
    try {
      live.currentTime = target;
    } catch (_) {
      try {
        live.currentTime = 0;
      } catch (_) {}
      return { ok: true, currentTime: 0, hasVideo: true };
    }
    let now = target;
    try {
      const t = Number(live.currentTime);
      if (Number.isFinite(t)) now = t;
    } catch (_) {}
    return { ok: true, currentTime: now, hasVideo: true };
  };

  const setAttrs = () => {
    const active = Boolean(
      resolvedPoster || videoEnabled || remoteImageUrl || dataImageUrl,
    );
    if (!active) {
      root.removeAttribute("data-bc-active");
      root.removeAttribute("data-bc-media");
      root.removeAttribute("data-bc-video-ready");
      root.removeAttribute("data-bc-generation");
      root.removeAttribute("data-bc-working");
      root.removeAttribute("data-bc-fish");
      root.removeAttribute("data-bc-tone");
      fishMode = false;
      stopWorkingWatch();
      return;
    }
    root.setAttribute("data-bc-active", "true");
    // Keep media=video during handoff so CSS does not snap back to image-only
    // while the previous frame is still covering the stage.
    const handoffReady =
      videoEnabled &&
      !videoFailed &&
      !videoReady &&
      Boolean(handedOffVideo?.ready && handedOffVideo.video?.parentElement);
    const media =
      videoEnabled && !videoFailed
        ? videoReady || handoffReady
          ? "video"
          : "video-pending"
        : "image";
    root.setAttribute("data-bc-media", media);
    root.setAttribute(
      "data-bc-video-ready",
      videoReady || handoffReady ? "true" : "false",
    );
    root.setAttribute("data-bc-generation", String(gen));
    root.setAttribute("data-bc-tone", backgroundTone);
    if (working) root.setAttribute("data-bc-working", "true");
    else root.removeAttribute("data-bc-working");
    applyFishAttr();
  };

  const ensureStyle = () => {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = typeof cssText === "string" ? cssText : "";
  };

  const ensureStage = () => {
    // Prefer handed-off stage so the previous video node stays mounted.
    // IMPORTANT: use handedOffVideo.stage itself (not .parentElement) —
    // Dream Skin P1 bug was mistaking the parent shell for the stage.
    let stage =
      (handedOffVideo?.stage && handedOffVideo.stage.parentElement
        ? handedOffVideo.stage
        : null) || document.getElementById(STAGE_ID);
    if (!stage) {
      stage = document.createElement("div");
      stage.id = STAGE_ID;
      stage.setAttribute("aria-hidden", "true");
      const parent = document.body || document.documentElement;
      parent.insertBefore(stage, parent.firstChild);
    } else if (!stage.parentElement) {
      const parent = document.body || document.documentElement;
      parent.insertBefore(stage, parent.firstChild);
    }
    stage.id = STAGE_ID;
    stageEl = stage;
    return stage;
  };

  const clearStage = () => {
    const stage = document.getElementById(STAGE_ID);
    if (stage) stage.remove();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    stageEl = null;
    imgEl = null;
  };

  const detachVideoListeners = (bundle) => {
    if (!bundle) return;
    const { video, handlers, visibility } = bundle;
    if (video && handlers) {
      for (const [evt, fn] of Object.entries(handlers)) {
        try {
          video.removeEventListener(evt, fn);
        } catch (_) {}
      }
    }
    if (visibility) {
      try {
        document.removeEventListener("visibilitychange", visibility);
      } catch (_) {}
    }
  };

  const teardownVideo = (opts) => {
    clearRetry();
    // During handoff, leave the handed-out node alone — new generation owns it.
    // But ALWAYS detach listeners so the superseded runtime cannot restart it.
    if (opts && opts.skipElement && videoEl === opts.skipElement) {
      if (videoListeners && videoListeners.video === opts.skipElement) {
        detachVideoListeners(videoListeners);
        videoListeners = null;
      }
      videoEl = null;
      videoObjectUrl = null;
      return;
    }
    if (videoListeners) {
      detachVideoListeners(videoListeners);
      videoListeners = null;
    }
    if (videoEl) {
      try {
        videoEl.pause();
      } catch (_) {}
      try {
        videoEl.removeAttribute("src");
        videoEl.removeAttribute("poster");
        videoEl.load();
      } catch (_) {}
      try {
        videoEl.remove();
      } catch (_) {}
      videoEl = null;
    }
    revoke(videoObjectUrl);
    videoObjectUrl = null;
  };

  const teardownImageBlob = () => {
    revoke(imageObjectUrl);
    imageObjectUrl = null;
  };

  const releaseHandoff = () => {
    if (!handedOffVideo) return;
    const old = handedOffVideo;
    handedOffVideo = null;
    // Only remove if it is not the current video element.
    if (old.video && old.video !== videoEl) {
      try {
        old.video.pause();
      } catch (_) {}
      try {
        old.video.removeAttribute("src");
        old.video.load();
      } catch (_) {}
      try {
        old.video.remove();
      } catch (_) {}
      if (old.objectUrl && old.objectUrl !== videoObjectUrl) {
        revoke(old.objectUrl);
      }
    }
  };

  const dataUrlToObjectUrl = async (dataUrl) => {
    if (!dataUrl || typeof dataUrl !== "string") {
      throw new Error("missing data url");
    }
    if (dataUrl.startsWith("blob:")) return dataUrl;
    if (!dataUrl.startsWith("data:")) return dataUrl;
    try {
      const res = await fetch(dataUrl);
      if (!res.ok) throw new Error("data url fetch failed: " + res.status);
      const blob = await res.blob();
      if (!isCurrent()) throw new Error("stale generation");
      return URL.createObjectURL(blob);
    } catch (_) {
      const comma = dataUrl.indexOf(",");
      if (comma < 0) throw new Error("malformed data url");
      const meta = dataUrl.slice(0, comma);
      const payload = dataUrl.slice(comma + 1);
      const mimeMatch = /^data:([^;,]+)/i.exec(meta);
      const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
      const isBase64 = /;base64/i.test(meta);
      let bytes;
      if (isBase64) {
        const bin = atob(payload);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      } else {
        const decoded = decodeURIComponent(payload);
        bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i += 1) {
          bytes[i] = decoded.charCodeAt(i);
        }
      }
      if (!isCurrent()) throw new Error("stale generation");
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    }
  };

  const fetchAsObjectUrl = async (url, token) => {
    if (!url || typeof url !== "string") throw new Error("missing media url");
    if (url.startsWith("blob:")) return url;
    if (url.startsWith("data:")) return dataUrlToObjectUrl(url);
    const headers = {};
    if (token) headers["X-BeautiCode-Media-Token"] = token;
    const res = await fetch(url, {
      method: "GET",
      headers,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) throw new Error("media fetch failed: " + res.status);
    const blob = await res.blob();
    if (!isCurrent()) throw new Error("stale generation");
    return URL.createObjectURL(blob);
  };

  const markReady = () => {
    if (!isCurrent() || videoFailed || videoReady) return;
    videoReady = true;
    pendingPlay = false;
    retryCount = 0;
    clearRetry();
    try {
      if (videoEl) {
        // Reveal replacement only after a decoded frame.
        videoEl.style.opacity = "";
        // Poster on a live element reappears during stalls → image/video flash.
        videoEl.removeAttribute("poster");
      }
    } catch (_) {}
    // Theme resume: seek once metadata/frame is available (invalid → 0).
    try {
      if (videoEl) applyPendingStartAt(videoEl);
    } catch (_) {}
    // Re-assert mute preference once the video is actually playing.
    try {
      applyMuteState();
    } catch (_) {}
    setAttrs();
    // Drop the previous generation's video only after the new one is visible.
    releaseHandoff();
  };

  const markFailed = (error) => {
    if (!isCurrent() || videoFailed) return;
    videoFailed = true;
    videoReady = false;
    videoError = {
      name: error?.name || null,
      message: toChineseMediaError(error),
      mediaCode: videoEl?.error?.code ?? null,
      readyState: videoEl?.readyState ?? null,
    };
    clearRetry();
    try {
      if (videoEl) videoEl.style.opacity = "0";
    } catch (_) {}
    setAttrs();
    // On failure, keep handoff if it was ready so the prior frame stays up;
    // otherwise fall back to poster image.
    if (!handedOffVideo?.ready) {
      releaseHandoff();
    }
  };

  const isTransientVideoError = (error, video) => {
    if (isDocHidden()) {
      const message = String(error?.message || "").toLowerCase();
      if (
        error?.name === "AbortError" ||
        /background media|save power|paused/.test(message)
      ) {
        return true;
      }
      // Chromium can emit an empty media error while the app target is hidden.
      if (!video?.error && !message) return true;
      if (!video?.error && /failed to fetch|network|load|media/.test(message)) {
        return true;
      }
    }
    const code = video?.error?.code ?? null;
    // MEDIA_ERR_ABORTED (1), MEDIA_ERR_NETWORK (2), empty error object.
    return code === null || code === 1 || code === 2;
  };

  const retryTransientVideo = () => {
    if (!isCurrent() || videoFailed || !videoEl || !videoEl.src) return false;
    if (retryCount >= MAX_RETRY) return false;
    // Hidden Chromium suspends media — do not burn the finite retry budget.
    // visibilitychange will resume. Preserving videoReady avoids the
    // "flash then stick on image" failure mode from session 019fa31c.
    if (isDocHidden()) {
      pendingPlay = true;
      return true;
    }
    if (retryTimer) return true;
    retryCount += 1;
    pendingPlay = true;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!isCurrent() || videoFailed || !videoEl || !videoEl.src) return;
      if (isDocHidden()) {
        pendingPlay = true;
        return;
      }
      Promise.resolve(videoEl.play?.())
        .then(() => {
          if (!isCurrent() || videoFailed) return;
          pendingPlay = false;
          // play() is an alternate ready signal for shells that skip loadeddata.
          if (videoEl.readyState >= 2 || !videoEl.paused || videoEl.currentTime > 0) {
            markReady();
          }
        })
        .catch((err) => {
          if (!isCurrent()) return;
          if (isTransientVideoError(err, videoEl)) {
            retryTransientVideo();
            return;
          }
          markFailed(err);
        });
    }, 500);
    return true;
  };

  const onVisibility = () => {
    if (!isCurrent() || videoFailed) return;
    if (isDocHidden()) return;
    if (!videoEl || !videoEl.src) return;
    Promise.resolve(videoEl.play?.())
      .then(() => {
        if (!isCurrent() || videoFailed) return;
        pendingPlay = false;
        if (
          videoReady ||
          videoEl.readyState >= 2 ||
          !videoEl.paused ||
          videoEl.currentTime > 0
        ) {
          // Already-ready hidden video must stay ready (session 019fa31c).
          if (!videoReady) markReady();
          else setAttrs();
        }
      })
      .catch((err) => {
        if (!isCurrent()) return;
        if (isTransientVideoError(err, videoEl) && retryTransientVideo()) return;
        // Do not fail a previously-ready video on a single resume blip.
        if (videoReady) {
          pendingPlay = true;
          retryTransientVideo();
          return;
        }
        markFailed(err);
      });
  };

  const resolvePoster = async () => {
    if (dataImageUrl) {
      resolvedPoster = dataImageUrl;
      imageFailed = false;
      return resolvedPoster;
    }
    if (remoteImageUrl) {
      try {
        let token = null;
        try {
          token = new URL(remoteImageUrl, "http://127.0.0.1").searchParams.get(
            "t",
          );
        } catch (_) {}
        const obj = await fetchAsObjectUrl(remoteImageUrl, token);
        if (!isCurrent()) {
          revoke(obj);
          return null;
        }
        if (obj.startsWith("blob:")) imageObjectUrl = obj;
        resolvedPoster = obj;
        imageFailed = false;
        return resolvedPoster;
      } catch (_) {
        imageFailed = true;
      }
    }
    resolvedPoster = null;
    return null;
  };

  const createVideoInput = () => {
    let input = document.getElementById(VIDEO_INPUT_ID);
    if (input) return input;
    input = document.createElement("input");
    input.type = "file";
    input.id = VIDEO_INPUT_ID;
    input.accept = "video/mp4,.mp4";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    Object.assign(input.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
    });
    (document.body || document.documentElement).appendChild(input);
    return input;
  };

  const playVideoObjectUrl = async (video, objectUrl) => {
    if (!isCurrent() || videoFailed) return false;
    if (videoObjectUrl && videoObjectUrl !== objectUrl) revoke(videoObjectUrl);
    if (objectUrl.startsWith("blob:")) videoObjectUrl = objectUrl;
    try {
      // Cold start always muted so autoplay is not blocked; preference applied after.
      video.muted = true;
      video.defaultMuted = true;
      video.setAttribute("muted", "");
      video.playsInline = true;
      video.autoplay = true;
      video.loop = true;
    } catch (_) {}
    // Keep replacement hidden until first frame; handoff covers the gap.
    video.style.opacity = "0";
    // Do NOT call video.load() after src assign — it aborts and flashes poster.
    video.src = objectUrl;
    try {
      const p = video.play();
      if (p && typeof p.then === "function") {
        await p.catch(() => {});
      }
    } catch (_) {}
    // Apply user mute preference after play has a chance to start.
    try {
      applyMuteState();
    } catch (_) {}
    if (!isCurrent() || videoFailed) return false;
    if (video.readyState < 2) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          cleanup();
          resolve();
        };
        const cleanup = () => {
          try {
            video.removeEventListener("loadeddata", finish);
            video.removeEventListener("canplay", finish);
            video.removeEventListener("playing", finish);
            video.removeEventListener("error", finish);
          } catch (_) {}
        };
        video.addEventListener("loadeddata", finish, { once: true });
        video.addEventListener("canplay", finish, { once: true });
        video.addEventListener("playing", finish, { once: true });
        video.addEventListener("error", finish, { once: true });
        setTimeout(finish, 2500);
      });
      if (!isCurrent() || videoFailed) return false;
      if (video.paused && video.readyState >= 2) {
        try {
          const p2 = video.play();
          if (p2 && typeof p2.then === "function") await p2.catch(() => {});
        } catch (_) {}
      }
    }
    if (!isCurrent() || videoFailed) return false;
    if (video.readyState >= 2 || !video.paused || video.currentTime > 0) {
      markReady();
    } else {
      // Still decoding — keep pending; events / retry will reveal.
      pendingPlay = true;
      retryTransientVideo();
    }
    return Boolean(video.src);
  };

  const createVideoElement = (stage) => {
    // Keep at most one handed-off previous video; purge every other child
    // except the poster img we manage separately. Two playable nodes
    // alternate frames and posters (Dream Skin 7a3b2ec).
    const keepVideo =
      handedOffVideo?.video && handedOffVideo.video.parentElement === stage
        ? handedOffVideo.video
        : null;
    for (const child of [...(stage.children || [])]) {
      if (child === keepVideo) continue;
      if (child.tagName === "IMG") continue;
      const staleSrc = typeof child.src === "string" ? child.src : "";
      try {
        child.pause?.();
      } catch (_) {}
      try {
        child.removeAttribute?.("src");
        child.removeAttribute?.("poster");
        child.load?.();
      } catch (_) {}
      try {
        child.remove?.();
      } catch (_) {}
      if (staleSrc.startsWith("blob:")) revoke(staleSrc);
    }

    const video = document.createElement("video");
    // Create muted for autoplay policy; applyMuteState() runs after play paths.
    video.setAttribute("muted", "");
    video.setAttribute("autoplay", "");
    video.setAttribute("loop", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-hidden", "true");
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    // Pending replacement stays opacity 0; CSS + handoff keep prior frame.
    // data-bc-media="video" stays set during handoff — inline opacity blocks
    // the CSS rule from exposing this node (or its poster) early.
    video.style.opacity = "0";
    // Do NOT set video.poster when a separate <img> poster is on the stage.
    // Dual posters are the classic image/video alternate flash. The img covers
    // the gap; markReady strips any residual poster attr anyway.

    const onReady = () => {
      if (!isCurrent()) return;
      markReady();
    };
    const onError = (ev) => {
      // Detached / superseded videos must never fail the newer generation.
      if (!isCurrent()) return;
      const err = ev?.error || video.error || null;
      if (isTransientVideoError(err, video) && retryTransientVideo()) {
        return;
      }
      // If handoff still covers, stay pending rather than hard-fail to image.
      if (handedOffVideo?.ready) {
        pendingPlay = true;
        retryTransientVideo();
        return;
      }
      markFailed(err);
    };
    const onStalled = () => {
      if (!isCurrent() || videoFailed) return;
      pendingPlay = true;
      retryTransientVideo();
    };
    const onAbort = () => {
      if (!isCurrent() || videoFailed) return;
      // Abort during source swap is normal — never hard-fail.
      pendingPlay = true;
      retryTransientVideo();
    };
    const onEmptied = () => {
      if (!isCurrent() || videoFailed || !video.src) return;
      pendingPlay = true;
      retryTransientVideo();
    };
    const onEnded = () => {
      if (!isCurrent() || videoFailed || isDocHidden()) return;
      try {
        video.currentTime = 0;
      } catch (_) {}
      Promise.resolve(video.play?.())
        .then(() => {
          if (isCurrent()) {
            pendingPlay = false;
            if (!videoReady) markReady();
          }
        })
        .catch(() => {
          pendingPlay = true;
          retryTransientVideo();
        });
    };
    const onTimeUpdate = () => {
      if (!isCurrent() || videoFailed) return;
      const t = Number(video.currentTime);
      if (!Number.isFinite(t)) return;
      if (t < lastPlaybackTime || t - lastPlaybackTime >= 0.1) {
        lastPlaybackTime = t;
        retryCount = 0;
        pendingPlay = false;
        // timeupdate with progress is enough to reveal if events were missed.
        if (!videoReady && (video.readyState >= 2 || t > 0)) {
          markReady();
        }
      }
    };
    const onLoadedMetadata = () => {
      if (!isCurrent() || videoFailed) return;
      try {
        applyPendingStartAt(video);
      } catch (_) {}
    };

    const handlers = {
      loadeddata: onReady,
      canplay: onReady,
      playing: onReady,
      loadedmetadata: onLoadedMetadata,
      error: onError,
      stalled: onStalled,
      abort: onAbort,
      emptied: onEmptied,
      ended: onEnded,
      timeupdate: onTimeUpdate,
    };
    for (const [evt, fn] of Object.entries(handlers)) {
      video.addEventListener(evt, fn);
    }
    document.addEventListener("visibilitychange", onVisibility);
    videoListeners = { video, handlers, visibility: onVisibility };

    stage.appendChild(video);
    videoEl = video;
    return video;
  };

  const doAttachVideoFile = async () => {
    if (!isCurrent() || videoFailed) return false;
    const input = document.getElementById(VIDEO_INPUT_ID);
    const file = input && input.files && input.files[0] ? input.files[0] : null;
    if (!file) return false;
    const stage = ensureStage();
    let video = videoEl;
    if (!video || !video.isConnected) {
      video = createVideoElement(stage);
    }
    try {
      const objectUrl = URL.createObjectURL(file);
      return await playVideoObjectUrl(video, objectUrl);
    } catch (err) {
      if (isTransientVideoError(err, videoEl) && retryTransientVideo()) {
        return false;
      }
      if (handedOffVideo?.ready) {
        pendingPlay = true;
        retryTransientVideo();
        return false;
      }
      markFailed(err);
      return false;
    }
  };

  const startVideo = async (stage) => {
    const video = createVideoElement(stage);

    if (videoMode === "blob") {
      createVideoInput();
      // Prefer CDP file-input path. Optional tiny dataUrl is a warm start only.
      if (videoDataUrl) {
        try {
          let src = videoDataUrl;
          if (videoDataUrl.startsWith("data:")) {
            src = await dataUrlToObjectUrl(videoDataUrl);
            if (!isCurrent()) {
              revoke(src);
              return;
            }
            if (src.startsWith("blob:")) videoObjectUrl = src;
          }
          video.style.opacity = "0";
          video.src = src;
          try {
            const p = video.play();
            if (p && typeof p.then === "function") {
              p.then(() => {
                if (isCurrent() && (video.readyState >= 2 || !video.paused)) {
                  markReady();
                }
              }).catch(() => {});
            }
          } catch (_) {}
        } catch (_) {
          /* CDP attach is the real path */
        }
      }
      return;
    }

    let assigned = false;
    if (videoDataUrl) {
      try {
        let src = videoDataUrl;
        if (videoDataUrl.startsWith("data:")) {
          src = await dataUrlToObjectUrl(videoDataUrl);
          if (!isCurrent()) {
            revoke(src);
            return;
          }
          if (src.startsWith("blob:")) videoObjectUrl = src;
        }
        video.style.opacity = "0";
        video.src = src;
        assigned = true;
      } catch (_) {
        assigned = false;
      }
    }
    if (!assigned && videoSrcRemote) {
      try {
        const obj = await fetchAsObjectUrl(videoSrcRemote, videoToken);
        if (!isCurrent()) {
          revoke(obj);
          return;
        }
        if (obj.startsWith("blob:")) videoObjectUrl = obj;
        video.style.opacity = "0";
        video.src = obj;
        assigned = true;
      } catch (_) {
        assigned = false;
      }
    }
    if (!assigned && videoSrcRemote) {
      try {
        video.style.opacity = "0";
        video.src = videoSrcRemote;
        assigned = true;
      } catch (_) {
        assigned = false;
      }
    }
    if (!assigned) {
      markFailed(new Error("no video source"));
      return;
    }
    try {
      const p = video.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          if (isCurrent() && (video.readyState >= 2 || !video.paused)) {
            markReady();
          }
        }).catch((err) => {
          if (!isCurrent()) return;
          if (isTransientVideoError(err, video) && retryTransientVideo()) return;
          // keep pending if handoff covers
          if (handedOffVideo?.ready) {
            pendingPlay = true;
            retryTransientVideo();
            return;
          }
        });
      }
    } catch (_) {}
  };

  const ensurePosterImg = (stage) => {
    let img = stage.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.referrerPolicy = "no-referrer";
      stage.insertBefore(img, stage.firstChild);
    }
    img.addEventListener(
      "error",
      () => {
        if (!isCurrent()) return;
        imageFailed = true;
      },
      { once: true },
    );
    if (resolvedPoster && img.getAttribute("src") !== resolvedPoster) {
      img.src = resolvedPoster;
    }
    imgEl = img;
    return img;
  };

  const apply = async () => {
    if (!remoteImageUrl && !dataImageUrl && !videoEnabled) {
      teardownVideo();
      teardownImageBlob();
      releaseHandoff();
      clearStage();
      resolvedPoster = null;
      stopWorkingWatch();
      setAttrs();
      return;
    }

    ensureStyle();
    const stage = ensureStage();

    // Do NOT stage.innerHTML = "" — that kills the handed-off video and flashes.
    videoReady = false;
    videoFailed = false;
    videoError = null;
    imageFailed = false;
    retryCount = 0;
    pendingPlay = false;
    lastPlaybackTime = -1;
    clearRetry();

    await resolvePoster();
    if (!isCurrent()) return;

    ensurePosterImg(stage);
    // Attributes first: handoffReady keeps video CSS path while pending.
    setAttrs();
    startWorkingWatch();

    if (videoEnabled) {
      await startVideo(stage);
    } else {
      // Image-only: remove any leftover videos including handoff.
      releaseHandoff();
      if (videoListeners) {
        detachVideoListeners(videoListeners);
        videoListeners = null;
      }
      for (const child of [...(stage.children || [])]) {
        if (child.tagName === "VIDEO") {
          try {
            child.pause?.();
          } catch (_) {}
          try {
            child.removeAttribute?.("src");
            child.load?.();
          } catch (_) {}
          try {
            child.remove();
          } catch (_) {}
        }
      }
      videoEl = null;
    }
  };

  const api = {
    generation: gen,
    get videoReady() {
      return videoReady;
    },
    get videoFailed() {
      return videoFailed;
    },
    get videoError() {
      return videoError;
    },
    get imageFailed() {
      return imageFailed;
    },
    get pendingPlay() {
      return pendingPlay;
    },
    get media() {
      if (!resolvedPoster && !videoEnabled && !remoteImageUrl && !dataImageUrl) {
        return "clear";
      }
      return videoEnabled && !videoFailed ? "video" : "image";
    },
    ensureVideoInput() {
      if (!videoEnabled) return false;
      createVideoInput();
      return Boolean(document.getElementById(VIDEO_INPUT_ID));
    },
    attachVideoFile() {
      return doAttachVideoFile();
    },
    /**
     * Snapshot the current playable video for the next generation.
     * Caller must then dispose({handoff:true}) so we do not tear it down.
     * Listeners stay attached until the NEW generation's dispose/handoff path
     * detaches them via the previous.dispose({handoff}) call below — actually
     * we detach in dispose(handoff) so the old runtime cannot restart media.
     */
    handoffVideo() {
      const stage = stageEl || document.getElementById(STAGE_ID);
      const video = videoEl;
      if (!stage || !video || !video.parentElement) return null;
      const payload = {
        stage,
        video,
        objectUrl: videoObjectUrl,
        ready: videoReady && !videoFailed,
      };
      // Detach ownership so dispose won't revoke/remove these.
      videoEl = null;
      videoObjectUrl = null;
      return payload;
    },
    dispose(opts) {
      disposed = true;
      clearRetry();
      // Always stop working-state watchers; the next generation starts its own.
      // Do not leave MutationObservers / intervals from a superseded runtime.
      stopWorkingWatch();
      const handoff = Boolean(opts && opts.handoff);
      if (!handoff) {
        teardownVideo();
        releaseHandoff();
      } else {
        // Preserve decoded frame + object URL only. Superseded runtime must
        // not keep visibility/media listeners that can restart this node
        // (Dream Skin 7a3b2ec / session 019fa31c).
        if (videoListeners) {
          detachVideoListeners(videoListeners);
          videoListeners = null;
        }
        videoEl = null;
        // Do not revoke videoObjectUrl if handoff took it.
      }
      teardownImageBlob();
      try {
        const input = document.getElementById(VIDEO_INPUT_ID);
        if (input && !handoff) input.remove();
      } catch (_) {}
      if (!handoff) {
        clearStage();
        root.removeAttribute("data-bc-active");
        root.removeAttribute("data-bc-media");
        root.removeAttribute("data-bc-video-ready");
        root.removeAttribute("data-bc-generation");
        root.removeAttribute("data-bc-working");
        root.removeAttribute("data-bc-fish");
        root.removeAttribute("data-bc-tone");
        fishMode = false;
      }
      // handoff: leave data-bc-fish for the next generation to inherit.
    },
    isFishMode() {
      return Boolean(fishMode);
    },
    setFishMode(enabled) {
      return setFishMode(enabled);
    },
    isMuted() {
      return Boolean(videoMuted);
    },
    setMuted(muted) {
      return setMuted(muted);
    },
    isBackgroundTone() {
      return backgroundTone;
    },
    setBackgroundTone(tone) {
      return setBackgroundTone(tone);
    },
    /** Re-apply stored mute preference (used after CDP attach / heal). */
    applyMutePreference() {
      if (!isCurrent()) return { ok: false, muted: true, blocked: false, hasVideo: false };
      const applied = applyMuteState();
      return {
        ok: true,
        muted: Boolean(videoMuted),
        blocked: Boolean(applied.blocked),
        hasVideo: Boolean(applied.hasVideo),
      };
    },
    /** Current <video> currentTime/duration for theme progress persistence. */
    getPlaybackPosition() {
      return getPlaybackPosition();
    },
    /**
     * Seek live video (or remember for pending attach).
     * Invalid / past end → 0.
     */
    seekTo(seconds) {
      return seekTo(seconds);
    },
    snapshot() {
      const stage = document.getElementById(STAGE_ID);
      const img = stage ? stage.querySelector("img") : null;
      const videos = stage ? [...stage.querySelectorAll("video")] : [];
      // Prefer the current generation's element; fall back to any live node.
      const liveVideo =
        (videoEl && videoEl.isConnected && videoEl) ||
        videos[videos.length - 1] ||
        null;
      const cs = stage ? window.getComputedStyle(stage) : null;
      let imageNatural = 0;
      try {
        imageNatural = img && img.naturalWidth ? img.naturalWidth : 0;
      } catch (_) {
        imageNatural = 0;
      }
      // Own-generation readiness only. Handoff may keep data-bc-video-ready=true
      // for CSS continuity, but host health checks must not treat "previous
      // frame still covering" as "new blob attached" — that skips CDP attach
      // and sticks the switch on the old media.
      const ownVideoReady = Boolean(
        videoReady && !videoFailed && liveVideo && liveVideo === videoEl,
      );
      const ownSrc =
        liveVideo && typeof liveVideo.src === "string" ? liveVideo.src : "";
      const hasPlayableSrc =
        ownSrc.startsWith("blob:") || ownSrc.startsWith("data:");
      let elementMuted = true;
      try {
        if (liveVideo) elementMuted = Boolean(liveVideo.muted);
      } catch (_) {
        elementMuted = true;
      }
      return {
        generation: gen,
        active: root.getAttribute("data-bc-active") === "true",
        media: root.getAttribute("data-bc-media"),
        working: root.getAttribute("data-bc-working") === "true",
        fish: root.getAttribute("data-bc-fish") === "true",
        muted: Boolean(videoMuted),
        elementMuted,
        videoReady: ownVideoReady,
        videoFailed: Boolean(videoFailed),
        hasStage: Boolean(stage),
        hasImage: Boolean(img && img.getAttribute("src")),
        imageLoaded: imageNatural > 0,
        imageFailed: Boolean(imageFailed),
        hasVideo: Boolean(liveVideo),
        hasPlayableSrc,
        videoCount: videos.length,
        stagePointerEvents: cs ? cs.pointerEvents : null,
        horizontalOverflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
        documentHidden: Boolean(document.hidden),
        documentVisibility:
          typeof document.visibilityState === "string"
            ? document.visibilityState
            : null,
      };
    },
  };

  window.__BEAUTICODE_BG__ = api;
  Promise.resolve()
    .then(apply)
    .catch((err) => {
      if (isCurrent()) {
        imageFailed = true;
        markFailed(err);
      }
    });
  return { installed: true, generation: gen };
})

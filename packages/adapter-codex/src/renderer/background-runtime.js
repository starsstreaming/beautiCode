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
((cssText, imageDataUrl, videoConfig, generation, imageUrl, forceRebuild, imageBlob) => {
    const STAGE_ID = "beauticode-bg-stage";
    const STYLE_ID = "beauticode-bg-style";
    const VIDEO_INPUT_ID = "beauticode-video-input";
    const IMAGE_INPUT_ID = "beauticode-image-input";
    const gen = Number(generation) || 0;
    const wantImageBlob = Boolean(imageBlob);
    const root = document.documentElement;
    const previous = window.__BEAUTICODE_BG__;
    // ---- Same-generation short-circuit (critical anti-flash) ----
    // The tray watch loop re-publishes the active payload every ~1s. Rebuilding
    // the stage on every poll creates stacked <video> nodes + poster flashes.
    if (!forceRebuild &&
        previous &&
        previous.generation === gen &&
        typeof previous.snapshot === "function") {
        try {
            const snap = previous.snapshot();
            const wantsVideo = Boolean(videoConfig &&
                typeof videoConfig === "object" &&
                (videoConfig.mode === "blob" ||
                    videoConfig.dataUrl ||
                    videoConfig.srcUrl ||
                    videoConfig.url));
            const wantsClear = !imageDataUrl && !imageUrl && !wantsVideo && !wantImageBlob;
            const healthyVideo = wantsVideo &&
                snap &&
                snap.active &&
                snap.videoReady &&
                !snap.videoFailed &&
                snap.hasVideo;
            const healthyImage = !wantsVideo &&
                !wantsClear &&
                snap &&
                snap.active &&
                snap.hasImage &&
                snap.imageLoaded === true &&
                snap.imageFailed !== true &&
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
                    if (typeof cssText === "string")
                        style.textContent = cssText;
                }
                catch (_) { }
                // Same-gen republish used to leave a playable video at inline opacity:0.
                if (healthyVideo) {
                    try {
                        const v = document.querySelector("#beauticode-bg-stage video");
                        if (v) {
                            v.style.opacity = "";
                            v.removeAttribute("poster");
                        }
                    }
                    catch (_) { }
                }
                guest.setActive(Boolean(snap.active));
                return { skipped: true, generation: gen, reason: "same-generation" };
            }
        }
        catch (_) {
            /* fall through and rebuild */
        }
    }
    // Capture previous playable video before dispose.
    // Cross-generation always hands off. Same-generation rebuild (short-circuit
    // failed because stage was unhealthy) also hands off so we do not flash
    // poster while re-attaching the blob.
    let handedOffVideo = null;
    const canHandoff = previous && typeof previous.handoffVideo === "function";
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
            }
            else if (ho && ho.video) {
                // Tear down the non-ready shell immediately; we will rebuild.
                try {
                    ho.video.pause?.();
                }
                catch (_) { }
                try {
                    ho.video.removeAttribute?.("src");
                    ho.video.removeAttribute?.("poster");
                    ho.video.load?.();
                }
                catch (_) { }
                try {
                    ho.video.remove?.();
                }
                catch (_) { }
                if (ho.objectUrl) {
                    try {
                        URL.revokeObjectURL(ho.objectUrl);
                    }
                    catch (_) { }
                }
            }
        }
        catch (_) { }
    }
    // Always dispose the previous runtime when rebuilding — including same-gen
    // unhealthy rebuilds. Leaving old listeners attached was a flash source
    // (session 019fa31c / Dream Skin detachBackgroundVideoListeners).
    if (previous && typeof previous.dispose === "function") {
        try {
            previous.dispose({
                handoff: Boolean(handedOffVideo) || Boolean(videoConfig),
            });
        }
        catch (_) { }
    }
    const normalizedVideo = videoConfig && typeof videoConfig === "object" ? videoConfig : null;
    const videoMode = normalizedVideo?.mode === "blob"
        ? "blob"
        : normalizedVideo?.mode === "server"
            ? "server"
            : normalizedVideo?.mode === "data"
                ? "data"
                : null;
    const videoDataUrl = typeof normalizedVideo?.dataUrl === "string" && normalizedVideo.dataUrl
        ? normalizedVideo.dataUrl
        : null;
    const videoSrcRemote = typeof normalizedVideo?.srcUrl === "string"
        ? normalizedVideo.srcUrl
        : typeof normalizedVideo?.url === "string"
            ? normalizedVideo.url
            : null;
    const videoToken = typeof normalizedVideo?.token === "string" ? normalizedVideo.token : null;
    const videoEnabled = Boolean(videoMode === "blob" || videoDataUrl || videoSrcRemote);
    const dataImageUrl = typeof imageDataUrl === "string" && imageDataUrl ? imageDataUrl : null;
    const remoteImageUrl = typeof imageUrl === "string" && imageUrl ? imageUrl : null;
    let disposed = false, stageEl = null;
    const isCurrent = () => !disposed && window.__BEAUTICODE_BG__?.generation === gen;
    const isDocHidden = () => Boolean(document.hidden || document.visibilityState === "hidden");
    const sources = createMediaSources({ isCurrent });
    const { revoke } = sources;
    const image = createImageRuntime({ isCurrent, ensureStage: () => ensureStage(), setAttrs: () => setAttrs(), dataImageUrl, remoteImageUrl, sources });
    let video;
    const hasBackgroundMedia = () => Boolean(image.poster || videoEnabled || remoteImageUrl || dataImageUrl || wantImageBlob);
    const controls = createPlaybackControls({ root, previous, normalizedVideo, isCurrent, hasBackgroundMedia, getStage: () => stageEl, getVideo: () => video?.element, setAttrs: () => setAttrs() });
    const working = createWorkingState({ root, isCurrent, hasBackgroundMedia });
    video = createVideoRuntime({ isCurrent, isDocHidden, sources, controls, setAttrs: () => setAttrs(), ensureStage: () => ensureStage(), getHandoff: () => handedOffVideo, releaseHandoff: () => releaseHandoff(), videoMode, videoDataUrl, videoSrcRemote, videoToken });
    const setAttrs = () => {
        if (!isCurrent())
            return;
        const handoffReady = videoEnabled &&
            !video.failed &&
            !video.ready &&
            Boolean(handedOffVideo?.ready && handedOffVideo.video?.parentElement);
        // Never make the host transparent while a replacement is still decoding.
        // A cold first launch has no previous frame to cover the gap, so native
        // Codex chrome must remain visible until an image load or video frame is
        // confirmed.
        const imageReady = !videoEnabled &&
            !image.failed &&
            Boolean(image.element?.isConnected && image.element.complete && image.element.naturalWidth > 0);
        const mediaReady = videoEnabled
            ? (!video.failed && (video.ready || handoffReady))
            : imageReady;
        const active = mediaReady;
        if (!active) {
            root.removeAttribute("data-bc-active");
            guest.setActive(false);
            root.removeAttribute("data-bc-media");
            root.removeAttribute("data-bc-video-ready");
            root.removeAttribute("data-bc-generation");
            root.removeAttribute("data-bc-working");
            root.removeAttribute("data-bc-fish");
            root.removeAttribute("data-bc-tone");
            controls.resetFish();
            working.stop();
            return;
        }
        root.setAttribute("data-bc-active", "true");
        guest.setActive(true);
        // Keep media=video during handoff so CSS does not snap back to image-only
        // while the previous frame is still covering the stage.
        const media = videoEnabled && !video.failed
            ? video.ready || handoffReady
                ? "video"
                : "video-pending"
            : "image";
        root.setAttribute("data-bc-media", media);
        root.setAttribute("data-bc-video-ready", video.ready || handoffReady ? "true" : "false");
        root.setAttribute("data-bc-generation", String(gen));
        root.setAttribute("data-bc-tone", controls.tone);
        if (working.active)
            root.setAttribute("data-bc-working", "true");
        else
            root.removeAttribute("data-bc-working");
        controls.applyFishAttr();
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
        let stage = (handedOffVideo?.stage && handedOffVideo.stage.parentElement
            ? handedOffVideo.stage
            : null) || document.getElementById(STAGE_ID);
        if (!stage) {
            stage = document.createElement("div");
            stage.id = STAGE_ID;
            stage.setAttribute("aria-hidden", "true");
            const parent = document.body || document.documentElement;
            parent.insertBefore(stage, parent.firstChild);
        }
        else if (!stage.parentElement) {
            const parent = document.body || document.documentElement;
            parent.insertBefore(stage, parent.firstChild);
        }
        stage.id = STAGE_ID;
        stageEl = stage;
        return stage;
    };
    const clearStage = () => {
        const stage = document.getElementById(STAGE_ID);
        if (stage)
            stage.remove();
        const style = document.getElementById(STYLE_ID);
        if (style)
            style.remove();
        stageEl = null;
    };
    const releaseHandoff = () => {
        if (!handedOffVideo)
            return;
        const old = handedOffVideo;
        handedOffVideo = null;
        // Only remove if it is not the current video element.
        if (old.video && old.video !== video.element) {
            try {
                old.video.pause();
            }
            catch (_) { }
            try {
                old.video.removeAttribute("src");
                old.video.load();
            }
            catch (_) { }
            try {
                old.video.remove();
            }
            catch (_) { }
            if (old.objectUrl && old.objectUrl !== video.objectUrl) {
                revoke(old.objectUrl);
            }
        }
    };
    const apply = async () => {
        if (!remoteImageUrl && !dataImageUrl && !videoEnabled && !wantImageBlob) {
            video.dispose();
            image.dispose();
            releaseHandoff();
            clearStage();
            image.clear();
            working.stop();
            setAttrs();
            return;
        }
        ensureStyle();
        const stage = ensureStage();
        // Do NOT stage.innerHTML = "" — that kills the handed-off video and flashes.
        video.reset();
        image.reset();
        await image.resolvePoster();
        if (!isCurrent())
            return;
        const poster = image.ensurePosterImg(stage);
        // For a real image, wait for a decoded resource before switching the host
        // surface to transparent. Blob imports intentionally wait for their CDP
        // file-input attach path instead.
        if (!videoEnabled && !wantImageBlob) {
            const loaded = await image.waitForImageReady(poster);
            if (!isCurrent())
                return;
            if (!loaded) {
                image.fail();
                setAttrs();
                return;
            }
        }
        // Video remains native/visible until startVideo reports its first frame;
        // a ready handoff is the only permitted pending exception.
        setAttrs();
        working.start();
        if (videoEnabled) {
            await video.start(stage);
        }
        else {
            if (wantImageBlob)
                image.createImageInput();
            // Image-only: remove any leftover videos including handoff.
            releaseHandoff();
            for (const child of [...(stage.children || [])]) {
                if (child.tagName === "VIDEO") {
                    try {
                        child.pause?.();
                    }
                    catch (_) { }
                    try {
                        child.removeAttribute?.("src");
                        child.load?.();
                    }
                    catch (_) { }
                    try {
                        child.remove();
                    }
                    catch (_) { }
                }
            }
        }
    };
    const dispose = (opts = {}) => {
        if (disposed)
            return;
        disposed = true;
        working.stop();
        video.dispose(opts);
        image.dispose();
        if (!opts.handoff) {
            releaseHandoff();
            guest.dispose();
            window.__BEAUTICODE_THEME__?.stop();
            clearStage();
            for (const id of [VIDEO_INPUT_ID, IMAGE_INPUT_ID])
                document.getElementById(id)?.remove();
            for (const key of ["active", "media", "video-ready", "generation", "working", "fish", "tone"])
                root.removeAttribute("data-bc-" + key);
            controls.resetFish();
        }
    };
    const api = createBackgroundApi({ gen, root, getStage: () => stageEl, isCurrent, videoEnabled, remoteImageUrl, dataImageUrl, wantImageBlob, image, video, controls, dispose });
    window.__BEAUTICODE_BG__ = api;
    return Promise.resolve().then(apply).then(() => ({ installed: true, generation: gen })).catch(err => {
        if (isCurrent()) {
            image.fail();
            video.fail(err);
        }
        return { installed: true, generation: gen };
    });
})

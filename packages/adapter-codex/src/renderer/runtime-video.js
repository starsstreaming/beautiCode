/* Private state belongs to this module; callers receive operations and read-only views. */
(({ isCurrent, isDocHidden, sources, controls, setAttrs, ensureStage, getHandoff, releaseHandoff, videoMode, videoDataUrl, videoSrcRemote, videoToken }) => {
    const waiter = createMediaWaiter({ isCurrent });
    const VIDEO_INPUT_ID = "beauticode-video-input";
    let videoEl = null, videoObjectUrl = null, videoListeners = null;
    const { revoke, dataUrlToObjectUrl, fetchAsObjectUrl, toChineseMediaError } = sources;
    const lifecycle = createVideoLifecycle({ isCurrent, isDocHidden, getVideo: () => videoEl,
        hasHandoff: () => Boolean(getHandoff()?.ready), onChange: setAttrs, onReady: releaseHandoff, controls, toChineseMediaError });
    const detachVideoListeners = bundle => bundle?.dispose();
    const createVideoElement = stage => { const bound = createVideoElementBinding({ stage, getHandoff, isCurrent, isDocHidden, lifecycle, controls, revoke }); videoListeners = bound; videoEl = bound.video; return videoEl; };
    const teardownVideo = (opts) => {
        lifecycle.dispose();
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
            }
            catch (_) { }
            try {
                videoEl.removeAttribute("src");
                videoEl.removeAttribute("poster");
                videoEl.load();
            }
            catch (_) { }
            try {
                videoEl.remove();
            }
            catch (_) { }
            videoEl = null;
        }
        revoke(videoObjectUrl);
        videoObjectUrl = null;
    };
    const VIDEO_ACCEPT = "video/mp4,video/quicktime,.mp4,.mov";
    const playbackVideoFile = (file) => {
        if (!file)
            return file;
        const type = String(file.type || "").toLowerCase();
        const name = String(file.name || "").toLowerCase();
        if (type === "video/mp4")
            return file;
        if (type === "video/quicktime" || name.endsWith(".mov")) {
            try {
                return new File([file], file.name, {
                    type: "video/mp4",
                    lastModified: file.lastModified,
                });
            }
            catch (_) {
                return file;
            }
        }
        return file;
    };
    const createVideoInput = () => {
        let input = document.getElementById(VIDEO_INPUT_ID);
        if (input) {
            input.accept = VIDEO_ACCEPT;
            return input;
        }
        input = document.createElement("input");
        input.type = "file";
        input.id = VIDEO_INPUT_ID;
        input.accept = VIDEO_ACCEPT;
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
        if (!isCurrent() || lifecycle.failed)
            return false;
        if (videoObjectUrl && videoObjectUrl !== objectUrl)
            revoke(videoObjectUrl);
        if (objectUrl.startsWith("blob:"))
            videoObjectUrl = objectUrl;
        try {
            // Cold start always muted so autoplay is not blocked; preference applied after.
            video.muted = true;
            video.defaultMuted = true;
            video.setAttribute("muted", "");
            video.playsInline = true;
            video.autoplay = true;
            video.loop = true;
        }
        catch (_) { }
        // Keep replacement hidden until first frame; handoff covers the gap.
        video.style.opacity = "0";
        // Do NOT call video.load() after src assign — it aborts and flashes poster.
        video.src = objectUrl;
        try {
            const p = video.play();
            if (p && typeof p.then === "function") {
                await p.catch(() => { });
            }
        }
        catch (_) { }
        // Apply user mute preference after play has a chance to start.
        try {
            controls.applyMuteState();
        }
        catch (_) { }
        if (!isCurrent() || lifecycle.failed)
            return false;
        if (video.readyState < 2) {
            await waiter.wait(video, ["loadeddata", "canplay", "playing"], () => video.readyState >= 2);
            if (!isCurrent() || lifecycle.failed)
                return false;
            if (video.paused && video.readyState >= 2) {
                try {
                    const p2 = video.play();
                    if (p2 && typeof p2.then === "function")
                        await p2.catch(() => { });
                }
                catch (_) { }
            }
        }
        if (!isCurrent() || lifecycle.failed)
            return false;
        if (video.readyState >= 2 || !video.paused || video.currentTime > 0) {
            lifecycle.markReady();
        }
        else {
            // Still decoding — keep pending; events / retry will reveal.
            lifecycle.setPending(true);
            lifecycle.retryTransientVideo();
        }
        return Boolean(video.src);
    };
    const doAttachVideoFile = async () => {
        if (!isCurrent() || lifecycle.failed)
            return false;
        const input = document.getElementById(VIDEO_INPUT_ID);
        const file = input && input.files && input.files[0] ? input.files[0] : null;
        if (!file)
            return false;
        const stage = ensureStage();
        let video = videoEl;
        if (!video || !video.isConnected) {
            video = createVideoElement(stage);
        }
        try {
            const objectUrl = URL.createObjectURL(playbackVideoFile(file));
            return await playVideoObjectUrl(video, objectUrl);
        }
        catch (err) {
            if (lifecycle.isTransientVideoError(err, videoEl) && lifecycle.retryTransientVideo()) {
                return false;
            }
            if (getHandoff()?.ready) {
                lifecycle.setPending(true);
                lifecycle.retryTransientVideo();
                return false;
            }
            lifecycle.markFailed(err);
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
                        if (src.startsWith("blob:"))
                            videoObjectUrl = src;
                    }
                    video.style.opacity = "0";
                    video.src = src;
                    try {
                        const p = video.play();
                        if (p && typeof p.then === "function") {
                            p.then(() => {
                                if (isCurrent() && (video.readyState >= 2 || !video.paused)) {
                                    lifecycle.markReady();
                                }
                            }).catch(() => { });
                        }
                    }
                    catch (_) { }
                }
                catch (_) {
                    /* CDP attach is the real path */
                }
            }
            // If CDP already stuffed the input (attach raced ahead of apply),
            // consume it on this generation's <video> instead of leaving an empty shell.
            const input = document.getElementById(VIDEO_INPUT_ID);
            if (input && input.files && input.files[0]) {
                return doAttachVideoFile();
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
                    if (src.startsWith("blob:"))
                        videoObjectUrl = src;
                }
                video.style.opacity = "0";
                video.src = src;
                assigned = true;
            }
            catch (_) {
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
                if (obj.startsWith("blob:"))
                    videoObjectUrl = obj;
                video.style.opacity = "0";
                video.src = obj;
                assigned = true;
            }
            catch (_) {
                assigned = false;
            }
        }
        if (!assigned && videoSrcRemote) {
            try {
                video.style.opacity = "0";
                video.src = videoSrcRemote;
                assigned = true;
            }
            catch (_) {
                assigned = false;
            }
        }
        if (!assigned) {
            lifecycle.markFailed(new Error("no video source"));
            return;
        }
        try {
            const p = video.play();
            if (p && typeof p.then === "function") {
                p.then(() => {
                    if (isCurrent() && (video.readyState >= 2 || !video.paused)) {
                        lifecycle.markReady();
                    }
                }).catch((err) => {
                    if (!isCurrent())
                        return;
                    if (lifecycle.isTransientVideoError(err, video) && lifecycle.retryTransientVideo())
                        return;
                    // keep pending if handoff covers
                    if (getHandoff()?.ready) {
                        lifecycle.setPending(true);
                        lifecycle.retryTransientVideo();
                        return;
                    }
                });
            }
        }
        catch (_) { }
    };
    return { start: startVideo, attach: doAttachVideoFile, createVideoInput, reset: () => lifecycle.reset(),
        handoff(stage) { const payload = { stage, video: videoEl, objectUrl: videoObjectUrl, ready: lifecycle.ready && !lifecycle.failed }; videoEl = null; videoObjectUrl = null; return payload; },
        dispose({ handoff = false } = {}) {
            waiter.dispose();
            lifecycle.dispose();
            if (handoff) {
                detachVideoListeners(videoListeners);
                videoListeners = null;
                videoEl = null;
                videoObjectUrl = null;
            }
            else
                teardownVideo();
        },
        get element() { return videoEl; }, get objectUrl() { return videoObjectUrl; }, get ready() { return lifecycle.ready; }, get failed() { return lifecycle.failed; }, get error() { return lifecycle.error; }, get pending() { return lifecycle.pending; }, fail: lifecycle.markFailed };
})

/* Private state belongs to this module; callers receive operations and read-only views. */
(({ stage, getHandoff, isCurrent, isDocHidden, lifecycle, controls, revoke }) => {
    const handoff = getHandoff();
    // Keep at most one handed-off previous video; purge every other child
    // except the poster img we manage separately. Two playable nodes
    // alternate frames and posters (Dream Skin 7a3b2ec).
    const keepVideo = handoff?.video && handoff.video.parentElement === stage
        ? handoff.video
        : null;
    for (const child of [...(stage.children || [])]) {
        if (child === keepVideo)
            continue;
        if (child.tagName === "IMG")
            continue;
        const staleSrc = typeof child.src === "string" ? child.src : "";
        try {
            child.pause?.();
        }
        catch (_) { }
        try {
            child.removeAttribute?.("src");
            child.removeAttribute?.("poster");
            child.load?.();
        }
        catch (_) { }
        try {
            child.remove?.();
        }
        catch (_) { }
        if (staleSrc.startsWith("blob:"))
            revoke(staleSrc);
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
        if (!isCurrent())
            return;
        lifecycle.markReady();
    };
    const onError = (ev) => {
        // Detached / superseded videos must never fail the newer generation.
        if (!isCurrent())
            return;
        const err = ev?.error || video.error || null;
        if (lifecycle.isTransientVideoError(err, video) && lifecycle.retryTransientVideo()) {
            return;
        }
        // If handoff still covers, stay pending rather than hard-fail to image.
        if (getHandoff()?.ready) {
            lifecycle.setPending(true);
            lifecycle.retryTransientVideo();
            return;
        }
        lifecycle.markFailed(err);
    };
    const onStalled = () => {
        if (!isCurrent() || lifecycle.failed)
            return;
        lifecycle.setPending(true);
        lifecycle.retryTransientVideo();
    };
    const onAbort = () => {
        if (!isCurrent() || lifecycle.failed)
            return;
        // Abort during source swap is normal — never hard-fail.
        lifecycle.setPending(true);
        lifecycle.retryTransientVideo();
    };
    const onEmptied = () => {
        if (!isCurrent() || lifecycle.failed || !video.src)
            return;
        lifecycle.setPending(true);
        lifecycle.retryTransientVideo();
    };
    const onEnded = () => {
        if (!isCurrent() || lifecycle.failed || isDocHidden())
            return;
        try {
            video.currentTime = 0;
        }
        catch (_) { }
        Promise.resolve(video.play?.())
            .then(() => {
            if (isCurrent()) {
                lifecycle.setPending(false);
                if (!lifecycle.ready)
                    lifecycle.markReady();
            }
        })
            .catch(() => {
            lifecycle.setPending(true);
            lifecycle.retryTransientVideo();
        });
    };
    const onTimeUpdate = () => {
        if (!isCurrent() || lifecycle.failed)
            return;
        lifecycle.progress(Number(video.currentTime));
    };
    const onLoadedMetadata = () => {
        if (!isCurrent() || lifecycle.failed)
            return;
        try {
            controls.applyPendingStartAt(video);
        }
        catch (_) { }
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
    document.addEventListener("visibilitychange", lifecycle.onVisibility);
    stage.appendChild(video);
    return { video, dispose() {
            for (const [event, handler] of Object.entries(handlers))
                video.removeEventListener(event, handler);
            document.removeEventListener("visibilitychange", lifecycle.onVisibility);
        } };
})

/* Private state belongs to this module; callers receive operations and read-only views. */
(({ isCurrent, isDocHidden, getVideo, hasHandoff, onChange, onReady, controls, toChineseMediaError }) => {
    let videoReady = false, videoFailed = false, videoError = null, pendingPlay = false, retryTimer = null, retryCount = 0, lastPlaybackTime = -1;
    const MAX_RETRY = 20;
    const clearRetry = () => {
        if (retryTimer) {
            try {
                clearTimeout(retryTimer);
            }
            catch (_) { }
            retryTimer = null;
        }
    };
    const revealVideo = () => {
        try {
            if (getVideo()) {
                getVideo().style.opacity = "";
                getVideo().removeAttribute("poster");
            }
        }
        catch (_) { }
    };
    const markReady = () => {
        if (!isCurrent() || videoFailed)
            return;
        // A second blob attach can set inline opacity:0 after the first ready
        // signal. Always reveal; otherwise verify passes and the art stays hidden.
        if (videoReady) {
            revealVideo();
            return;
        }
        videoReady = true;
        pendingPlay = false;
        retryCount = 0;
        clearRetry();
        revealVideo();
        try {
            if (getVideo())
                controls.applyPendingStartAt(getVideo());
        }
        catch (_) { }
        try {
            controls.applyMuteState();
        }
        catch (_) { }
        onChange();
        onReady();
    };
    const markFailed = (error) => {
        if (!isCurrent() || videoFailed)
            return;
        videoFailed = true;
        videoReady = false;
        videoError = {
            name: error?.name || null,
            message: toChineseMediaError(error),
            mediaCode: getVideo()?.error?.code ?? null,
            readyState: getVideo()?.readyState ?? null,
        };
        clearRetry();
        try {
            if (getVideo())
                getVideo().style.opacity = "0";
        }
        catch (_) { }
        onChange();
        // On failure, keep handoff if it was ready so the prior frame stays up;
        // otherwise fall back to poster image.
        if (!hasHandoff()) {
            onReady();
        }
    };
    const isTransientVideoError = (error, video) => {
        if (isDocHidden()) {
            const message = String(error?.message || "").toLowerCase();
            if (error?.name === "AbortError" ||
                /background media|save power|paused/.test(message)) {
                return true;
            }
            // Chromium can emit an empty media error while the app target is hidden.
            if (!video?.error && !message)
                return true;
            if (!video?.error && /failed to fetch|network|load|media/.test(message)) {
                return true;
            }
        }
        const code = video?.error?.code ?? null;
        // MEDIA_ERR_ABORTED (1), MEDIA_ERR_NETWORK (2), empty error object.
        return code === null || code === 1 || code === 2;
    };
    const retryTransientVideo = () => {
        if (!isCurrent() || videoFailed || !getVideo() || !getVideo().src)
            return false;
        if (retryCount >= MAX_RETRY)
            return false;
        // Hidden Chromium suspends media — do not burn the finite retry budget.
        // visibilitychange will resume. Preserving videoReady avoids the
        // "flash then stick on image" failure mode from session 019fa31c.
        if (isDocHidden()) {
            pendingPlay = true;
            return true;
        }
        if (retryTimer)
            return true;
        retryCount += 1;
        pendingPlay = true;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!isCurrent() || videoFailed || !getVideo() || !getVideo().src)
                return;
            if (isDocHidden()) {
                pendingPlay = true;
                return;
            }
            Promise.resolve(getVideo().play?.())
                .then(() => {
                if (!isCurrent() || videoFailed)
                    return;
                pendingPlay = false;
                // play() is an alternate ready signal for shells that skip loadeddata.
                if (getVideo().readyState >= 2 || !getVideo().paused || getVideo().currentTime > 0) {
                    markReady();
                }
            })
                .catch((err) => {
                if (!isCurrent())
                    return;
                if (isTransientVideoError(err, getVideo())) {
                    retryTransientVideo();
                    return;
                }
                markFailed(err);
            });
        }, 500);
        return true;
    };
    const onVisibility = () => {
        if (!isCurrent() || videoFailed)
            return;
        if (isDocHidden())
            return;
        if (!getVideo() || !getVideo().src)
            return;
        try {
            // Inline opacity:0 beats the ready CSS rule. Hidden pages often miss
            // markReady's clear; restoring visibility must drop it or the video
            // stays invisible while snapshot says ready.
            getVideo().style.opacity = "";
        }
        catch (_) { }
        Promise.resolve(getVideo().play?.())
            .then(() => {
            if (!isCurrent() || videoFailed)
                return;
            pendingPlay = false;
            try {
                getVideo().style.opacity = "";
            }
            catch (_) { }
            if (videoReady ||
                getVideo().readyState >= 2 ||
                !getVideo().paused ||
                getVideo().currentTime > 0) {
                if (!videoReady)
                    markReady();
                else
                    onChange();
            }
        })
            .catch((err) => {
            if (!isCurrent())
                return;
            if (isTransientVideoError(err, getVideo()) && retryTransientVideo())
                return;
            // Do not fail a previously-ready video on a single resume blip.
            if (videoReady) {
                pendingPlay = true;
                retryTransientVideo();
                return;
            }
            markFailed(err);
        });
    };
    return { markReady, markFailed, isTransientVideoError, retryTransientVideo, onVisibility,
        setPending(value) { pendingPlay = Boolean(value); },
        progress(t) {
            if (Number.isFinite(t) && (t < lastPlaybackTime || t - lastPlaybackTime >= 0.1)) {
                lastPlaybackTime = t;
                retryCount = 0;
                pendingPlay = false;
                if (!videoReady && (getVideo().readyState >= 2 || t > 0))
                    markReady();
            }
        },
        reset() { videoReady = false; videoFailed = false; videoError = null; pendingPlay = false; retryCount = 0; lastPlaybackTime = -1; clearRetry(); },
        dispose: clearRetry, get ready() { return videoReady; }, get failed() { return videoFailed; }, get error() { return videoError; }, get pending() { return pendingPlay; } };
})

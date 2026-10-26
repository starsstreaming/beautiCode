/* Private state belongs to this module; callers receive operations and read-only views. */
(({ root, previous, normalizedVideo, isCurrent, hasBackgroundMedia, getStage, getVideo, setAttrs }) => {
    let fishMode = false;
    try {
        if (previous && typeof previous.isFishMode === "function") {
            fishMode = Boolean(previous.isFishMode());
        }
        else if (root.getAttribute("data-bc-fish") === "true") {
            fishMode = true;
        }
    }
    catch (_) {
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
    }
    catch (_) {
        videoMuted = true;
    }
    // Background tone is a CSS-only preference. Keep dark as the legacy
    // default, and carry the preference across same-generation/rebuild paths.
    const normalizeTone = (value) => value === "light" || value === "auto" ? value : "dark";
    let backgroundTone = "dark";
    try {
        if (previous && typeof previous.isBackgroundTone === "function") {
            backgroundTone = normalizeTone(previous.isBackgroundTone());
        }
        else {
            backgroundTone = normalizeTone(root.getAttribute("data-bc-tone"));
        }
    }
    catch (_) {
        backgroundTone = "dark";
    }
    // Optional initial seek for saved-theme restore (seconds). Applied once when
    // the live <video> has metadata. Invalid / past end → 0 (start over).
    let pendingStartAt = null;
    let startAtApplied = false;
    try {
        const rawStart = normalizedVideo && typeof normalizedVideo.startAt === "number"
            ? normalizedVideo.startAt
            : null;
        if (rawStart != null && Number.isFinite(rawStart) && rawStart > 0) {
            // Cap absurd values; host also clamps.
            pendingStartAt = Math.min(rawStart, 24 * 60 * 60);
        }
    }
    catch (_) {
        pendingStartAt = null;
    }
    // Focus dim: only when a project/task thread is confirmed open, set
    // data-bc-working so CSS can slightly darken the RIGHT main column.
    const applyFishAttr = () => {
        try {
            if (fishMode && hasBackgroundMedia()) {
                root.setAttribute("data-bc-fish", "true");
            }
            else {
                root.removeAttribute("data-bc-fish");
                if (!hasBackgroundMedia())
                    fishMode = false;
            }
        }
        catch (_) { }
    };
    const setFishMode = (enabled) => {
        if (!isCurrent())
            return false;
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
                if (ae && typeof ae.blur === "function")
                    ae.blur();
            }
            catch (_) { }
        }
        return true;
    };
    const listStageVideos = () => {
        const out = [];
        const stage = getStage() || document.getElementById("beauticode-bg-stage");
        if (stage) {
            try {
                for (const v of stage.querySelectorAll("video")) {
                    if (v && out.indexOf(v) === -1)
                        out.push(v);
                }
            }
            catch (_) { }
        }
        if (getVideo() && out.indexOf(getVideo()) === -1)
            out.push(getVideo());
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
                }
                else {
                    v.muted = false;
                    v.defaultMuted = false;
                    v.removeAttribute("muted");
                }
                if (v.muted)
                    anyStillMuted = true;
            }
            catch (_) {
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
        if (!isCurrent())
            return false;
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
        if (!Number.isFinite(t) || t <= 0)
            return 0;
        const d = typeof duration === "number" ? duration : Number(duration);
        if (Number.isFinite(d) && d > 0 && t >= d)
            return 0;
        if (t > 24 * 60 * 60)
            return 0;
        return t;
    };
    /**
     * Apply pendingStartAt once metadata is available. Fail-soft → 0.
     * Returns the seconds actually seeked to (or null if not yet applied).
     */
    const applyPendingStartAt = (video) => {
        if (startAtApplied || pendingStartAt == null)
            return null;
        if (!video || !isCurrent())
            return null;
        let duration = NaN;
        try {
            duration = Number(video.duration);
        }
        catch (_) {
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
        }
        catch (_) {
            try {
                video.currentTime = 0;
            }
            catch (_) { }
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
        const live = (getVideo() && getVideo().isConnected && getVideo()) ||
            videos[videos.length - 1] ||
            null;
        if (!live) {
            return { ok: true, currentTime: 0, duration: 0, hasVideo: false };
        }
        let currentTime = 0;
        let duration = 0;
        try {
            const t = Number(live.currentTime);
            if (Number.isFinite(t) && t >= 0)
                currentTime = t;
        }
        catch (_) { }
        try {
            const d = Number(live.duration);
            if (Number.isFinite(d) && d > 0)
                duration = d;
        }
        catch (_) { }
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
        const live = (getVideo() && getVideo().isConnected && getVideo()) ||
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
        }
        catch (_) {
            duration = NaN;
        }
        const target = clampSeekSeconds(seconds, duration);
        startAtApplied = true;
        pendingStartAt = null;
        try {
            live.currentTime = target;
        }
        catch (_) {
            try {
                live.currentTime = 0;
            }
            catch (_) { }
            return { ok: true, currentTime: 0, hasVideo: true };
        }
        let now = target;
        try {
            const t = Number(live.currentTime);
            if (Number.isFinite(t))
                now = t;
        }
        catch (_) { }
        return { ok: true, currentTime: now, hasVideo: true };
    };
    return { setFishMode, applyFishAttr, setMuted, applyMuteState, setBackgroundTone, applyPendingStartAt, getPlaybackPosition, seekTo, resetFish() { fishMode = false; }, get fish() { return fishMode; }, get muted() { return videoMuted; }, get tone() { return backgroundTone; } };
})

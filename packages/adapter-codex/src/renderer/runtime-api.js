/* Private state belongs to this module; callers receive operations and read-only views. */
(({ gen, root, getStage, isCurrent, videoEnabled, remoteImageUrl, dataImageUrl, wantImageBlob, image, video, controls, dispose }) => {
    const STAGE_ID = "beauticode-bg-stage";
    const VIDEO_INPUT_ID = "beauticode-video-input";
    const IMAGE_INPUT_ID = "beauticode-image-input";
    const api = {
        generation: gen,
        get videoReady() {
            return video.ready;
        },
        get videoFailed() {
            return video.failed;
        },
        get videoError() {
            return video.error;
        },
        get imageFailed() {
            return image.failed;
        },
        get pendingPlay() {
            return video.pending;
        },
        get media() {
            if (!image.poster &&
                !videoEnabled &&
                !remoteImageUrl &&
                !dataImageUrl &&
                !wantImageBlob) {
                return "clear";
            }
            return videoEnabled && !video.failed ? "video" : "image";
        },
        ensureVideoInput() {
            if (!videoEnabled)
                return false;
            video.createVideoInput();
            return Boolean(document.getElementById(VIDEO_INPUT_ID));
        },
        attachVideoFile() {
            return video.attach();
        },
        ensureImageInput() {
            if (videoEnabled)
                return false;
            image.createImageInput();
            return Boolean(document.getElementById(IMAGE_INPUT_ID));
        },
        attachImageFile() {
            return image.attach();
        },
        /**
         * Snapshot the current playable video for the next generation.
         * Caller must then dispose({handoff:true}) so we do not tear it down.
         * Listeners stay attached until the NEW generation's dispose/handoff path
         * detaches them via the previous.dispose({handoff}) call below — actually
         * we detach in dispose(handoff) so the old runtime cannot restart media.
         */
        handoffVideo() { return video.handoff(getStage()); },
        dispose,
        isFishMode() {
            return Boolean(controls.fish);
        },
        setFishMode(enabled) {
            return controls.setFishMode(enabled);
        },
        isMuted() {
            return Boolean(controls.muted);
        },
        setMuted(muted) {
            return controls.setMuted(muted);
        },
        isBackgroundTone() {
            return controls.tone;
        },
        setBackgroundTone(tone) {
            return controls.setBackgroundTone(tone);
        },
        /** Re-apply stored mute preference (used after CDP attach / heal). */
        applyMutePreference() {
            if (!isCurrent())
                return { ok: false, muted: true, blocked: false, hasVideo: false };
            const applied = controls.applyMuteState();
            return {
                ok: true,
                muted: Boolean(controls.muted),
                blocked: Boolean(applied.blocked),
                hasVideo: Boolean(applied.hasVideo),
            };
        },
        /** Current <video> currentTime/duration for theme progress persistence. */
        getPlaybackPosition() {
            return controls.getPlaybackPosition();
        },
        /**
         * Seek live video (or remember for pending attach).
         * Invalid / past end → 0.
         */
        seekTo(seconds) {
            return controls.seekTo(seconds);
        },
        snapshot() {
            const stage = document.getElementById(STAGE_ID);
            const img = stage ? stage.querySelector("img") : null;
            const videos = stage ? [...stage.querySelectorAll("video")] : [];
            // Prefer the current generation's element; fall back to any live node.
            const liveVideo = (video.element && video.element.isConnected && video.element) ||
                videos[videos.length - 1] ||
                null;
            const cs = stage ? window.getComputedStyle(stage) : null;
            let imageNatural = 0;
            try {
                imageNatural = img && img.naturalWidth ? img.naturalWidth : 0;
            }
            catch (_) {
                imageNatural = 0;
            }
            // Own-generation readiness only. Handoff may keep data-bc-video-ready=true
            // for CSS continuity, but host health checks must not treat "previous
            // frame still covering" as "new blob attached" — that skips CDP attach
            // and sticks the switch on the old media.
            const ownVideoReady = Boolean(video.ready && !video.failed && liveVideo && liveVideo === video.element);
            const ownSrc = liveVideo && typeof liveVideo.src === "string" ? liveVideo.src : "";
            const hasPlayableSrc = ownSrc.startsWith("blob:") || ownSrc.startsWith("data:");
            let elementMuted = true;
            try {
                if (liveVideo)
                    elementMuted = Boolean(liveVideo.muted);
            }
            catch (_) {
                elementMuted = true;
            }
            return {
                generation: gen,
                active: root.getAttribute("data-bc-active") === "true",
                media: root.getAttribute("data-bc-media"),
                working: root.getAttribute("data-bc-working") === "true",
                fish: root.getAttribute("data-bc-fish") === "true",
                muted: Boolean(controls.muted),
                elementMuted,
                videoReady: ownVideoReady,
                videoFailed: Boolean(video.failed),
                hasStage: Boolean(stage),
                hasImage: Boolean(img && img.getAttribute("src")),
                imageLoaded: imageNatural > 0,
                imageFailed: Boolean(image.failed),
                hasVideo: Boolean(liveVideo),
                hasPlayableSrc,
                videoCount: videos.length,
                stagePointerEvents: cs ? cs.pointerEvents : null,
                horizontalOverflow: document.documentElement.scrollWidth >
                    document.documentElement.clientWidth + 1,
                documentHidden: Boolean(document.hidden),
                documentVisibility: typeof document.visibilityState === "string"
                    ? document.visibilityState
                    : null,
            };
        },
    };
    return api;
})

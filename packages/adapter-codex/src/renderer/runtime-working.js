/* Private state belongs to this module; callers receive operations and read-only views. */
(({ root, isCurrent, hasBackgroundMedia }) => {
    // the sidebar). Media stays mounted and keeps playing. Fail open.
    let working = false;
    let workObserver = null;
    let workPollTimer = null;
    let workRaf = 0;
    let workDebounceTimer = null;
    let workRouteHooked = false;
    const WORK_POLL_MS = 2000;
    const WORK_DEBOUNCE_MS = 200;
    const setWorkingAttr = (next) => {
        working = Boolean(next);
        if (!hasBackgroundMedia()) {
            root.removeAttribute("data-bc-working");
            return;
        }
        if (working)
            root.setAttribute("data-bc-working", "true");
        else
            root.removeAttribute("data-bc-working");
    };
    const isVisibleEl = (el) => {
        if (!el || !el.isConnected)
            return false;
        try {
            const r = el.getBoundingClientRect?.();
            if (r && (r.width < 1 || r.height < 1))
                return false;
            const st = typeof window.getComputedStyle === "function"
                ? window.getComputedStyle(el)
                : null;
            if (st &&
                (st.display === "none" ||
                    st.visibility === "hidden" ||
                    Number(st.opacity) === 0)) {
                return false;
            }
        }
        catch (_) {
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
        }
        catch (_) {
            return false;
        }
    };
    /**
     * True when a project task / conversation thread is confirmed open —
     * the only case that should dim. Prefer structural thread / selected-task
     * signals over header+composer (home and new-task also have those).
     */
    const isTaskOrProjectView = () => {
        try {
            if (isHomeView())
                return false;
            // Thread / message list (Codex desktop task conversation).
            const thread = document.querySelector([
                ".thread-scroll-container",
                "[data-message-author-role]",
                '[data-testid*="conversation"]',
                '[data-testid*="thread"]',
                '[data-testid*="turn"]',
                "body > #root main [data-message-id]",
            ].join(", "));
            if (thread && isVisibleEl(thread))
                return true;
            // Sidebar: a selected project task row (not the "无任务" empty label).
            const selectedTask = document.querySelector([
                'aside.app-shell-left-panel [aria-current="page"]',
                "aside.app-shell-left-panel [aria-selected='true']",
                "aside.app-shell-left-panel button[aria-pressed='true']",
                "aside.app-shell-left-panel a[aria-current='true']",
            ].join(", "));
            if (selectedTask && isVisibleEl(selectedTask)) {
                const t = (selectedTask.textContent || "").replace(/\s+/g, " ").trim();
                if (t && !/^(无任务|no tasks?|new task|新建任务)$/i.test(t)) {
                    return true;
                }
            }
            return false;
        }
        catch (_) {
            return false;
        }
    };
    /**
     * Dim only inside a confirmed project/task thread.
     * Home / new-task landing stays bright even if the agent is generating.
     * Attribute on <html> only.
     */
    const detectWorking = () => {
        try {
            if (typeof document === "undefined" || !document.body)
                return false;
            return isTaskOrProjectView();
        }
        catch (_) {
            // Fail open: never dim on detector errors.
            return false;
        }
    };
    const refreshWorking = () => {
        if (!isCurrent())
            return;
        const next = detectWorking();
        if (next !== working) {
            setWorkingAttr(next);
        }
    };
    const scheduleWorkingRefresh = () => {
        if (!isCurrent())
            return;
        if (workDebounceTimer || workRaf)
            return;
        workDebounceTimer = setTimeout(() => {
            workDebounceTimer = null;
            try {
                workRaf = requestAnimationFrame(() => {
                    workRaf = 0;
                    refreshWorking();
                });
            }
            catch (_) {
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
            }
            catch (_) { }
            workObserver = null;
        }
        if (workPollTimer) {
            try {
                clearInterval(workPollTimer);
            }
            catch (_) { }
            workPollTimer = null;
        }
        if (workRaf) {
            try {
                cancelAnimationFrame(workRaf);
            }
            catch (_) { }
            workRaf = 0;
        }
        if (workDebounceTimer) {
            try {
                clearTimeout(workDebounceTimer);
            }
            catch (_) { }
            workDebounceTimer = null;
        }
        if (workRouteHooked) {
            try {
                window.removeEventListener("popstate", onRouteMaybeChanged);
                window.removeEventListener("hashchange", onRouteMaybeChanged);
                window.removeEventListener("focus", onRouteMaybeChanged);
            }
            catch (_) { }
            workRouteHooked = false;
        }
        working = false;
        try {
            root.removeAttribute("data-bc-working");
        }
        catch (_) { }
    };
    const startWorkingWatch = () => {
        if (!isCurrent())
            return;
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
        }
        catch (_) {
            workObserver = null;
        }
        // Poll as a safety net (SPA swaps / closed shadow roots).
        try {
            workPollTimer = setInterval(() => {
                if (!isCurrent())
                    return;
                refreshWorking();
            }, WORK_POLL_MS);
            workPollTimer.unref?.();
        }
        catch (_) {
            workPollTimer = null;
        }
        if (!workRouteHooked) {
            try {
                window.addEventListener("popstate", onRouteMaybeChanged);
                window.addEventListener("hashchange", onRouteMaybeChanged);
                window.addEventListener("focus", onRouteMaybeChanged);
                workRouteHooked = true;
            }
            catch (_) {
                workRouteHooked = false;
            }
        }
        refreshWorking();
    };
    return { start: startWorkingWatch, stop: stopWorkingWatch, get active() { return working; } };
})

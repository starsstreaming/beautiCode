/* One document-scoped owner. Never captures a media generation. */
(({ policy, timeoutMs = 3000 }) => {
    const records = new Map();
    let active = false, disposed = false, observer = null, scheduled = false;
    const diagnose = (stage, reason) => {
        console.warn("[beautiCode guest]", { stage, reason });
    };
    const remove = (w, key) => {
        if (!key)
            return;
        try {
            Promise.resolve(w.removeInsertedCSS(key)).catch(() => diagnose("remove", "rejected"));
        }
        catch {
            diagnose("remove", "unavailable");
        }
    };
    const invalidate = record => {
        record.epoch++;
        clearTimeout(record.timer);
        record.timer = null;
        remove(record.webview, record.key);
        record.key = null;
        record.route = null;
    };
    const detach = record => {
        invalidate(record);
        for (const [event, handler] of record.handlers) {
            record.webview.removeEventListener(event, handler);
        }
        records.delete(record.webview);
    };
    const inject = record => {
        const w = record.webview;
        const contract = active && !disposed ? policy(w) : null;
        if (!contract) {
            invalidate(record);
            return;
        }
        if (record.pending || (record.key && record.route === contract.route))
            return;
        if (typeof w.insertCSS !== "function" || typeof w.removeInsertedCSS !== "function") {
            diagnose("insert", "unsupported");
            return;
        }
        const epoch = record.epoch;
        record.pending = true;
        let expired = false;
        const timer = setTimeout(() => {
            expired = true;
            diagnose("insert", "timeout");
            // Electron's promise cannot be cancelled. Keep at most one outstanding
            // call, and revoke its key even if it resolves after this timeout.
        }, timeoutMs);
        record.timer = timer;
        let result;
        try {
            result = w.insertCSS(contract.css);
        }
        catch {
            result = Promise.reject(new Error("insert unavailable"));
        }
        Promise.resolve(result).then(key => {
            const now = active && !disposed ? policy(w) : null;
            if (expired || !records.has(w) || epoch !== record.epoch ||
                !now || now.route !== contract.route) {
                remove(w, key);
                return;
            }
            record.key = key;
            record.route = contract.route;
        }, () => diagnose("insert", "rejected")).finally(() => {
            clearTimeout(timer);
            if (record.timer === timer)
                record.timer = null;
            record.pending = false;
            // Navigation can request a new document while the previous call is
            // unresolved. Converge once; ordinary rejection does not auto-retry.
            if (records.get(w) === record && active && !disposed &&
                epoch !== record.epoch && policy(w))
                inject(record);
        });
    };
    const bind = webview => {
        if (records.has(webview))
            return records.get(webview);
        const record = { webview, key: null, route: null, epoch: 0, pending: false, timer: null, handlers: [] };
        // Bind only allowed content, never sandbox, checkout or hidden prewarmers.
        if (!policy.candidate(webview))
            return null;
        for (const event of ["dom-ready", "did-navigate", "did-navigate-in-page"]) {
            const handler = e => {
                if (e.isMainFrame === false)
                    return;
                invalidate(record);
                inject(record);
            };
            webview.addEventListener(event, handler);
            record.handlers.push([event, handler]);
        }
        const navigating = e => {
            if (e.isMainFrame === false)
                return;
            invalidate(record);
        };
        webview.addEventListener("did-start-navigation", navigating);
        record.handlers.push(["did-start-navigation", navigating]);
        records.set(webview, record);
        return record;
    };
    const sync = () => {
        if (!active || disposed)
            return;
        const nodes = new Set(document.querySelectorAll("webview"));
        for (const [w, record] of records) {
            if (!nodes.has(w) || !w.isConnected || !policy.candidate(w))
                detach(record);
        }
        for (const w of nodes) {
            const record = bind(w);
            if (record)
                inject(record);
        }
    };
    const schedule = () => {
        if (scheduled)
            return;
        scheduled = true;
        Promise.resolve().then(() => { scheduled = false; sync(); });
    };
    const setActive = value => {
        if (disposed)
            return;
        const next = Boolean(value);
        if (next === active) {
            if (active)
                sync();
            return;
        }
        active = next;
        if (active) {
            observer = new MutationObserver(records => {
                if (records.some(r => r.type === "attributes" ||
                    [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && (n.tagName === "WEBVIEW" || n.querySelector?.("webview")))))
                    schedule();
            });
            observer.observe(document.documentElement, {
                subtree: true, childList: true, attributes: true, attributeFilter: ["src"],
            });
            sync();
        }
        else {
            observer?.disconnect();
            observer = null;
            for (const record of [...records.values()])
                detach(record);
        }
    };
    return {
        setActive, sync,
        dispose() {
            if (disposed)
                return;
            setActive(false);
            disposed = true;
        },
    };
})

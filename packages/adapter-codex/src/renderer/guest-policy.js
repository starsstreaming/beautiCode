/* Codex content-route contract. The 26.1016 renderer declares these routes
 * natively; older/alternate layouts may embed them. A matching route alone
 * never authorises an arbitrary webview: intended/current URL and host slot
 * must agree. Checkout, prewarming and unknown routes remain untouched.
 * See ADR 0009 for evidence and the limits of the Electron acceptance. */
(() => {
    const routes = new Set(["/plugins", "/library", "/sites", "/images"]);
    const css = `
    html, body, body > #root, body > #__next {
      background-color: transparent !important;
      background-image: none !important;
    }
  `;
    const parse = value => {
        const url = new URL(value, "https://chatgpt.com");
        if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" ||
            url.port || url.username || url.password)
            return null;
        return url;
    };
    const candidate = webview => {
        try {
            if (!webview.isConnected || !webview.closest("main"))
                return null;
            const src = new URL(webview.getAttribute("src") || "");
            if (src.protocol !== "about:" || src.pathname !== "blank")
                return null;
            if (src.searchParams.get("prewarm") === "true")
                return null;
            const partition = webview.getAttribute("partition") || "";
            if (/pricing|checkout|workspace-settings|sandbox/i.test(partition))
                return null;
            const intended = parse(src.searchParams.get("toUrl") || "");
            if (!intended || !routes.has(intended.pathname))
                return null;
            return { route: intended.pathname, css };
        }
        catch {
            // A not-yet-ready webview is reconsidered at dom-ready.
            return null;
        }
    };
    const policy = webview => {
        const contract = candidate(webview);
        if (!contract)
            return null;
        try {
            const actual = parse(webview.getURL());
            return actual?.pathname === contract.route ? contract : null;
        }
        catch {
            return null;
        }
    };
    policy.candidate = candidate;
    return policy;
})

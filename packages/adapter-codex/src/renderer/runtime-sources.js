/* Private state belongs to this module; callers receive operations and read-only views. */
(({ isCurrent }) => {
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
    const revoke = (url) => {
        if (!url || typeof url !== "string" || !url.startsWith("blob:"))
            return;
        try {
            URL.revokeObjectURL(url);
        }
        catch (_) { }
    };
    const dataUrlToObjectUrl = async (dataUrl) => {
        if (!dataUrl || typeof dataUrl !== "string") {
            throw new Error("missing data url");
        }
        if (dataUrl.startsWith("blob:"))
            return dataUrl;
        if (!dataUrl.startsWith("data:"))
            return dataUrl;
        try {
            const res = await fetch(dataUrl);
            if (!res.ok)
                throw new Error("data url fetch failed: " + res.status);
            const blob = await res.blob();
            if (!isCurrent())
                throw new Error("stale generation");
            return URL.createObjectURL(blob);
        }
        catch (_) {
            const comma = dataUrl.indexOf(",");
            if (comma < 0)
                throw new Error("malformed data url");
            const meta = dataUrl.slice(0, comma);
            const payload = dataUrl.slice(comma + 1);
            const mimeMatch = /^data:([^;,]+)/i.exec(meta);
            const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
            const isBase64 = /;base64/i.test(meta);
            let bytes;
            if (isBase64) {
                const bin = atob(payload);
                bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i += 1)
                    bytes[i] = bin.charCodeAt(i);
            }
            else {
                const decoded = decodeURIComponent(payload);
                bytes = new Uint8Array(decoded.length);
                for (let i = 0; i < decoded.length; i += 1) {
                    bytes[i] = decoded.charCodeAt(i);
                }
            }
            if (!isCurrent())
                throw new Error("stale generation");
            return URL.createObjectURL(new Blob([bytes], { type: mime }));
        }
    };
    const fetchAsObjectUrl = async (url, token) => {
        if (!url || typeof url !== "string")
            throw new Error("missing media url");
        if (url.startsWith("blob:"))
            return url;
        if (url.startsWith("data:"))
            return dataUrlToObjectUrl(url);
        const headers = {};
        if (token)
            headers["X-BeautiCode-Media-Token"] = token;
        const res = await fetch(url, {
            method: "GET",
            headers,
            mode: "cors",
            credentials: "omit",
            cache: "no-store",
        });
        if (!res.ok)
            throw new Error("media fetch failed: " + res.status);
        const blob = await res.blob();
        if (!isCurrent())
            throw new Error("stale generation");
        return URL.createObjectURL(blob);
    };
    return { revoke, dataUrlToObjectUrl, fetchAsObjectUrl, toChineseMediaError };
})

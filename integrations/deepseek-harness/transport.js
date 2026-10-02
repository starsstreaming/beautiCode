(() => {
  "use strict";
  if (globalThis.__beauticodeTransport) return;
  const desktopKey =
    location.protocol === "dsh-app:" && location.hostname === "app"
      ? globalThis.__BEAUTICODE_DESKTOP_KEY__
      : null;
  if (location.protocol === "dsh-app:" && !/^[a-f0-9]{64}$/.test(desktopKey ?? "")) {
    throw new Error("beautiCode Desktop page key is missing.");
  }
  const headers = () =>
    typeof desktopKey === "string" ? { "X-Beauticode-Desktop-Key": desktopKey } : {};

  function events(url, onMessage) {
    if (!desktopKey) {
      const source = new EventSource(url);
      source.onmessage = onMessage;
      return source;
    }

    const controller = new AbortController();
    let retryMs = 500;
    async function connect() {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(url, {
            headers: headers(),
            credentials: "same-origin",
            mode: "same-origin",
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error("Background event stream unavailable");
          retryMs = 500;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          let data = [];
          let dataSize = 0;
          try {
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              pending += decoder.decode(value, { stream: true });
              if (pending.length > 128 * 1024) throw new Error("Background event frame too large");
              let newline;
              while ((newline = pending.indexOf("\n")) !== -1) {
                const line = pending.slice(0, newline).replace(/\r$/, "");
                pending = pending.slice(newline + 1);
                if (line === "") {
                  if (data.length) onMessage({ data: data.join("\n") });
                  data = [];
                  dataSize = 0;
                } else if (line.startsWith("data:")) {
                  dataSize += line.length;
                  if (dataSize > 128 * 1024) throw new Error("Background event frame too large");
                  data.push(line.slice(5).replace(/^ /, ""));
                }
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        } catch {
          if (controller.signal.aborted) break;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(finish, retryMs);
          function finish() {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          }
          controller.signal.addEventListener("abort", finish, { once: true });
        });
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    }
    void connect();
    return { close: () => controller.abort() };
  }

  globalThis.__beauticodeTransport = { headers, events };
})();

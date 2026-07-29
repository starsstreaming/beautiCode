import http from "node:http";
import { WebSocketServer } from "ws";

/**
 * Minimal fake Chromium CDP endpoint for unit tests.
 * Serves /json/version + /json/list and a page WebSocket that handles
 * Runtime.enable / Page.enable / Runtime.evaluate against an in-memory "DOM".
 */

export async function startMockCdp(opts = {}) {
  const browserId = "test-browser";
  const pageId = "page-test";
  const state = {
    body: true,
    protocol: "app:",
    runtime: {},
    lastExpression: null,
  };

  let evaluateImpl = (expression, s) => {
    s.lastExpression = expression;

    // Probe used during connect.
    if (expression.includes("hasBody") && expression.includes("protocol")) {
      return { hasBody: s.body, protocol: s.protocol };
    }

    // Injection wraps the runtime source then ends with
    // `)(css, imageDataUrl, video, generation, imageUrl, forceRebuild)`.
    // Do not use [^)]* — CSS may contain rgba(...).
    // Tail is legacy `,GEN)` or current
    // `,GEN,null,false)` / `,GEN,"http...",true)`.
    const tailMatch = expression.match(
      /,(\d+)(?:,(null|"[^"]*"))?(?:,(true|false))?\)\s*$/,
    );
    const isInjection =
      expression.includes("beauticode-bg-stage") &&
      expression.includes("__BEAUTICODE_BG__") &&
      Boolean(tailMatch) &&
      expression.length > 1000;
    if (isInjection) {
      const generation = Number(tailMatch[1]);
      const imageUrlArg = tailMatch[2]; // undefined | "null" | "\"http...\""
      const hasImageUrl =
        typeof imageUrlArg === "string" &&
        imageUrlArg !== "null" &&
        imageUrlArg.length > 2;
      // Args: css, imageDataUrl, video, generation, imageUrl, forceRebuild
      // clear → imageDataUrl null AND video null AND imageUrl null:
      //   ...,null,null,GEN,null)  or legacy ...,null,null,GEN)
      const isClear =
        /null,null,\d+,null,(?:true|false)\)\s*$/.test(expression) ||
        /null,null,\d+,null\)\s*$/.test(expression) ||
        /null,null,\d+\)\s*$/.test(expression);
      const hasVideo =
        expression.includes('"mode":"server"') ||
        expression.includes('"mode": "server"') ||
        expression.includes('"mode":"data"') ||
        expression.includes('"mode": "data"') ||
        expression.includes('"dataUrl"') ||
        expression.includes('"srcUrl"');
      // data: image still counts as image even without imageUrl.
      const hasDataImage = /data:image\//.test(expression);
      const media = isClear
        ? "clear"
        : hasVideo
          ? "video"
          : hasImageUrl || hasDataImage
            ? "image"
            : "image";
      const fishHolder = { fish: false };
      // Mute preference survives reinject within the mock page state.
      if (typeof s.mutedPref !== "boolean") s.mutedPref = true;
      s.runtime.__BEAUTICODE_BG__ = {
        generation,
        videoReady: media === "video",
        videoFailed: false,
        isFishMode: () => fishHolder.fish && media !== "clear",
        setFishMode: (enabled) => {
          if (enabled && media === "clear") {
            fishHolder.fish = false;
            return false;
          }
          fishHolder.fish = Boolean(enabled) && media !== "clear";
          return true;
        },
        isMuted: () => Boolean(s.mutedPref),
        setMuted: (muted) => {
          s.mutedPref = Boolean(muted);
          return {
            ok: true,
            muted: Boolean(s.mutedPref),
            blocked: false,
            hasVideo: media === "video",
          };
        },
        applyMutePreference: () => ({
          ok: true,
          muted: Boolean(s.mutedPref),
          blocked: false,
          hasVideo: media === "video",
        }),
        getPlaybackPosition: () => ({
          ok: true,
          currentTime: Number(s.playbackTime) || 0,
          duration: media === "video" ? 120 : 0,
          hasVideo: media === "video",
        }),
        seekTo: (seconds) => {
          const t = Number(seconds);
          const next =
            Number.isFinite(t) && t > 0 && t < 120 ? t : 0;
          s.playbackTime = next;
          return {
            ok: true,
            currentTime: next,
            hasVideo: media === "video",
          };
        },
        snapshot: () => ({
          generation,
          active: media !== "clear",
          media: media === "clear" ? null : media,
          videoReady: media === "video",
          hasStage: media !== "clear",
          hasImage: media !== "clear",
          imageLoaded: media !== "clear",
          imageFailed: false,
          hasVideo: media === "video",
          hasPlayableSrc: media === "video",
          fish: fishHolder.fish && media !== "clear",
          muted: Boolean(s.mutedPref),
          elementMuted: Boolean(s.mutedPref),
          stagePointerEvents: "none",
          horizontalOverflow: false,
        }),
      };
      // Optional startAt from injection args (videoConfig JSON).
      try {
        const startMatch = expression.match(/"startAt"\s*:\s*([0-9.]+)/);
        if (startMatch && media === "video") {
          const startAt = Number(startMatch[1]);
          if (Number.isFinite(startAt) && startAt > 0 && startAt < 120) {
            s.playbackTime = startAt;
          } else {
            s.playbackTime = 0;
          }
        }
      } catch {
        /* ignore */
      }
      // Clear always drops fish.
      if (media === "clear") fishHolder.fish = false;
      return { installed: true, generation };
    }

    // Fish mode toggle (attribute-only; short expression).
    if (
      expression.includes("setFishMode") &&
      expression.includes("__BEAUTICODE_BG__") &&
      expression.length < 800 &&
      !expression.includes("setMuted")
    ) {
      const api = s.runtime.__BEAUTICODE_BG__;
      if (!api || typeof api.setFishMode !== "function") return false;
      const want = /\bsetFishMode\(true\)/.test(expression);
      return Boolean(api.setFishMode(want));
    }

    // Mute toggle / applyMutePreference (short expression).
    if (
      expression.includes("__BEAUTICODE_BG__") &&
      expression.length < 1200 &&
      (expression.includes("setMuted") || expression.includes("applyMutePreference"))
    ) {
      const api = s.runtime.__BEAUTICODE_BG__;
      if (!api) return null;
      if (expression.includes("applyMutePreference") && !expression.includes("setMuted")) {
        if (typeof api.applyMutePreference === "function") {
          return api.applyMutePreference();
        }
        return null;
      }
      if (typeof api.setMuted !== "function") return null;
      const wantMuted = /\bsetMuted\(true\)/.test(expression);
      return api.setMuted(wantMuted);
    }

    // Playback position / seek (short expressions).
    if (
      expression.includes("__BEAUTICODE_BG__") &&
      expression.length < 1200 &&
      (expression.includes("getPlaybackPosition") || expression.includes("seekTo"))
    ) {
      const api = s.runtime.__BEAUTICODE_BG__;
      if (!api) return null;
      if (expression.includes("getPlaybackPosition")) {
        if (typeof api.getPlaybackPosition !== "function") return null;
        return api.getPlaybackPosition();
      }
      if (typeof api.seekTo !== "function") return null;
      const m = expression.match(/seekTo\(([^)]+)\)/);
      const sec = m ? Number(JSON.parse(m[1])) : 0;
      return api.seekTo(sec);
    }

    // Readiness snapshot expression (short, calls api.snapshot).
    if (
      expression.includes("api.snapshot") ||
      (expression.includes("__BEAUTICODE_BG__") && expression.length < 2000)
    ) {
      const api = s.runtime.__BEAUTICODE_BG__;
      if (!api || typeof api.snapshot !== "function") {
        return {
          generation: -1,
          active: false,
          media: null,
          videoReady: false,
          videoFailed: false,
          hasStage: false,
          hasImage: false,
          imageLoaded: false,
          imageFailed: false,
          hasVideo: false,
          hasPlayableSrc: false,
          stagePointerEvents: null,
          horizontalOverflow: false,
          documentHidden: false,
          documentVisibility: "visible",
          missingRuntime: true,
        };
      }
      const snap = api.snapshot();
      return {
        ...snap,
        videoFailed: Boolean(api.videoFailed),
        documentHidden: false,
        documentVisibility: "visible",
      };
    }

    return null;
  };

  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "";
    if (url === "/json/version") {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      const body = JSON.stringify({
        Browser: "Mock/1.0",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/browser/${browserId}`,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    if (url === "/json/list") {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      const body = JSON.stringify([
        {
          id: pageId,
          type: "page",
          title: opts.title ?? "Codex",
          url: opts.pageUrl ?? "app://-/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/${pageId}`,
        },
        {
          id: "browser-only",
          type: "browser",
          url: "",
          webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/browser/${browserId}`,
        },
      ]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        ws.close();
        return;
      }
      if (!msg.id || !msg.method) return;

      if (msg.method === "Runtime.enable" || msg.method === "Page.enable") {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "Runtime.evaluate") {
        try {
          const value = evaluateImpl(msg.params?.expression ?? "", state);
          ws.send(
            JSON.stringify({
              id: msg.id,
              result: {
                result: { type: typeof value, value },
              },
            }),
          );
        } catch (err) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              result: {
                exceptionDetails: {
                  text: err instanceof Error ? err.message : String(err),
                },
              },
            }),
          );
        }
        return;
      }
      ws.send(
        JSON.stringify({
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = server.address().port;

  return {
    port,
    browserId,
    pageId,
    state,
    setEvaluateImpl(fn) {
      evaluateImpl = fn;
    },
    async close() {
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

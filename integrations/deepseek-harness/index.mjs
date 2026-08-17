import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAgentSurfaces } from "./agent.mjs";
import { resolvePluginBaseUrl } from "./host-apply.mjs";

export const name = "beauticode-bridge";
export const inject = ["webServer"];
export const bridgeProtocol = 4;

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 64 * 1024;

async function readBridgeIdentity() {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(here, "bridge-manifest.json"), "utf8"),
    );
    if (
      manifest.schema === "beauticode.dsh-bridge/v1" &&
      manifest.protocol === bridgeProtocol &&
      REVISION_PATTERN.test(manifest.revision)
    ) {
      return { protocol: bridgeProtocol, revision: manifest.revision };
    }
  } catch {}
  return { protocol: bridgeProtocol, revision: "source" };
}

function defaultTokenFile() {
  const base =
    process.env.BEAUTICODE_DATA_ROOT ||
    (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "beautiCode")
      : path.join(os.homedir(), ".beauticode"));
  return path.join(base, "dsh-bridge.token");
}

function sendJson(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("请求内容过大。");
        error.statusCode = 413;
        reject(error);
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          const error = new Error("请求内容必须是 JSON 对象。");
          error.statusCode = 400;
          reject(error);
          return;
        }
        resolve(parsed);
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function authorized(req, tokenFile) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || "").trim());
  if (!match) return false;
  let expected;
  try {
    expected = (await fs.readFile(tokenFile, "utf8")).trim();
  } catch {
    return false;
  }
  if (!TOKEN_PATTERN.test(expected)) return false;
  const actualBuffer = Buffer.from(match[1], "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin === "string") return origin === `http://${req.headers.host}`;
  return req.headers["sec-fetch-site"] === "same-origin";
}

function validLoopbackMediaUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase()) &&
      url.searchParams.has("t")
    );
  } catch {
    return false;
  }
}

function validApplyPayload(body) {
  if (!Number.isSafeInteger(body.generation) || body.generation < 0) return false;
  if (!["image", "video", "clear"].includes(body.media)) return false;
  if (body.media === "clear") {
    return body.imageUrl == null && body.videoUrl == null && body.startAt == null;
  }
  if (!validLoopbackMediaUrl(body.imageUrl)) return false;
  if (body.media === "image") return body.videoUrl == null && body.startAt == null;
  return (
    validLoopbackMediaUrl(body.videoUrl) &&
    (body.startAt == null || (Number.isFinite(body.startAt) && body.startAt >= 0))
  );
}

function validTone(value) {
  return value === "dark" || value === "light" || value === "auto";
}

function publicStatus(current, modes, clients, clientStates) {
  const states = [...clientStates.values()];
  const activeAcks = states
    .map((state) => state.render)
    .filter(
      (ack) =>
        ack &&
        current &&
        ack.generation === current.generation &&
        ack.media === current.media,
    );
  const modeAcks = states.map((state) => state.mode).filter(Boolean);
  const modeReady = modeAcks.filter(
    (ack) =>
      ack.fish === modes.fish &&
      ack.tone === modes.tone &&
      ack.themeSynced === true &&
      (modes.tone === "auto" || ack.resolvedTone === modes.tone) &&
      (ack.muted === modes.muted || (modes.muted === false && ack.blocked === true)),
  );
  const playback =
    activeAcks.find((ack) => ack.ok === true && ack.playback?.hasVideo === true)
      ?.playback ?? null;
  return {
    ok: true,
    connectedClients: clients.size,
    current,
    readyClients: activeAcks.filter((ack) => ack.ok === true).length,
    failedClients: activeAcks.filter((ack) => ack.ok !== true).length,
    visibleClients: activeAcks.filter((ack) => ack.ok === true && ack.visible === true).length,
    modeReadyClients: modeReady.length,
    blockedClients: modeReady.filter((ack) => ack.blocked === true).length,
    resolvedTone: modeReady[0]?.resolvedTone ?? null,
    modes: { ...modes },
    playback,
  };
}

export function apply(ctx, config = {}) {
  const tokenFile = path.resolve(config.tokenFile || defaultTokenFile());
  const clients = new Map();
  const clientStates = new Map();
  let current = null;
  const modes = { fish: false, muted: true, tone: "dark" };
  registerAgentSurfaces(ctx, {
    dataRoot: path.dirname(tokenFile),
    baseUrl: resolvePluginBaseUrl(ctx),
  });

  const broadcast = (payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients.values()) response.write(frame);
  };

  ctx.effect(() => {
    const disposeTap = ctx.webServer.tapIndex((html) => {
      if (html.includes("data-beauticode-bridge")) return html;
      const script = '<script defer src="/__beauticode/client.js" data-beauticode-bridge></script>';
      return html.includes("</body>")
        ? html.replace("</body>", `${script}</body>`)
        : `${html}${script}`;
    });

    const disposers = [
      ctx.webServer.register({
        kind: "exact",
        path: "/__beauticode/version",
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405).end();
            return;
          }
          const identity = await readBridgeIdentity();
          if (req.method === "HEAD") {
            res.writeHead(200, { "cache-control": "no-store" }).end();
            return;
          }
          sendJson(res, 200, { ok: true, ...identity });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: "/__beauticode/client.js",
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405).end();
            return;
          }
          const source = await fs.readFile(path.join(here, "client.js"));
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "content-length": source.length,
          });
          res.end(req.method === "HEAD" ? undefined : source);
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: "/__beauticode/events",
        handler: (req, res) => {
          if (req.method !== "GET" || !isSameOrigin(req)) {
            res.writeHead(req.method === "GET" ? 403 : 405).end();
            return;
          }
          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          const clientId = url.searchParams.get("clientId");
          if (!clientId || !/^[A-Za-z0-9._-]{8,80}$/.test(clientId)) {
            res.writeHead(400).end();
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          clients.get(clientId)?.destroy();
          clients.set(clientId, res);
          clientStates.set(clientId, { render: null, mode: null });
          if (current) {
            res.write(`data: ${JSON.stringify({ type: "apply", ...current })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: "mode", ...modes })}\n\n`);
          res.on("close", () => {
            if (clients.get(clientId) === res) {
              clients.delete(clientId);
              clientStates.delete(clientId);
            }
          });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: "/__beauticode/apply",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }
          if (!(await authorized(req, tokenFile))) {
            sendJson(res, 401, { ok: false, error: "未授权的请求。" });
            return;
          }
          const body = await readJson(req);
          if (!validApplyPayload(body)) {
            sendJson(res, 400, { ok: false, error: "背景载荷无效。" });
            return;
          }
          current = {
            generation: body.generation,
            media: body.media,
            imageUrl: body.media === "clear" ? null : body.imageUrl,
            videoUrl: body.media === "video" ? body.videoUrl : null,
            startAt: body.media === "video" ? body.startAt ?? null : null,
          };
          if (body.media === "clear") modes.fish = false;
          for (const state of clientStates.values()) state.render = null;
          broadcast({ type: "apply", ...current });
          if (body.media === "clear") broadcast({ type: "mode", ...modes });
          sendJson(res, 200, { ok: true });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: "/__beauticode/mode",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }
          if (!(await authorized(req, tokenFile))) {
            sendJson(res, 401, { ok: false, error: "未授权的请求。" });
            return;
          }
          const body = await readJson(req);
          const keys = Object.keys(body);
          if (
            keys.length === 0 ||
            keys.some((key) => !["fish", "muted", "tone"].includes(key)) ||
            ("fish" in body && typeof body.fish !== "boolean") ||
            ("muted" in body && typeof body.muted !== "boolean") ||
            ("tone" in body && !validTone(body.tone))
          ) {
            sendJson(res, 400, { ok: false, error: "显示模式载荷无效。" });
            return;
          }
          if (typeof body.fish === "boolean") modes.fish = body.fish;
          if (typeof body.muted === "boolean") modes.muted = body.muted;
          if (validTone(body.tone)) modes.tone = body.tone;
          for (const state of clientStates.values()) state.mode = null;
          broadcast({ type: "mode", ...modes });
          sendJson(res, 200, { ok: true, modes: { ...modes } });
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: "/__beauticode/status",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            res.writeHead(405).end();
            return;
          }
          if (!(await authorized(req, tokenFile))) {
            sendJson(res, 401, { ok: false, error: "未授权的请求。" });
            return;
          }
          sendJson(res, 200, publicStatus(current, modes, clients, clientStates));
        },
      }),
      ctx.webServer.register({
        kind: "exact",
        path: "/__beauticode/ack",
        handler: async (req, res) => {
          if (req.method !== "POST" || !isSameOrigin(req)) {
            res.writeHead(req.method === "POST" ? 403 : 405).end();
            return;
          }
          const body = await readJson(req);
          const state = clientStates.get(body.clientId);
          if (!clients.has(body.clientId) || !state) {
            sendJson(res, 400, { ok: false, error: "渲染回执无效。" });
            return;
          }
          if (body.kind === "render") {
            if (
              !current ||
              body.generation !== current.generation ||
              body.media !== current.media ||
              typeof body.ok !== "boolean" ||
              typeof body.visible !== "boolean"
            ) {
              sendJson(res, 400, { ok: false, error: "渲染回执无效。" });
              return;
            }
            let playback = null;
            if (body.playback?.hasVideo === true) {
              if (
                !Number.isFinite(body.playback.currentTime) ||
                !Number.isFinite(body.playback.duration) ||
                typeof body.playback.muted !== "boolean" ||
                typeof body.playback.paused !== "boolean" ||
                typeof body.playback.blocked !== "boolean"
              ) {
                sendJson(res, 400, { ok: false, error: "播放状态回执无效。" });
                return;
              }
              playback = {
                currentTime: Math.max(0, body.playback.currentTime),
                duration: Math.max(0, body.playback.duration),
                hasVideo: true,
                muted: body.playback.muted,
                paused: body.playback.paused,
                blocked: body.playback.blocked,
              };
            }
            state.render = {
              generation: body.generation,
              media: body.media,
              ok: body.ok,
              visible: body.visible,
              error: typeof body.error === "string" ? body.error.slice(0, 300) : null,
              playback,
            };
          } else if (body.kind === "mode") {
            if (
              typeof body.fish !== "boolean" ||
              typeof body.muted !== "boolean" ||
              !validTone(body.tone) ||
              !["dark", "light"].includes(body.resolvedTone) ||
              typeof body.themeSynced !== "boolean" ||
              typeof body.blocked !== "boolean"
            ) {
              sendJson(res, 400, { ok: false, error: "显示模式回执无效。" });
              return;
            }
            state.mode = {
              fish: body.fish,
              muted: body.muted,
              tone: body.tone,
              resolvedTone: body.resolvedTone,
              themeSynced: body.themeSynced,
              blocked: body.blocked,
            };
          } else {
            sendJson(res, 400, { ok: false, error: "回执类型无效。" });
            return;
          }
          sendJson(res, 200, { ok: true });
        },
      }),
    ];

    return () => {
      disposeTap();
      for (const dispose of disposers) dispose();
      for (const response of clients.values()) response.destroy();
      clients.clear();
      clientStates.clear();
    };
  }, "beauticode-bridge: routes and browser injection");
}

#!/usr/bin/env node
/**
 * Long-lived loopback control plane for the Windows tray.
 *
 * Listens on 127.0.0.1 only. Every request needs:
 *   Authorization: Bearer <token>
 * where the bearer token is inherited through BEAUTICODE_CONTROL_TOKEN.
 *
 * Protocol (JSON):
 *   GET  /health
 *   GET  /status
 *   POST /apply/image   { "imagePath": "..." }
 *   POST /apply/video   { "videoPath": "...", "imagePath"?: "..." }
 *   POST /apply/clear   {}
 *   POST /reapply       {}   // republish active background into live sessions
 *   POST /theme/save    { "name": "..." }   // keep current image/video
 *   GET  /theme/list
 *   POST /theme/use     { "id": "..." }
 *   POST /theme/delete  { "id": "..." }
 *   POST /mode/fish     { "enabled": true|false }  // 摸鱼 — attribute only
 *   POST /mode/muted    { "muted": true|false }    // video sound; default muted
 *   POST /discover      {}
 *   POST /shutdown      {}
 */
import http from "node:http";
import process from "node:process";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

if (Number(process.versions.node.split(".", 1)[0]) < 22) {
  console.error("session-host requires Node.js 22 or newer");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const adapterEntry = pathToFileURL(
  path.resolve(repoRoot, "packages/adapter-codex/dist/index.js"),
).href;

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  const value = process.argv[idx + 1] ?? null;
  return value && !value.startsWith("--") ? value : null;
}

const token = process.env.BEAUTICODE_CONTROL_TOKEN;
delete process.env.BEAUTICODE_CONTROL_TOKEN;
const portArg = argValue("--port");
const dataRoot = argValue("--data-root");
const verifyMs = Number(argValue("--verify-ms") ?? "30000");
if (!Number.isFinite(verifyMs) || verifyMs < 0 || verifyMs > 300_000) {
  console.error("--verify-ms must be between 0 and 300000");
  process.exit(1);
}

if (!token || token.length < 24) {
  console.error("session-host requires a random control token (>=24 chars)");
  process.exit(1);
}

const adapter = await import(adapterEntry);

const sessionOpts = {
  verifyDeadlineMs: verifyMs,
  autoDiscover: true,
  // Tray must show immediately; CDP connect + first publish happen in background.
  deferHostConnect: true,
  onError: (err) => {
    console.error(`[session] ${err.message}`);
  },
  onStatus: (msg) => {
    console.error(`[session] ${msg}`);
  },
};
if (portArg) {
  const p = Number(portArg);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    console.error("--port must be 1–65535");
    process.exit(1);
  }
  sessionOpts.port = p;
  sessionOpts.autoDiscover = false;
}
if (dataRoot) sessionOpts.dataRoot = path.resolve(dataRoot);

const session = new adapter.BeautiSession(sessionOpts);
let shuttingDown = false;

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(
          Buffer.concat(chunks).toString("utf8") || "{}",
        );
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          const error = new Error("request body must be a JSON object");
          error.statusCode = 400;
          reject(error);
          return;
        }
        resolve(parsed);
      } catch (err) {
        if (err && typeof err === "object" && !err.statusCode) {
          err.statusCode = 400;
        }
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function publicTheme(theme) {
  return {
    id: theme.id,
    name: theme.name,
    type: theme.type,
    savedAt: theme.savedAt,
    ...(typeof theme.videoPositionSec === "number"
      ? { videoPositionSec: theme.videoPositionSec }
      : {}),
  };
}

function send(res, status, obj) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function unauthorized(res) {
  send(res, 401, { ok: false, error: "unauthorized" });
}

function checkAuth(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer(
  { maxHeaderSize: 16 * 1024, requestTimeout: 30_000 },
  async (req, res) => {
  try {
    if (!checkAuth(req)) {
      unauthorized(res);
      return;
    }
    if (shuttingDown) {
      send(res, 503, { ok: false, error: "shutting down" });
      return;
    }
    const url = req.url?.split("?")[0] ?? "";
    if (req.method === "GET" && url === "/health") {
      send(res, 200, {
        ok: true,
        port: session.cdpPort,
        open: session.isOpen,
        busy: session.isBusy,
        hostReady: session.isHostReady,
      });
      return;
    }
    if (req.method === "GET" && url === "/status") {
      const st = await session.status();
      send(res, 200, {
        ok: true,
        hostReady: session.isHostReady,
        ...st,
      });
      return;
    }
    if (req.method === "GET" && url === "/guidance") {
      send(res, 200, { ok: true, guidance: adapter.getCodexLaunchGuidance() });
      return;
    }
    if (req.method === "POST" && url === "/discover") {
      const endpoints = await adapter.discoverCdpEndpoints({ requirePages: true });
      send(res, 200, {
        ok: endpoints.length > 0,
        endpoints: endpoints.map((e) => ({
          port: e.port,
          browser: e.browser,
          primaryPages: e.primaryPages,
          source: e.source,
        })),
      });
      return;
    }
    if (req.method === "POST" && url === "/apply/image") {
      const body = await readBody(req);
      if (typeof body.imagePath !== "string" || !body.imagePath) {
        send(res, 400, { ok: false, error: "imagePath required" });
        return;
      }
      const result = await session.apply({
        type: "image",
        imagePath: path.resolve(body.imagePath),
      });
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/apply/video") {
      const body = await readBody(req);
      if (typeof body.videoPath !== "string" || !body.videoPath) {
        send(res, 400, {
          ok: false,
          error: "videoPath required (MP4). imagePath optional poster.",
        });
        return;
      }
      const videoInput = {
        type: "video",
        videoPath: path.resolve(body.videoPath),
      };
      if (typeof body.imagePath === "string" && body.imagePath) {
        videoInput.imagePath = path.resolve(body.imagePath);
      }
      const result = await session.apply(videoInput);
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/apply/clear") {
      const result = await session.apply({ type: "clear" });
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/reapply") {
      const result = await session.reapply();
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/theme/save") {
      const body = await readBody(req);
      if (typeof body.name !== "string" || !body.name.trim()) {
        send(res, 400, { ok: false, error: "name required" });
        return;
      }
      try {
        const theme = await session.saveCurrentTheme(body.name);
        send(res, 200, { ok: true, theme: publicTheme(theme) });
      } catch (err) {
        send(res, 422, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (req.method === "GET" && url === "/theme/list") {
      const themes = await session.listSavedThemes();
      send(res, 200, { ok: true, themes: themes.map(publicTheme) });
      return;
    }
    if (req.method === "POST" && url === "/theme/use") {
      const body = await readBody(req);
      if (typeof body.id !== "string" || !body.id.trim()) {
        send(res, 400, { ok: false, error: "id required" });
        return;
      }
      const result = await session.useSavedTheme(body.id.trim());
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/theme/delete") {
      const body = await readBody(req);
      if (typeof body.id !== "string" || !body.id.trim()) {
        send(res, 400, { ok: false, error: "id required" });
        return;
      }
      try {
        const deleted = await session.deleteSavedTheme(body.id.trim());
        send(res, deleted ? 200 : 404, {
          ok: deleted,
          deleted,
          ...(deleted ? {} : { error: "Saved theme not found." }),
        });
      } catch (err) {
        send(res, 422, {
          ok: false,
          deleted: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (req.method === "POST" && url === "/mode/fish") {
      const body = await readBody(req);
      if (typeof body.enabled !== "boolean") {
        send(res, 400, { ok: false, error: "enabled boolean required" });
        return;
      }
      const result = await session.setFishMode(body.enabled);
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/mode/muted") {
      const body = await readBody(req);
      if (typeof body.muted !== "boolean") {
        send(res, 400, { ok: false, error: "muted boolean required" });
        return;
      }
      const result = await session.setMuted(body.muted);
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/mode/tone") {
      const body = await readBody(req);
      if (!["dark", "light", "auto"].includes(body.tone)) {
        send(res, 400, { ok: false, error: "tone must be dark, light, or auto" });
        return;
      }
      const result = await session.setBackgroundTone(body.tone);
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/shutdown") {
      send(res, 200, { ok: true });
      setImmediate(() => void shutdown(0));
      return;
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    const status =
      err && typeof err === "object" && Number.isInteger(err.statusCode)
        ? err.statusCode
        : 500;
    send(res, status, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  },
);
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const serverClosed = new Promise((resolve) => server.close(() => resolve()));
  server.closeIdleConnections?.();
  try {
    await session.stop();
  } catch {
    /* ignore */
  }
  server.closeAllConnections?.();
  await serverClosed;
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1_000).unref?.();
}

try {
  await session.start();
} catch (err) {
  console.error(
    err instanceof Error ? err.message : String(err),
  );
  console.error("session-host: failed to start BeautiSession (fail closed)");
  process.exit(1);
}

await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", () => resolve());
  server.on("error", reject);
});
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
const addr = server.address();
const listenPort = typeof addr === "object" && addr ? addr.port : 0;
// Machine-readable ready line for the tray launcher (stdout).
console.log(
  JSON.stringify({
    ready: true,
    controlPort: listenPort,
    cdpPort: session.cdpPort,
  }),
);

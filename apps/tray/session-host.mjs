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
 *   POST /apply/image   { "imagePath": "...", "source"?: "managed"|"local" }
 *   POST /apply/video   { "videoPath": "...", "imagePath"?: "...", "source"?: "managed"|"local", "startAt"?: number }
 *   POST /apply/clear   {}
 *   POST /reapply       {}   // republish active background into live sessions
 *   POST /theme/apply   { "name": "...", "input": ApplyInput }
 *   POST /theme/save    { "name": "..." }   // keep current image/video
 *   GET  /theme/list
 *   POST /theme/use     { "id": "..." }
 *   POST /theme/delete  { "id": "..." }
 *   POST /mode/fish     { "enabled": true|false }  // 摸鱼 — attribute only
 *   POST /mode/muted    { "muted": true|false }    // video sound; default muted
 *   POST /discover      {}
 *   POST /shutdown      {}
 */
import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isPidAlive,
  removeDshControlFile,
  removeSessionHostFile,
  writeDshControlFile,
  writeSessionHostFile,
} from "../../integrations/deepseek-harness/control-client.mjs";

if (Number(process.versions.node.split(".", 1)[0]) < 22) {
  console.error("session-host 需要 Node.js 22 或更高版本。");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  const value = process.argv[idx + 1] ?? null;
  return value && !value.startsWith("--") ? value : null;
}

function parseImportMode(value) {
  if (value == null) return undefined;
  if (value === "managed" || value === "local") return value;
  throw new Error("source 必须是 managed 或 local。");
}

function parseThemeApplyInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("input 必须是图片或视频导入参数。");
  }
  if (value.type === "image") {
    if (typeof value.imagePath !== "string" || !value.imagePath) {
      throw new Error("图片主题必须提供 imagePath。");
    }
    const input = {
      type: "image",
      imagePath: path.resolve(value.imagePath),
      source: parseImportMode(value.source),
    };
    if (value.effects && typeof value.effects === "object") {
      input.effects = value.effects;
    }
    return input;
  }
  if (value.type === "video") {
    if (typeof value.videoPath !== "string" || !value.videoPath) {
      throw new Error("视频主题必须提供 videoPath。");
    }
    const input = {
      type: "video",
      videoPath: path.resolve(value.videoPath),
      source: parseImportMode(value.source),
    };
    if (typeof value.imagePath === "string" && value.imagePath) {
      input.imagePath = path.resolve(value.imagePath);
    }
    if (value.startAt != null) {
      const startAt = Number(value.startAt);
      if (!Number.isFinite(startAt) || startAt < 0) {
        throw new Error("startAt 必须是非负数字（秒）。");
      }
      input.startAt = startAt;
    }
    return input;
  }
  throw new Error("input.type 必须是 image 或 video。");
}

const hostKind = argValue("--host") ?? "codex";
if (hostKind !== "codex" && hostKind !== "dsh") {
  console.error("--host 必须是 codex 或 dsh。");
  process.exit(1);
}
const adapterFolder = hostKind === "dsh" ? "adapter-dsh" : "adapter-codex";
const adapterEntry = pathToFileURL(
  path.resolve(repoRoot, `packages/${adapterFolder}/dist/index.js`),
).href;

const token = process.env.BEAUTICODE_CONTROL_TOKEN;
delete process.env.BEAUTICODE_CONTROL_TOKEN;
const portArg = argValue("--port");
const dshUrl = argValue("--dsh-url") ?? "http://127.0.0.1:3080";
const dataRoot = argValue("--data-root");
const parentPidArg = argValue("--parent-pid");
let parentPid = null;
if (parentPidArg != null) {
  parentPid = Number(parentPidArg);
  if (!Number.isInteger(parentPid) || parentPid < 1) {
    console.error("--parent-pid 必须是正整数。");
    process.exit(1);
  }
  if (!isPidAlive(parentPid)) {
    console.error("session-host：父进程已退出。");
    process.exit(1);
  }
}
const verifyMs = Number(argValue("--verify-ms") ?? "30000");
if (!Number.isFinite(verifyMs) || verifyMs < 0 || verifyMs > 300_000) {
  console.error("--verify-ms 必须在 0 到 300000 之间。");
  process.exit(1);
}

if (!token || token.length < 24) {
  console.error("session-host 需要长度至少为 24 个字符的随机控制令牌。");
  process.exit(1);
}

const adapter = await import(adapterEntry);
const toChineseErrorMessage = adapter.toChineseErrorMessage;

const sessionOpts = {
  verifyDeadlineMs: verifyMs,
  autoDiscover: true,
  // Tray must show immediately; CDP connect + first publish happen in background.
  deferHostConnect: true,
  onError: (err) => {
    console.error(`[session] ${toChineseErrorMessage(err)}`);
  },
  onStatus: (msg) => {
    console.error(`[session] ${msg}`);
  },
};
if (hostKind === "dsh") {
  sessionOpts.baseUrl = dshUrl;
  sessionOpts.honorTrayHandoff = false;
}
if (portArg) {
  const p = Number(portArg);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    console.error("--port 必须是 1–65535 之间的整数。");
    process.exit(1);
  }
  sessionOpts.port = p;
  sessionOpts.autoDiscover = false;
}
if (dataRoot) sessionOpts.dataRoot = path.resolve(dataRoot);
const bundledGalleryHi = path.join(
  repoRoot,
  "assets",
  "themes",
  "internal-beyond",
  "bg-canvas-4k.png",
);
const bundledGalleryLo = path.join(
  repoRoot,
  "assets",
  "themes",
  "internal-beyond",
  "bg-canvas.png",
);
if (fs.existsSync(bundledGalleryHi)) {
  sessionOpts.bundledGalleryImagePath = bundledGalleryHi;
} else if (fs.existsSync(bundledGalleryLo)) {
  sessionOpts.bundledGalleryImagePath = bundledGalleryLo;
}

const SessionClass = hostKind === "dsh" ? adapter.DshSession : adapter.BeautiSession;
const session = new SessionClass(sessionOpts);
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
    ...(theme.bundled ? { bundled: true } : {}),
    ...(typeof theme.videoPositionSec === "number"
      ? { videoPositionSec: theme.videoPositionSec }
      : {}),
  };
}

function send(res, status, obj) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(
    obj && typeof obj.error === "string"
      ? { ...obj, error: toChineseErrorMessage(obj.error) }
      : obj,
  );
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function unauthorized(res) {
  send(res, 401, { ok: false, error: "请求未授权。" });
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
  { maxHeaderSize: 16 * 1024, requestTimeout: 180_000 },
  async (req, res) => {
  try {
    if (!checkAuth(req)) {
      unauthorized(res);
      return;
    }
    if (shuttingDown) {
      send(res, 503, { ok: false, error: "服务正在关闭。" });
      return;
    }
    const url = req.url?.split("?")[0] ?? "";
    if (req.method === "GET" && url === "/health") {
      send(res, 200, {
        ok: true,
        host: session.descriptor,
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
      send(res, 200, {
        ok: true,
        guidance:
          hostKind === "dsh"
            ? {
                title: "连接 DeepSeek Harness",
                steps: [
                  "自己运行 dsh web（需已加载 beautiCode 插件）。",
                  "在浏览器中打开 DSH Web 页面。",
                  "回到 beautiCode 托盘选择图片。",
                ],
              }
            : adapter.getCodexLaunchGuidance(),
      });
      return;
    }
    if (req.method === "POST" && url === "/discover") {
      if (hostKind === "dsh") {
        const status = await session.status();
        send(res, 200, {
          ok: status.sessions > 0,
          endpoints: status.sessions > 0
            ? [{ port: status.port, browser: "DeepSeek Harness", primaryPages: status.sessions, source: "bridge" }]
            : [],
        });
        return;
      }
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
        send(res, 400, { ok: false, error: "必须提供 imagePath。" });
        return;
      }
      const imageInput = {
        type: "image",
        imagePath: path.resolve(body.imagePath),
      };
      imageInput.source = parseImportMode(body.source);
      if (body.effects && typeof body.effects === "object") {
        imageInput.effects = body.effects;
      }
      const result = await session.apply(imageInput);
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/apply/video") {
      const body = await readBody(req);
      if (typeof body.videoPath !== "string" || !body.videoPath) {
        send(res, 400, {
          ok: false,
          error: "必须提供 videoPath（MP4）；imagePath 可选，用作海报图片。",
        });
        return;
      }
      const videoInput = {
        type: "video",
        videoPath: path.resolve(body.videoPath),
      };
      videoInput.source = parseImportMode(body.source);
      if (typeof body.imagePath === "string" && body.imagePath) {
        videoInput.imagePath = path.resolve(body.imagePath);
      }
      if (body.startAt != null) {
        const startAt = Number(body.startAt);
        if (!Number.isFinite(startAt) || startAt < 0) {
          send(res, 400, { ok: false, error: "startAt 必须是非负数字（秒）。" });
          return;
        }
        videoInput.startAt = startAt;
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
    if (req.method === "POST" && url === "/theme/apply") {
      const body = await readBody(req);
      if (typeof body.name !== "string" || !body.name.trim()) {
        send(res, 400, { ok: false, error: "必须提供主题名称。" });
        return;
      }
      if (typeof session.applyAndSaveTheme !== "function") {
        send(res, 501, { ok: false, error: "当前会话不支持应用并保存主题。" });
        return;
      }
      const input = parseThemeApplyInput(body.input);
      const result = await session.applyAndSaveTheme(input, body.name.trim());
      send(
        res,
        result.ok ? 200 : 422,
        result.ok ? { ...result, theme: publicTheme(result.theme) } : result,
      );
      return;
    }
    if (req.method === "POST" && url === "/theme/save") {
      const body = await readBody(req);
      if (typeof body.name !== "string" || !body.name.trim()) {
        send(res, 400, { ok: false, error: "必须提供主题名称。" });
        return;
      }
      try {
        const theme = await session.saveCurrentTheme(body.name);
        send(res, 200, { ok: true, theme: publicTheme(theme) });
      } catch (err) {
        send(res, 422, {
          ok: false,
          error: toChineseErrorMessage(err),
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
        send(res, 400, { ok: false, error: "必须提供主题 ID。" });
        return;
      }
      const result = await session.useSavedTheme(body.id.trim());
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/theme/delete") {
      const body = await readBody(req);
      if (typeof body.id !== "string" || !body.id.trim()) {
        send(res, 400, { ok: false, error: "必须提供主题 ID。" });
        return;
      }
      try {
        const deleted = await session.deleteSavedTheme(body.id.trim());
        send(res, deleted ? 200 : 404, {
          ok: deleted,
          deleted,
          ...(deleted ? {} : { error: "未找到已保存的主题。" }),
        });
      } catch (err) {
        send(res, 422, {
          ok: false,
          deleted: false,
          error: toChineseErrorMessage(err),
        });
      }
      return;
    }
    if (req.method === "POST" && url === "/mode/fish") {
      const body = await readBody(req);
      if (typeof body.enabled !== "boolean") {
        send(res, 400, { ok: false, error: "enabled 必须是布尔值。" });
        return;
      }
      const result = await session.setFishMode(body.enabled);
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/mode/muted") {
      const body = await readBody(req);
      if (typeof body.muted !== "boolean") {
        send(res, 400, { ok: false, error: "muted 必须是布尔值。" });
        return;
      }
      const result = await session.setMuted(body.muted);
      send(res, result.ok ? 200 : 422, result);
      return;
    }
    if (req.method === "POST" && url === "/mode/tone") {
      const body = await readBody(req);
      if (!["dark", "light", "auto"].includes(body.tone)) {
        send(res, 400, { ok: false, error: "tone 必须是 dark、light 或 auto。" });
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
    send(res, 404, { ok: false, error: "未找到请求的资源。" });
  } catch (err) {
    const status =
      err && typeof err === "object" && Number.isInteger(err.statusCode)
        ? err.statusCode
        : 500;
    send(res, status, {
      ok: false,
      error: toChineseErrorMessage(err),
    });
  }
  },
);
server.headersTimeout = 10_000;
server.requestTimeout = 180_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (hostKind === "dsh") {
    try {
      await removeDshControlFile({ dataRoot: session.dataRoot, pid: process.pid });
    } catch {
      /* ignore */
    }
  }
  try {
    await removeSessionHostFile({ dataRoot: session.dataRoot, pid: process.pid });
  } catch {
    /* ignore */
  }
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
    toChineseErrorMessage(err),
  );
  console.error("session-host：beautiCode 会话启动失败，已安全退出。");
  process.exit(1);
}

await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", () => resolve());
  server.on("error", reject);
});
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
if (parentPid != null) {
  const parentWatch = setInterval(() => {
    if (!isPidAlive(parentPid)) void shutdown(0);
  }, 500);
  parentWatch.unref?.();
}
const addr = server.address();
const listenPort = typeof addr === "object" && addr ? addr.port : 0;
const controlUrl = `http://127.0.0.1:${listenPort}`;
try {
  await writeSessionHostFile({
    dataRoot: session.dataRoot,
    host: hostKind,
    url: controlUrl,
    token,
    pid: process.pid,
  });
} catch (error) {
  console.error(
    `session-host：无法发布控制面文件：${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
if (hostKind === "dsh") {
  try {
    await writeDshControlFile({
      dataRoot: session.dataRoot,
      url: controlUrl,
      token,
      pid: process.pid,
    });
  } catch (error) {
    console.error(
      `session-host：无法发布 DSH 控制面，对话导入和斜杠命令将不可用：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
// Machine-readable ready line for the tray launcher (stdout).
console.log(
  JSON.stringify({
    ready: true,
    host: hostKind,
    controlPort: listenPort,
    cdpPort: session.cdpPort,
  }),
);

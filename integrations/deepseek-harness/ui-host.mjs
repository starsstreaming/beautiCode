import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createBeauticodeActions } from "./agent.mjs";
import { callDshControl } from "./control-client.mjs";
import { hasLiveTray, resolveApplyBackend, stopInProcessSession } from "./host-apply.mjs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;

export function parseImportFilename(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "缺少文件名。" };
  }
  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep raw */
  }
  const name = path.basename(decoded.replaceAll("\\", "/"));
  if (!name || name === "." || name === "..") {
    return { ok: false, error: "文件名无效。" };
  }
  const ext = path.extname(name).toLowerCase();
  if (ext === ".mp4") {
    return { ok: true, name, ext, kind: "video", maxBytes: MAX_VIDEO_BYTES };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { ok: true, name, ext, kind: "image", maxBytes: MAX_IMAGE_BYTES };
  }
  return { ok: false, error: "只支持图片（jpg / jpeg / png / webp / avif）或 MP4 视频。" };
}

function limitBytes(maxBytes) {
  let size = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("文件过大。");
        error.statusCode = 413;
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}

function publicThemes(list) {
  return (Array.isArray(list) ? list : []).map((theme) => ({
    id: theme.id,
    name: theme.name,
    type: theme.type ?? null,
  }));
}

async function canReachBridge(baseUrl) {
  const origin = typeof baseUrl === "string" && baseUrl ? baseUrl : "http://127.0.0.1:3080";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(new URL("__beauticode/version", origin.endsWith("/") ? origin : `${origin}/`), {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createBeauticodeUi({ dataRoot, baseUrl, getBaseUrl, sendJson, isSameOrigin, readJson }) {
  const options = {
    dataRoot,
    get baseUrl() {
      if (typeof getBaseUrl === "function") return getBaseUrl();
      return baseUrl;
    },
  };
  const actions = createBeauticodeActions(options);
  let restoreStarted = false;

  async function restoreOnce() {
    if (await hasLiveTray(dataRoot)) {
      return callDshControl(dataRoot, {
        method: "POST",
        path: "/reapply",
        body: {},
        timeoutMs: 30_000,
      });
    }
    if (!(await canReachBridge(options.baseUrl))) return;
    const resolved = await resolveApplyBackend(options);
    if (resolved.kind === "tray") {
      return callDshControl(dataRoot, {
        method: "POST",
        path: "/reapply",
        body: {},
        timeoutMs: 30_000,
      });
    }
    return resolved.session.reapply();
  }

  return {
    dispose() {
      return stopInProcessSession(dataRoot);
    },
    scheduleRestore() {
      if (restoreStarted) return;
      restoreStarted = true;
      queueMicrotask(() => {
        void restoreOnce().catch(() => {
          restoreStarted = false;
        });
      });
    },

    async status(req, res) {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const status = await actions.status();
        const listed = await actions.listThemes();
        const background = status.background ?? null;
        sendJson(res, 200, {
          ok: true,
          media: background?.type ?? null,
          muted: status.muted !== false,
          themes: publicThemes(listed.themes),
          message: status.message,
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async importFile(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const parsed = parseImportFilename(req.headers["x-beauticode-filename"]);
      if (!parsed.ok) {
        req.resume();
        sendJson(res, 400, { ok: false, error: parsed.error });
        return;
      }
      const length = Number(req.headers["content-length"]);
      if (Number.isFinite(length) && length > parsed.maxBytes) {
        req.resume();
        sendJson(res, 413, { ok: false, error: "文件过大。" });
        return;
      }
      const tmpDir = path.join(dataRoot, "tmp");
      await fsp.mkdir(tmpDir, { recursive: true });
      const tmpPath = path.join(
        tmpDir,
        `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${parsed.ext}`,
      );
      try {
        await pipeline(req, limitBytes(parsed.maxBytes), fs.createWriteStream(tmpPath));
        const result =
          parsed.kind === "video"
            ? await actions.applyVideo({ path: tmpPath })
            : await actions.applyImage(tmpPath);
        sendJson(res, 200, result);
      } catch (error) {
        const status = error?.statusCode === 413 ? 413 : 422;
        sendJson(res, status, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
      }
    },

    async clear(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      try {
        sendJson(res, 200, await actions.clear());
      } catch (error) {
        sendJson(res, 422, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async mode(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readJson(req);
      if (typeof body.muted !== "boolean" || Object.keys(body).some((key) => key !== "muted")) {
        sendJson(res, 400, { ok: false, error: "只接受 muted 开关。" });
        return;
      }
      try {
        sendJson(res, 200, await actions.setMuted(body.muted));
      } catch (error) {
        sendJson(res, 422, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async useTheme(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readJson(req);
      if (typeof body.id !== "string" || !body.id.trim()) {
        sendJson(res, 400, { ok: false, error: "必须提供主题。" });
        return;
      }
      try {
        sendJson(res, 200, await actions.useTheme(body.id.trim()));
      } catch (error) {
        sendJson(res, 422, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

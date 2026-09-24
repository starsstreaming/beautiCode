import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  SKIN_CENTER_ORIGIN,
  downloadApprovedAsset,
  getApprovedSkin,
  listApprovedSkins,
} from "@beauticode/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKIN_ID = /^skin-[a-z0-9]{8,40}$/;
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
// Small catalog/metadata requests get a tight budget; the media download uses
// INSTALL_TIMEOUT_MS so a large video on a slow link can still finish.
const REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function isSafeSkinId(id) {
  return typeof id === "string" && SKIN_ID.test(id);
}

export function normalizeSkinCenterUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.protocol === "http:" && !LOOPBACK.has(url.hostname.toLowerCase())) return null;
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

// 皮肤中心地址由插件内置固定：catalog 与资产下载都在 core 层用
// assertResponseOrigin 硬校验最终 origin 与 SKIN_CENTER_ORIGIN 一致，
// 支持外部配置会造成「UI 显示镜像站、下载仍走内置 origin」的假象。
// 因此不读取环境变量或 skin-center.json（I-4：删除无调用点的死代码，
// UI 文案已同步更正为「地址内置固定」）。
export async function resolveConfiguredSkinCenterUrl() {
  return SKIN_CENTER_ORIGIN;
}

export function skinUrl(center, id, part = "") {
  const origin = normalizeSkinCenterUrl(center);
  if (!origin || !isSafeSkinId(id)) {
    throw new Error("Skin center is not configured.");
  }
  return part ? `${origin}/api/skins/${id}/${part}` : `${origin}/api/skins/${id}`;
}

export async function downloadToFile(url, dest, { maxBytes, expectedOrigin, onProgress, signal } = {}) {
  const expected = new URL(url);
  if (expectedOrigin && expected.origin !== expectedOrigin) {
    throw new Error("Skin media download host mismatch.");
  }
  // Bound every media download; a stalling skin center must not leave the
  // gallery request open forever. Callers may pass an AbortSignal to cancel
  // early when the browser client disconnects.
  const timeoutSignal = AbortSignal.timeout(INSTALL_TIMEOUT_MS);
  const response = await fetch(url, {
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  if (!response.ok || !response.body) {
    throw new Error("Skin media download failed.");
  }
  const finalUrl = new URL(response.url);
  if (finalUrl.origin !== expected.origin) {
    throw new Error("Skin media download host mismatch.");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error("Skin media download exceeded the size limit.");
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let size = 0;
  let lastReportedAt = 0;
  let lastReportedBytes = 0;
  const limiter = new Transform({
    transform(chunk, _enc, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new Error("Skin media download exceeded the size limit."));
        return;
      }
      // Throttle progress frames: one every 250 ms or every 1 MiB, whichever
      // comes first. A chunk-level frame floods the NDJSON stream on large
      // videos and forces a DOM write per chunk in the browser client.
      const now = Date.now();
      if (now - lastReportedAt >= 250 || size - lastReportedBytes >= 1024 * 1024) {
        lastReportedAt = now;
        lastReportedBytes = size;
        onProgress?.(size, Number.isFinite(length) ? length : 0);
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (size !== lastReportedBytes) {
        onProgress?.(size, Number.isFinite(length) ? length : 0);
      }
      callback();
    },
  });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(dest));
  return { bytes: size, contentType: response.headers.get("content-type") ?? null };
}

function extensionOf(url, fallback) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (ext) return ext;
  } catch {
    /* use fallback */
  }
  return fallback;
}

// Theme names are persisted via saveCurrentTheme, which rejects characters that
// are illegal in filenames. Normalize gallery skin display names the same way
// local filenames are normalized so a name like "Cyberpunk: Neon" still installs.
function normalizeThemeName(value, fallback = "主题") {
  const name = String(value ?? "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return name || fallback;
}

// The /image endpoint is extensionless; derive the on-disk suffix from the
// response content-type so JPEG/WebP are not mislabeled as .png (which the
// image validator would then reject on a magic-byte mismatch).
function extensionForContentType(contentType) {
  const mime = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/avif":
      return ".avif";
    default:
      return null;
  }
}

export function createGalleryHandlers({ dataRoot, actions }) {
  async function importTheme(input) {
    if (typeof actions.importTheme === "function") {
      return actions.importTheme(input);
    }
    throw new Error("当前引擎不支持导入皮肤。");
  }

  return {
    async config(req, res, sendJson, isSameOrigin) {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const url = await resolveConfiguredSkinCenterUrl();
      sendJson(res, 200, { ok: true, url, enabled: Boolean(url) });
    },

    async catalog(req, res, sendJson, isSameOrigin) {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const incoming = new URL(req.url || "/", "http://127.0.0.1");
        const type = incoming.searchParams.get("type");
        const skins = await listApprovedSkins({
          query: {
            ...(incoming.searchParams.get("q") ? { q: incoming.searchParams.get("q") } : {}),
            ...(type === "image" || type === "video" ? { type } : {}),
          },
        });
        sendJson(res, 200, {
          ok: true,
          skins,
          nextCursor: null,
          url: SKIN_CENTER_ORIGIN,
        });
      } catch (error) {
        sendJson(res, 502, {
          ok: false,
          error: error instanceof Error ? error.message : "无法连接皮肤中心，请稍后重试。",
          skins: [],
        });
      }
    },

    async install(req, res, sendJson, isSameOrigin, readJson) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      // readJson 拒绝（400/413）时直接应答，避免错误冒泡成框架 500。
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, error?.statusCode ?? 400, {
          ok: false,
          error: error?.message || "请求无效。",
        });
        return;
      }
      const id = String(body.id ?? "").trim();
      if (!isSafeSkinId(id)) {
        sendJson(res, 400, { ok: false, error: "皮肤 ID 无效。" });
        return;
      }
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      const write = (payload) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
      };
      const tmpDir = path.join(dataRoot, "tmp", "gallery", `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
      // Cancel the download when the browser client disconnects (e.g. the UI
      // timeout aborts its fetch); otherwise a slow skin download keeps going
      // and can still commit a background after the controls recovered.
      const clientAbort = new AbortController();
      const onClose = () => clientAbort.abort(new Error("客户端已断开。"));
      res.once("close", onClose);
      try {
        write({ phase: "fetch" });
        const skin = await getApprovedSkin(id);
        await fsp.mkdir(tmpDir, { recursive: true });
        write({ phase: "download", part: "image" });
        const imageDownload = await downloadApprovedAsset(skin, "image", {
          directory: tmpDir,
          signal: clientAbort.signal,
          onProgress: (done, total) => write({ phase: "download", part: "image", done, total }),
        });
        const imagePath = imageDownload.filePath;
        let videoPath;
        if (skin.type === "video") {
          write({ phase: "download", part: "video" });
          const videoDownload = await downloadApprovedAsset(skin, "video", {
            directory: tmpDir,
            signal: clientAbort.signal,
            onProgress: (done, total) => write({ phase: "download", part: "video", done, total }),
          });
          videoPath = videoDownload.filePath;
        }
        // Skin-center media is downloaded into the store, so it is a managed
        // import. importTheme applies-and-saves atomically; the media is copied
        // before it returns, so tmpDir is safe to remove in finally.
        write({ phase: "apply" });
        // The apply/save step is atomic and cannot be interrupted; refuse to
        // start it when the client already went away so a disconnected UI does
        // not still commit and apply a background after the controls recovered.
        if (clientAbort.signal.aborted) throw new Error("客户端已断开。");
        const imported = await importTheme({
          name: normalizeThemeName(skin.name || id),
          imagePath,
          ...(videoPath ? { videoPath } : {}),
          ...(skin.effects ? { effects: skin.effects } : {}),
          source: "managed",
          provenance: {
            source: skin.source,
            sourceSkinId: skin.sourceSkinId,
            sourceVersion: skin.sourceVersion,
          },
        });
        write({
          ok: true,
          phase: "done",
          theme: imported.theme || imported,
          message: imported.message || `已安装并应用「${skin.name}」。`,
        });
      } catch (error) {
        write({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        res.off("close", onClose);
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        res.end();
      }
    },
  };
}

export const GALLERY_INSTALL_TIMEOUT_MS = INSTALL_TIMEOUT_MS;

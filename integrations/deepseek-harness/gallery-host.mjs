import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKIN_ID = /^skin-[a-z0-9]{8,40}$/;
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
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

export async function readBundledSkinCenterUrl() {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(here, "skin-center.json"), "utf8"));
    return normalizeSkinCenterUrl(raw.url);
  } catch {
    return null;
  }
}

export async function resolveConfiguredSkinCenterUrl() {
  return (
    normalizeSkinCenterUrl(process.env.BEAUTICODE_SKIN_CENTER) ??
    (await readBundledSkinCenterUrl())
  );
}

export function skinUrl(center, id, part = "") {
  const origin = normalizeSkinCenterUrl(center);
  if (!origin || !isSafeSkinId(id)) {
    throw new Error("Skin center is not configured.");
  }
  return part ? `${origin}/api/skins/${id}/${part}` : `${origin}/api/skins/${id}`;
}

export async function downloadToFile(url, dest, { maxBytes, expectedOrigin, onProgress } = {}) {
  const expected = new URL(url);
  if (expectedOrigin && expected.origin !== expectedOrigin) {
    throw new Error("Skin media download host mismatch.");
  }
  const response = await fetch(url, { redirect: "follow" });
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
  const limiter = new Transform({
    transform(chunk, _enc, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new Error("Skin media download exceeded the size limit."));
        return;
      }
      onProgress?.(size, Number.isFinite(length) ? length : 0);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(dest));
  return { bytes: size };
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
      const center = await resolveConfiguredSkinCenterUrl();
      if (!center) {
        sendJson(res, 200, {
          ok: false,
          error: "尚未配置皮肤中心地址。",
          skins: [],
        });
        return;
      }
      const incoming = new URL(req.url || "/", "http://127.0.0.1");
      const target = new URL("/api/catalog", `${center}/`);
      target.search = incoming.search;
      const response = await fetch(target, { headers: { accept: "application/json" } });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok === false) {
        sendJson(res, 422, {
          ok: false,
          error: body?.error || "无法读取皮肤目录。",
          skins: [],
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        skins: Array.isArray(body.skins) ? body.skins : [],
        nextCursor: body.nextCursor ?? null,
        url: center,
      });
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
      const body = await readJson(req);
      const id = String(body.id ?? "").trim();
      if (!isSafeSkinId(id)) {
        sendJson(res, 400, { ok: false, error: "皮肤 ID 无效。" });
        return;
      }
      const center = await resolveConfiguredSkinCenterUrl();
      if (!center) {
        sendJson(res, 422, { ok: false, error: "尚未配置皮肤中心地址。" });
        return;
      }
      const origin = new URL(center).origin;
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      const write = (payload) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
      };
      const tmpDir = path.join(dataRoot, "tmp", "gallery", `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        write({ phase: "fetch" });
        const metaRes = await fetch(skinUrl(center, id), { headers: { accept: "application/json" } });
        const meta = await metaRes.json().catch(() => null);
        const skin = meta?.skin;
        if (!metaRes.ok || !skin || skin.status && skin.status !== "approved") {
          throw new Error("Skin is not available for download.");
        }
        await fsp.mkdir(tmpDir, { recursive: true });
        const imageUrl = skinUrl(center, id, "image");
        const imagePath = path.join(tmpDir, `image${extensionOf(imageUrl, ".png")}`);
        write({ phase: "download", part: "image" });
        await downloadToFile(imageUrl, imagePath, {
          maxBytes: MAX_IMAGE_BYTES,
          expectedOrigin: origin,
          onProgress: (done, total) => write({ phase: "download", part: "image", done, total }),
        });
        let videoPath;
        if (skin.type === "video") {
          const videoUrl = skinUrl(center, id, "video");
          videoPath = path.join(tmpDir, "background.mp4");
          write({ phase: "download", part: "video" });
          await downloadToFile(videoUrl, videoPath, {
            maxBytes: MAX_VIDEO_BYTES,
            expectedOrigin: origin,
            onProgress: (done, total) => write({ phase: "download", part: "video", done, total }),
          });
        }
        write({ phase: "import" });
        const imported = await importTheme({
          name: String(skin.name || id).slice(0, 80),
          imagePath,
          ...(videoPath ? { videoPath } : {}),
          ...(skin.effects ? { effects: skin.effects } : {}),
          source: { kind: "skin-center", skinId: id, centerUrl: center },
        });
        write({ phase: "apply" });
        const applied = await actions.useTheme(imported.theme?.id || imported.id, undefined);
        fetch(skinUrl(center, id, "download"), { method: "POST" }).catch(() => {});
        write({
          ok: true,
          phase: "done",
          theme: imported.theme || imported,
          message: applied.message || `已安装并应用「${skin.name}」。`,
        });
      } catch (error) {
        write({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        res.end();
      }
    },
  };
}

export const GALLERY_INSTALL_TIMEOUT_MS = INSTALL_TIMEOUT_MS;

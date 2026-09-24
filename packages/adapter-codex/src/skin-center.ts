import fsp from "node:fs/promises";
import path from "node:path";
import {
  SKIN_CENTER_ORIGIN,
  downloadApprovedAsset,
  getApprovedSkin,
  isSafeSkinId,
  listApprovedSkins,
} from "@beauticode/core";
import type { BeautiSession } from "./session.js";

export { isSafeSkinId };

/** Kept for older callers; production resolution below is fixed by core. */
export function normalizeSkinCenterUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.protocol === "http:" && !new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname.toLowerCase())) {
      return null;
    }
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

export async function resolveSkinCenterUrl(): Promise<string> {
  return SKIN_CENTER_ORIGIN;
}

export async function skinCenterConfig(): Promise<{
  ok: true;
  url: string;
  enabled: true;
}> {
  return { ok: true, url: SKIN_CENTER_ORIGIN, enabled: true };
}

export async function skinCenterCatalog(query: {
  q?: string;
  type?: string;
}): Promise<{
  ok: boolean;
  skins: unknown[];
  nextCursor?: unknown;
  url?: string;
  error?: string;
}> {
  try {
    const type = query.type === "image" || query.type === "video" ? query.type : undefined;
    const skins = await listApprovedSkins({
      ...(query.q ? { query: { q: query.q, ...(type ? { type } : {}) } } : type ? { query: { type } } : {}),
    });
    return { ok: true, skins, nextCursor: null, url: SKIN_CENTER_ORIGIN };
  } catch (error) {
    return {
      ok: false,
      skins: [],
      url: SKIN_CENTER_ORIGIN,
      error: error instanceof Error ? error.message : "无法读取皮肤目录。",
    };
  }
}

function normalizeThemeName(value: unknown, fallback = "主题"): string {
  const name = String(value ?? "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return name || fallback;
}

export async function installSkinFromCenter(
  session: BeautiSession,
  id: string,
): Promise<{ ok: boolean; error?: string; theme?: unknown; message?: string }> {
  if (!isSafeSkinId(id)) return { ok: false, error: "皮肤 ID 无效。" };
  const tempDirs: string[] = [];
  try {
    const skin = await getApprovedSkin(id);
    const directory = path.join(session.dataRoot, "tmp", "gallery");
    const image = await downloadApprovedAsset(skin, "image", { directory });
    tempDirs.push(image.tempDir);
    let video: Awaited<ReturnType<typeof downloadApprovedAsset>> | undefined;
    if (skin.type === "video") {
      video = await downloadApprovedAsset(skin, "video", { directory });
      tempDirs.push(video.tempDir);
    }
    const provenance = {
      source: skin.source,
      sourceSkinId: skin.sourceSkinId,
      sourceVersion: skin.sourceVersion,
    } as const;
    const input = video
      ? {
          type: "video" as const,
          imagePath: image.filePath,
          videoPath: video.filePath,
          source: "managed" as const,
          ...(skin.effects ? { effects: skin.effects } : {}),
          provenance,
        }
      : {
          type: "image" as const,
          imagePath: image.filePath,
          source: "managed" as const,
          ...(skin.effects ? { effects: skin.effects } : {}),
          provenance,
        };
    const name = normalizeThemeName(skin.name || id);
    const result = await session.applyAndSaveTheme(input, name);
    if (!result.ok) return { ok: false, error: result.error || "安装失败。" };
    return {
      ok: true,
      theme: result.theme,
      message: `已安装并应用「${name}」。`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await Promise.all(
      tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})),
    );
  }
}

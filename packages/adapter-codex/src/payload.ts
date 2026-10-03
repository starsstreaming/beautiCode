import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostApplyPayload } from "@beauticode/core";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadRendererSource(): Promise<{
  cssText: string;
  runtimeIife: string;
  consoleSource: string;
}> {
  const [cssText, runtimeIife, consoleJs, galleryJs, themeJs] = await Promise.all([
    fs.readFile(path.join(here, "renderer", "background.css"), "utf8"),
    fs.readFile(path.join(here, "renderer", "background-runtime.js"), "utf8"),
    fs.readFile(path.join(here, "renderer", "console.js"), "utf8"),
    fs.readFile(path.join(here, "renderer", "gallery.js"), "utf8"),
    fs.readFile(path.join(here, "renderer", "theme.js"), "utf8"),
  ]);
  // Resolve host appearance after media installs, including healthy re-injects.
  const themedRuntime = `((...args) => Promise.resolve((${runtimeIife})(...args)).then(result => { ${themeJs}\nreturn result; }))`;
  return { cssText, runtimeIife: themedRuntime, consoleSource: `${consoleJs}\n${galleryJs}` };
}

/** 1×1 PNG. Video injects must not ship the live poster as a multi-MB data URL. */
export const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Keep Runtime.evaluate well under Chromium's debugger message budget. */
export const MAX_CDP_DATA_URL_CHARS = 180_000;

/**
 * Skip encoding stills above this size. ~128KiB file → ~170k data URL chars,
 * under MAX_CDP_DATA_URL_CHARS. Field: evaluate became unstable around 1.8MB.
 */
export const MAX_CDP_INLINE_IMAGE_BYTES = 128 * 1024;

/**
 * Codex injects media through Runtime.evaluate. Multi-MB stills (or video
 * posters) close the CDP socket; large files must use DOM.setFileInputFiles.
 */
export function slimCodexCdpPayload(payload: HostApplyPayload): HostApplyPayload {
  let imageDataUrl = payload.imageDataUrl;
  if (
    typeof imageDataUrl === "string" &&
    imageDataUrl.length > MAX_CDP_DATA_URL_CHARS
  ) {
    imageDataUrl =
      payload.media === "video" ? TINY_PNG_DATA_URL : null;
  }
  let video = payload.video;
  if (video?.mode === "blob" && video.dataUrl) {
    const { dataUrl: _drop, ...rest } = video;
    video = rest;
  }
  if (imageDataUrl === payload.imageDataUrl && video === payload.video) {
    return payload;
  }
  return { ...payload, imageDataUrl, video };
}

/**
 * Build the expression string executed inside the host page.
 * Values are JSON-encoded so user media URLs cannot break out of literals.
 * Host-only fields (video.localPath / imageLocalPath) are stripped.
 */
export function buildInjectionExpression(
  runtimeIife: string,
  payload: HostApplyPayload,
  cssText: string,
  forceRebuild = false,
): string {
  const slim = slimCodexCdpPayload(payload);
  let videoForPage: HostApplyPayload["video"] = null;
  if (slim.video) {
    const { localPath: _hostOnly, ...rest } = slim.video;
    videoForPage = rest;
  }
  const imageBlob =
    slim.media === "image" &&
    !slim.imageDataUrl &&
    Boolean(payload.imageLocalPath);
  // Positional args match background-runtime.js IIFE parameters:
  // (cssText, imageDataUrl, videoConfig, generation, imageUrl, forceRebuild, imageBlob)
  const args = [
    cssText,
    slim.imageDataUrl,
    videoForPage,
    slim.generation,
    slim.imageUrl ?? null,
    forceRebuild,
    imageBlob,
  ];
  // runtimeIife is a parenthesized arrow function expression.
  return `(${runtimeIife})(${args.map((a) => JSON.stringify(a)).join(",")})`;
}

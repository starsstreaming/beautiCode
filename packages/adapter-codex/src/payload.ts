import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostApplyPayload } from "@beauticode/core";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadRendererSource(): Promise<{
  cssText: string;
  runtimeIife: string;
}> {
  const cssText = await fs.readFile(
    path.join(here, "renderer", "background.css"),
    "utf8",
  );
  const runtimeIife = await fs.readFile(
    path.join(here, "renderer", "background-runtime.js"),
    "utf8",
  );
  return { cssText, runtimeIife };
}

/**
 * Build the expression string executed inside the host page.
 * Values are JSON-encoded so user media URLs cannot break out of literals.
 * Host-only fields (video.localPath) are stripped — never enter the page.
 */
export function buildInjectionExpression(
  runtimeIife: string,
  payload: HostApplyPayload,
  cssText: string,
  forceRebuild = false,
): string {
  let videoForPage: HostApplyPayload["video"] = null;
  if (payload.video) {
    const { localPath: _hostOnly, ...rest } = payload.video;
    videoForPage = rest;
  }
  // Positional args match background-runtime.js IIFE parameters:
  // (cssText, imageDataUrl, videoConfig, generation, imageUrl, forceRebuild)
  const args = [
    cssText,
    payload.imageDataUrl,
    videoForPage,
    payload.generation,
    payload.imageUrl ?? null,
    forceRebuild,
  ];
  // runtimeIife is a parenthesized arrow function expression.
  return `(${runtimeIife})(${args.map((a) => JSON.stringify(a)).join(",")})`;
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
} from "./constants.js";
import {
  validateImageFile,
  validateVideoFile,
} from "./media-validation.js";
import { normalizeBackgroundEffects } from "./types.js";
import type { BackgroundEffects } from "./types.js";

/** The production skin center is intentionally not configurable at runtime. */
export const SKIN_CENTER_ORIGIN = "https://hnnulwh.cn" as const;
export const SKIN_ID_PATTERN = /^skin-[a-z0-9]{8,40}$/;

const CATALOG_MAX_BYTES = 512 * 1024;
const METADATA_MAX_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export type SkinAssetPart = "image" | "video";

export interface ApprovedSkin {
  source: "hnnulwh";
  sourceSkinId: string;
  /** Explicit version or normalized publication revision; not necessarily semver. */
  sourceVersion: string;
  id: string;
  name: string;
  type: "image" | "video";
  status: "approved";
  assetUrl: string;
  effects?: BackgroundEffects;
}

export interface SkinCatalogDownload {
  filePath: string;
  tempDir: string;
  bytes: number;
  contentType: string | null;
  skin: ApprovedSkin;
  part: SkinAssetPart;
}

export class SkinCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkinCatalogError";
  }
}

type FetchImpl = typeof fetch;

function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkinCatalogError(message);
  }
  return value as Record<string, unknown>;
}

export function isSafeSkinId(id: unknown): id is string {
  return typeof id === "string" && SKIN_ID_PATTERN.test(id);
}

function assertSafeSkinId(id: unknown): asserts id is string {
  if (!isSafeSkinId(id)) throw new SkinCatalogError("Skin ID is invalid.");
}

function normalizeSourceVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) return null;
  return trimmed;
}

const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > 64) return null;
  const match = ISO_TIMESTAMP_PATTERN.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8] ?? "";
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59 ||
    (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))
  ) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.valueOf())) return null;
  // The normalized UTC value is stable across equivalent offsets and fractions.
  return parsed.toISOString();
}

function sourceRevisionOf(value: Record<string, unknown>): string {
  const version = normalizeSourceVersion(value.version);
  if (version) return `version:${version}`;

  const updatedAt = normalizeTimestamp(value.updatedAt);
  if (updatedAt) return `updatedAt:${updatedAt}`;

  const etag = normalizeSourceVersion(value.etag ?? value.ETag);
  if (etag) return `etag:${etag}`;

  const approvedAt = normalizeTimestamp(value.approvedAt);
  if (approvedAt) return `approved-at:${approvedAt}`;

  throw new SkinCatalogError(
    "Skin metadata has no version, updatedAt, ETag, or valid approvedAt publication revision.",
  );
}

function skinAssetUrl(id: string, part: SkinAssetPart): string {
  assertSafeSkinId(id);
  return `${SKIN_CENTER_ORIGIN}/api/skins/${id}/${part}`;
}

export function parseApprovedSkin(value: unknown): ApprovedSkin {
  const raw = assertObject(value, "Skin metadata is malformed.");
  assertSafeSkinId(raw.id);
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 80) : "";
  if (!name) throw new SkinCatalogError("Skin metadata has no name.");
  if (raw.type !== "image" && raw.type !== "video") {
    throw new SkinCatalogError("Skin metadata has an invalid type.");
  }
  if (raw.status !== "approved") {
    throw new SkinCatalogError("Skin is not approved.");
  }
  const sourceVersion = sourceRevisionOf(raw);
  const effects = normalizeBackgroundEffects(raw.effects);
  return {
    source: "hnnulwh",
    sourceSkinId: raw.id,
    sourceVersion,
    id: raw.id,
    name,
    type: raw.type,
    status: "approved",
    assetUrl: skinAssetUrl(raw.id, raw.type),
    ...(effects ? { effects } : {}),
  };
}

export function parseApprovedSkinCatalog(value: unknown): ApprovedSkin[] {
  const body = assertObject(value, "Skin catalog is malformed.");
  if (body.ok === false) throw new SkinCatalogError("Skin catalog is unavailable.");
  if (!Array.isArray(body.skins)) throw new SkinCatalogError("Skin catalog is malformed.");
  return body.skins.map(parseApprovedSkin);
}

function requestUrl(pathname: string, query?: Record<string, string | undefined>): URL {
  const target = new URL(pathname, `${SKIN_CENTER_ORIGIN}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) target.searchParams.set(key, value);
  }
  return target;
}

function assertResponseOrigin(response: Response, expected: URL): void {
  const finalUrl = response.url || expected.href;
  let final: URL;
  try {
    final = new URL(finalUrl);
  } catch {
    throw new SkinCatalogError("Skin center returned an invalid final URL.");
  }
  if (final.origin !== SKIN_CENTER_ORIGIN) {
    throw new SkinCatalogError("Skin center redirect left the trusted origin.");
  }
}

function responseLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SkinCatalogError("Skin center returned an invalid content length.");
  }
  return value;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const length = responseLength(response);
  if (length !== null && length > maxBytes) {
    throw new SkinCatalogError("Skin catalog response exceeds the size limit.");
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new SkinCatalogError("Skin catalog response exceeds the size limit.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      size += chunk.byteLength;
      if (size > maxBytes) throw new SkinCatalogError("Skin catalog response exceeds the size limit.");
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function fetchJson(
  target: URL,
  maxBytes: number,
  fetchImpl: FetchImpl,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(target, {
      redirect: "follow",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SkinCatalogError) throw error;
    throw new SkinCatalogError("Unable to connect to the skin center.");
  }
  assertResponseOrigin(response, target);
  if (!response.ok) throw new SkinCatalogError("Skin center request failed.");
  let text: string;
  try {
    text = await readBoundedText(response, maxBytes);
  } catch (error) {
    if (error instanceof SkinCatalogError) throw error;
    throw new SkinCatalogError("Skin center returned an invalid response.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SkinCatalogError("Skin center returned invalid JSON.");
  }
}

export async function listApprovedSkins(options: {
  query?: { q?: string; type?: "image" | "video" };
  fetchImpl?: FetchImpl;
} = {}): Promise<ApprovedSkin[]> {
  const target = requestUrl("/api/catalog", options.query);
  const body = await fetchJson(target, CATALOG_MAX_BYTES, options.fetchImpl ?? fetch);
  return parseApprovedSkinCatalog(body);
}

export async function getApprovedSkin(
  id: string,
  options: { fetchImpl?: FetchImpl } = {},
): Promise<ApprovedSkin> {
  assertSafeSkinId(id);
  const body = await fetchJson(
    requestUrl(`/api/skins/${id}`),
    METADATA_MAX_BYTES,
    options.fetchImpl ?? fetch,
  );
  const object = assertObject(body, "Skin metadata is malformed.");
  return parseApprovedSkin(object.skin ?? object);
}

function extensionForContentType(contentType: string | null, part: SkinAssetPart): string {
  const mime = (String(contentType ?? "").split(";", 1)[0] ?? "").trim().toLowerCase();
  if (part === "video") return mime === "video/quicktime" ? ".mov" : ".mp4";
  switch (mime) {
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/avif": return ".avif";
    default: return ".png";
  }
}

export async function downloadApprovedAsset(
  skin: ApprovedSkin,
  part: SkinAssetPart,
  options: {
    directory: string;
    fetchImpl?: FetchImpl;
    signal?: AbortSignal;
    onProgress?: (bytes: number, total: number | null) => void;
  },
): Promise<SkinCatalogDownload> {
  if (skin.source !== "hnnulwh" || skin.status !== "approved") {
    throw new SkinCatalogError("Skin metadata is not from the trusted catalog.");
  }
  if (part !== "image" && part !== "video") {
    throw new SkinCatalogError("Skin asset type is invalid.");
  }
  if (part === "video" && skin.type !== "video") {
    throw new SkinCatalogError("Image skins do not have a video asset.");
  }
  const target = new URL(skinAssetUrl(skin.sourceSkinId, part));
  const maxBytes = part === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(target, {
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (error instanceof SkinCatalogError) throw error;
    throw new SkinCatalogError("Skin asset download failed.");
  }
  assertResponseOrigin(response, target);
  if (!response.ok || !response.body) throw new SkinCatalogError("Skin asset download failed.");
  const total = responseLength(response);
  if (total !== null && total > maxBytes) throw new SkinCatalogError("Skin asset exceeds the size limit.");

  const downloadRoot = path.resolve(options.directory);
  await fsp.mkdir(downloadRoot, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(downloadRoot, ".hnnulwh-"));
  const filePath = path.join(tempDir, `asset${extensionForContentType(response.headers.get("content-type"), part)}`);
  let bytes = 0;
  try {
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          callback(new SkinCatalogError("Skin asset exceeds the size limit."));
          return;
        }
        options.onProgress?.(bytes, total);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), limiter, fs.createWriteStream(filePath, { flags: "wx" }));
    if (part === "image") await validateImageFile(filePath, { maxBytes });
    else await validateVideoFile(filePath, { maxBytes });
    return {
      filePath,
      tempDir,
      bytes,
      contentType: response.headers.get("content-type"),
      skin,
      part,
    };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof SkinCatalogError) throw error;
    throw new SkinCatalogError(error instanceof Error ? error.message : "Skin asset validation failed.");
  }
}

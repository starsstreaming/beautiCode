import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  VIDEO_EXTENSION,
} from "./constants.js";
import type { ValidatedImage, ValidatedVideo } from "./types.js";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// WEBP: RIFF....WEBP
function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

/** AVIF is an ISO-BMFF image. Some downloaders save it with a .png suffix. */
export function isAvifContainer(
  bytes: Uint8Array,
  totalSize: number = bytes?.byteLength ?? 0,
): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstBoxSize = view.readUInt32BE(0);
  if (
    firstBoxSize < 16 ||
    firstBoxSize > totalSize ||
    view.subarray(4, 8).toString("ascii") !== "ftyp"
  ) {
    return false;
  }
  const brands = [view.subarray(8, 12)];
  for (
    let offset = 16;
    offset + 4 <= Math.min(firstBoxSize, view.length);
    offset += 4
  ) {
    brands.push(view.subarray(offset, offset + 4));
  }
  return brands.some(
    (brand) => brand.toString("ascii") === "avif" || brand.toString("ascii") === "avis",
  );
}

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaValidationError";
  }
}

export type MediaValidationMode = "full" | "fast";

async function assertNoSymbolicLinkSegments(filePath: string): Promise<void> {
  const root = path.parse(filePath).root;
  const relative = path.relative(root, filePath);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const segmentStat = await fs.lstat(current);
    if (segmentStat.isSymbolicLink()) {
      throw new MediaValidationError(
        "Media path must not traverse a symbolic link or reparse point.",
      );
    }
  }
}

export function isMp4Container(
  bytes: Uint8Array,
  totalSize: number = bytes?.byteLength ?? 0,
): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstBoxSize = view.readUInt32BE(0);
  return (
    firstBoxSize >= 16 &&
    firstBoxSize <= totalSize &&
    view.subarray(4, 8).toString("ascii") === "ftyp"
  );
}

async function assertRegularFile(filePath: string): Promise<{
  resolved: string;
  size: number;
}> {
  const resolvedInput = path.resolve(filePath);
  let lstat;
  try {
    lstat = await fs.lstat(resolvedInput);
  } catch {
    throw new MediaValidationError(`Media file not found: ${resolvedInput}`);
  }
  if (lstat.isSymbolicLink()) {
    throw new MediaValidationError("Media file must not be a symbolic link.");
  }
  // On Windows, reject reparse points that are not ordinary files.
  // lstat.isSymbolicLink covers symlinks; directory junctions won't be files.
  const realPath = await fs.realpath(resolvedInput);
  const normalizeForCompare = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (normalizeForCompare(realPath) !== normalizeForCompare(resolvedInput)) {
    // realpath can also expand a harmless Windows 8.3 path alias. Inspect each
    // segment so only an actual symlink or junction is rejected.
    await assertNoSymbolicLinkSegments(resolvedInput);
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new MediaValidationError("Media path must be a regular file.");
  }
  return { resolved: realPath, size: stat.size };
}

async function inspectAndHash(
  filePath: string,
  expectedSize: number,
  mode: MediaValidationMode = "full",
): Promise<{
  head: Buffer;
  identity: string;
  device: number;
  inode: number;
  mtimeMs: number;
  ctimeMs: number;
}> {
  const handle = await fs.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedSize) {
      throw new MediaValidationError("Media file changed during validation.");
    }
    const head = Buffer.alloc(Math.min(64, expectedSize));
    const hash = createHash("sha256");
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    if (bytesRead !== head.byteLength) {
      throw new MediaValidationError("Media file ended during validation.");
    }
    if (mode === "fast") {
      // Local-reference imports must not hash a multi-GB file. The file
      // fingerprint is deliberately tied to metadata and the validated head;
      // the media server rejects the asset if metadata changes afterwards.
      hash.update(
        `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`,
      );
      hash.update(head);
    } else {
      hash.update(head);
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let position = head.byteLength;
      while (position < expectedSize) {
        const length = Math.min(chunk.byteLength, expectedSize - position);
        const read = await handle.read(chunk, 0, length, position);
        if (read.bytesRead <= 0) {
          throw new MediaValidationError("Media file ended during validation.");
        }
        hash.update(chunk.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new MediaValidationError("Media file changed during validation.");
    }
    return {
      head,
      identity: hash.digest("hex"),
      device: after.dev,
      inode: after.ino,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
  } finally {
    await handle.close();
  }
}

export function detectImageMime(
  buf: Buffer,
  extension: string,
  totalSize: number = buf.byteLength,
): { mime: string } | null {
  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG_MAGIC)) {
    if (extension === ".jpg" || extension === ".jpeg") {
      return { mime: "image/jpeg" };
    }
    // Allow jpeg magic even if extension is jpeg family only
    return null;
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
    if (extension === ".png") return { mime: "image/png" };
    return null;
  }
  if (isWebp(buf)) {
    if (extension === ".webp") return { mime: "image/webp" };
    return null;
  }
  // Keep compatibility with files such as the supplied "*.png" whose
  // contents are AVIF. Do not make unrelated JPEG/PNG/WebP mismatches valid.
  if (isAvifContainer(buf, totalSize)) {
    if (extension === ".avif" || extension === ".png") {
      return { mime: "image/avif" };
    }
    return null;
  }
  return null;
}

export async function validateImageFile(
  filePath: string,
  opts: { maxBytes?: number; mode?: MediaValidationMode } = {},
): Promise<ValidatedImage> {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const ext = path.extname(filePath).toLowerCase();
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new MediaValidationError(
      `Image must use one of: ${IMAGE_EXTENSIONS.join(", ")}`,
    );
  }
  const { resolved, size } = await assertRegularFile(filePath);
  if (size < 1 || size > maxBytes) {
    throw new MediaValidationError(
      `Image must be a non-empty file no larger than ${maxBytes} bytes.`,
    );
  }
  const inspected = await inspectAndHash(resolved, size, opts.mode);
  const detected = detectImageMime(inspected.head, ext, size);
  if (!detected) {
    throw new MediaValidationError(
      "Image content does not match a supported JPEG/PNG/WEBP/AVIF signature.",
    );
  }
  return {
    kind: "image",
    filePath: resolved,
    size,
    extension: ext,
    mime: detected.mime,
    identity: inspected.identity,
    device: inspected.device,
    inode: inspected.inode,
    mtimeMs: inspected.mtimeMs,
    ctimeMs: inspected.ctimeMs,
  };
}

export async function validateVideoFile(
  filePath: string,
  opts: { maxBytes?: number; mode?: MediaValidationMode } = {},
): Promise<ValidatedVideo> {
  const maxBytes = opts.maxBytes ?? MAX_VIDEO_BYTES;
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== VIDEO_EXTENSION) {
    throw new MediaValidationError("Video backgrounds must use an MP4 file.");
  }
  const { resolved, size } = await assertRegularFile(filePath);
  if (size < 1 || size > maxBytes) {
    throw new MediaValidationError(
      `Video background must be a non-empty MP4 no larger than ${maxBytes} bytes.`,
    );
  }
  const inspected = await inspectAndHash(resolved, size, opts.mode);
  if (!isMp4Container(inspected.head, size)) {
    throw new MediaValidationError(
      "Video background is not a valid MP4 container.",
    );
  }
  return {
    kind: "video",
    filePath: resolved,
    size,
    identity: inspected.identity,
    device: inspected.device,
    inode: inspected.inode,
    mtimeMs: inspected.mtimeMs,
    ctimeMs: inspected.ctimeMs,
  };
}

/** Basename-only guard for names stored inside active/staging trees. */
export function assertSafeBasename(name: string, label: string): string {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) {
    throw new MediaValidationError(`${label} must be a basename string.`);
  }
  if (name !== path.basename(name) || name === "." || name === "..") {
    throw new MediaValidationError(`${label} must be a basename only.`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new MediaValidationError(`${label} contains illegal path characters.`);
  }
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
    throw new MediaValidationError(
      `${label} contains characters invalid in Windows basenames.`,
    );
  }
  const stem = name.split(".", 1)[0] ?? "";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
    throw new MediaValidationError(`${label} uses a reserved device name.`);
  }
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new MediaValidationError(`${label} contains control characters.`);
    }
  }
  return name;
}

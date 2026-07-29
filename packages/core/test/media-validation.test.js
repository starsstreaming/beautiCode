import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeBasename,
  isMp4Container,
  MediaValidationError,
  validateImageFile,
  validateVideoFile,
} from "../dist/media-validation.js";

function mp4Fixture(marker = "AAAA") {
  const fileTypeBox = Buffer.alloc(24);
  fileTypeBox.writeUInt32BE(fileTypeBox.length, 0);
  fileTypeBox.write("ftyp", 4, "ascii");
  fileTypeBox.write("isom", 8, "ascii");
  fileTypeBox.writeUInt32BE(512, 12);
  fileTypeBox.write("isom", 16, "ascii");
  fileTypeBox.write("mp41", 20, "ascii");
  return Buffer.concat([fileTypeBox, Buffer.from(marker, "ascii")]);
}

function pngFixture() {
  // minimal 1x1 PNG
  return Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
}

test("isMp4Container accepts ftyp and rejects junk", () => {
  const ok = mp4Fixture();
  assert.equal(isMp4Container(ok, ok.length), true);
  assert.equal(isMp4Container(Buffer.from("not-an-mp4"), 10), false);
  assert.equal(isMp4Container(Buffer.alloc(8), 8), false);
});

test("validateVideoFile enforces extension, size, ftyp, no symlink", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-val-"));
  try {
    const bad = path.join(root, "renamed.mp4");
    await fs.writeFile(bad, Buffer.from("not-an-mp4"));
    await assert.rejects(() => validateVideoFile(bad), /not a valid MP4/);

    const good = path.join(root, "background.mp4");
    await fs.writeFile(good, mp4Fixture("ZZ"));
    const v = await validateVideoFile(good);
    assert.equal(v.kind, "video");
    assert.ok(v.size > 0);
    assert.match(v.identity, /^[a-f0-9]{64}$/);

    const wrongExt = path.join(root, "clip.webm");
    await fs.writeFile(wrongExt, mp4Fixture());
    await assert.rejects(() => validateVideoFile(wrongExt), /MP4/);

    // symlink rejection when platform supports it
    if (process.platform !== "win32") {
      const link = path.join(root, "link.mp4");
      await fs.symlink(good, link);
      await assert.rejects(() => validateVideoFile(link), /symbolic link/);
    }

    const linkedRoot = path.join(root, "linked-root");
    await fs.symlink(
      root,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      () => validateVideoFile(path.join(linkedRoot, "background.mp4")),
      /symbolic link|reparse point/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("validateImageFile checks magic bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-img-"));
  try {
    const png = path.join(root, "a.png");
    await fs.writeFile(png, pngFixture());
    const img = await validateImageFile(png);
    assert.equal(img.mime, "image/png");

    const lie = path.join(root, "lie.png");
    await fs.writeFile(lie, Buffer.from("hello"));
    await assert.rejects(() => validateImageFile(lie), /signature/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("assertSafeBasename rejects traversal", () => {
  assert.equal(assertSafeBasename("poster.jpg", "image"), "poster.jpg");
  assert.throws(() => assertSafeBasename("../x.jpg", "image"), MediaValidationError);
  assert.throws(() => assertSafeBasename("a/b.jpg", "image"), MediaValidationError);
  assert.throws(() => assertSafeBasename("a\\b.jpg", "image"), MediaValidationError);
  assert.throws(() => assertSafeBasename("CON.png", "image"), MediaValidationError);
  assert.throws(() => assertSafeBasename("aux.jpg", "image"), MediaValidationError);
  assert.throws(() => assertSafeBasename("poster.png.", "image"), MediaValidationError);
  assert.throws(() => assertSafeBasename("poster.png:ads", "image"), MediaValidationError);
});

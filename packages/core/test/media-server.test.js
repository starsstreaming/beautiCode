import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MediaServerController } from "../dist/media-server.js";
import { MEDIA_TOKEN_HEADER_CANON } from "../dist/constants.js";

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

/** Minimal valid 1x1 PNG. */
function pngFixture() {
  return Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
}

test("loopback media server: token, range, origin, identity drift", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-media-"));
  try {
    const invalidVideoPath = path.join(root, "renamed.mp4");
    await fs.writeFile(invalidVideoPath, Buffer.from("not-an-mp4"));
    await assert.rejects(
      () => new MediaServerController().stage(invalidVideoPath),
      /not a valid MP4 container/,
    );

    const videoPath = path.join(root, "background.mp4");
    const bytes = mp4Fixture("AAAA");
    await fs.writeFile(videoPath, bytes);

    const media = new MediaServerController();
    const staged = await media.stage(videoPath);
    assert.ok(staged);
    await media.commit(staged);

    assert.match(staged.url, /^http:\/\/127\.0\.0\.1:\d+\/media\/[a-f0-9]{32}$/);
    assert.match(
      staged.srcUrl,
      /^http:\/\/127\.0\.0\.1:\d+\/media\/[a-f0-9]{32}\?t=[a-f0-9]{32}$/,
    );

    const denied = await fetch(staged.url);
    assert.equal(denied.status, 403);

    const full = await fetch(staged.url, {
      headers: { [MEDIA_TOKEN_HEADER_CANON]: staged.token },
    });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(
      Buffer.compare(Buffer.from(await full.arrayBuffer()), bytes),
      0,
    );

    // Query token auth for <video src> / <img src> (no custom headers).
    const viaQuery = await fetch(staged.srcUrl);
    assert.equal(viaQuery.status, 200);
    assert.equal(
      Buffer.compare(Buffer.from(await viaQuery.arrayBuffer()), bytes),
      0,
    );

    const replaced = mp4Fixture("BBBB");
    assert.equal(replaced.length, bytes.length);
    await fs.writeFile(videoPath, replaced);
    const changed = await fetch(staged.url, {
      headers: { [MEDIA_TOKEN_HEADER_CANON]: staged.token },
    });
    assert.equal(
      changed.status,
      404,
      "same-size content replacement must invalidate the staged server",
    );
    await fs.writeFile(videoPath, bytes);

    const range = await fetch(staged.url, {
      headers: {
        Range: "bytes=4-7",
        [MEDIA_TOKEN_HEADER_CANON]: staged.token,
      },
    });
    assert.equal(range.status, 206);
    assert.equal(Buffer.from(await range.arrayBuffer()).toString(), "ftyp");

    const options = await fetch(staged.url, {
      method: "OPTIONS",
      headers: {
        Origin: "app://-",
        "Access-Control-Request-Headers": `${MEDIA_TOKEN_HEADER_CANON}, Range`,
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(options.status, 204);
    assert.equal(
      options.headers.get("access-control-allow-private-network"),
      "true",
    );

    const wrongOrigin = await fetch(staged.url, {
      headers: {
        Origin: "https://example.invalid",
        [MEDIA_TOKEN_HEADER_CANON]: staged.token,
      },
    });
    assert.equal(wrongOrigin.status, 403);

    const missing = await fetch(`${staged.url}/other`);
    assert.equal(missing.status, 404);

    // stage/commit keeps previous alive until commit
    const video2 = path.join(root, "background2.mp4");
    await fs.writeFile(video2, mp4Fixture("CCCC"));
    const next = await media.stage(video2);
    assert.ok(next);
    assert.notEqual(next.url, staged.url);
    // old still works before commit
    const oldStill = await fetch(staged.url, {
      headers: { [MEDIA_TOKEN_HEADER_CANON]: staged.token },
    });
    assert.equal(oldStill.status, 200);
    await media.abort(next);
    await media.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("media hub serves image + video with pair commit and query tokens", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-media-img-"));
  try {
    const imagePath = path.join(root, "poster.png");
    const imageBytes = pngFixture();
    await fs.writeFile(imagePath, imageBytes);

    const videoPath = path.join(root, "background.mp4");
    const videoBytes = mp4Fixture("IMGV");
    await fs.writeFile(videoPath, videoBytes);

    const media = new MediaServerController();
    const image = await media.stage(imagePath);
    const video = await media.stage(videoPath);
    assert.ok(image);
    assert.ok(video);
    assert.equal(image.kind, "image");
    assert.equal(video.kind, "video");
    assert.equal(image.url.split(":")[2].split("/")[0], video.url.split(":")[2].split("/")[0]);

    await media.commit({ image, video });
    assert.equal(media.activeImage?.token, image.token);
    assert.equal(media.activeVideo?.token, video.token);

    const imgRes = await fetch(image.srcUrl);
    assert.equal(imgRes.status, 200);
    assert.match(imgRes.headers.get("content-type") ?? "", /^image\//);
    assert.equal(
      Buffer.compare(Buffer.from(await imgRes.arrayBuffer()), imageBytes),
      0,
    );

    const vidRes = await fetch(video.srcUrl);
    assert.equal(vidRes.status, 200);
    assert.equal(vidRes.headers.get("content-type"), "video/mp4");

    // Trusted origin + query token (app:// media element path).
    const corsImg = await fetch(image.srcUrl, {
      headers: { Origin: "app://-" },
    });
    assert.equal(corsImg.status, 200);
    assert.equal(corsImg.headers.get("access-control-allow-origin"), "app://-");

    // Any app:// host variant is trusted (prefix match).
    const corsAppHost = await fetch(image.srcUrl, {
      headers: { Origin: "app://codex-shell" },
    });
    assert.equal(corsAppHost.status, 200);
    assert.equal(
      corsAppHost.headers.get("access-control-allow-origin"),
      "app://codex-shell",
    );

    // Preflight with Private Network Access header.
    const pna = await fetch(image.url, {
      method: "OPTIONS",
      headers: {
        Origin: "app://-",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(pna.status, 204);
    assert.equal(
      pna.headers.get("access-control-allow-private-network"),
      "true",
    );

    await media.commit(null);
    assert.equal(media.activeImage, null);
    assert.equal(media.activeVideo, null);
    // Empty hub may fully close the listener (ECONNREFUSED) or answer 404.
    let cleared = false;
    try {
      const gone = await fetch(image.srcUrl);
      cleared = gone.status === 404 || gone.status === 403 || gone.status === 503;
    } catch (err) {
      const code = err?.cause?.code ?? err?.code;
      cleared = code === "ECONNREFUSED";
    }
    assert.equal(cleared, true);

    await media.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

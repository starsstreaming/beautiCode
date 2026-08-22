import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DshHostApplier,
  DshSession,
  dshTrustedOrigins,
  normalizeDshBaseUrl,
} from "../dist/index.js";
import { MediaServerController } from "@beauticode/core";

const TOKEN = "a".repeat(64);
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function mp4Fixture(marker = "DSH2") {
  const fileTypeBox = Buffer.alloc(24);
  fileTypeBox.writeUInt32BE(24, 0);
  fileTypeBox.write("ftyp", 4, "ascii");
  fileTypeBox.write("isom", 8, "ascii");
  return Buffer.concat([fileTypeBox, Buffer.from(marker)]);
}

function json(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(encoded);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function mockBridge(expectedToken = TOKEN) {
  let current = null;
  let received = null;
  let connectedClients = 1;
  let renderReady = true;
  let renderFailed = false;
  let renderError = null;
  let applyCount = 0;
  let modes = { fish: false, muted: true, tone: "dark" };
  let playbackTime = 8.25;
  const server = http.createServer(async (req, res) => {
    const authorization = String(req.headers.authorization || "");
    const authOk = expectedToken == null
      ? /^Bearer [a-f0-9]{64}$/.test(authorization)
      : authorization === `Bearer ${expectedToken}`;
    if (!authOk) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (req.url === "/__beauticode/apply" && req.method === "POST") {
      received = await readBody(req);
      current = received;
      applyCount += 1;
      json(res, 200, { ok: true });
      return;
    }
    if (req.url === "/__beauticode/mode" && req.method === "POST") {
      modes = { ...modes, ...(await readBody(req)) };
      json(res, 200, { ok: true, modes });
      return;
    }
    if (req.url === "/__beauticode/status" && req.method === "GET") {
      json(res, 200, {
        ok: true,
        connectedClients,
        current,
        readyClients: current && connectedClients > 0 && renderReady ? 1 : 0,
        failedClients: current && connectedClients > 0 && (renderFailed || renderError) ? 1 : 0,
        lastRenderError: renderError,
        visibleClients: current && current.media !== "clear" && connectedClients > 0 && renderReady ? 1 : 0,
        modeReadyClients: connectedClients > 0 ? 1 : 0,
        blockedClients: 0,
        resolvedTone: modes.tone === "auto" ? "light" : modes.tone,
        modes,
        playback: current?.media === "video" && connectedClients > 0
          ? {
              currentTime: playbackTime,
              duration: 30,
              hasVideo: true,
              muted: modes.muted,
              paused: false,
              blocked: false,
            }
          : null,
      });
      return;
    }
    json(res, 404, { ok: false });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    get received() {
      return received;
    },
    get applyCount() {
      return applyCount;
    },
    setConnected(value) {
      connectedClients = value;
    },
    setRenderReady(value) {
      renderReady = value;
    },
    setRenderError(value) {
      renderError = value;
      if (value) {
        renderFailed = true;
        renderReady = false;
      }
    },
    setRenderFailed(value) {
      renderFailed = value;
      if (value) renderReady = false;
    },
    setPlaybackTime(value) {
      playbackTime = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("DSH URL only accepts loopback HTTP", () => {
  assert.equal(normalizeDshBaseUrl("http://127.0.0.1:3080").origin, "http://127.0.0.1:3080");
  assert.deepEqual(dshTrustedOrigins("http://127.0.0.1:3080"), [
    "http://127.0.0.1:3080",
    "http://localhost:3080",
    "http://[::1]:3080",
  ]);
  assert.deepEqual(dshTrustedOrigins("http://localhost:3080"), [
    "http://localhost:3080",
    "http://127.0.0.1:3080",
    "http://[::1]:3080",
  ]);
  assert.throws(() => normalizeDshBaseUrl("https://127.0.0.1:3080"), /loopback HTTP/);
  assert.throws(() => normalizeDshBaseUrl("http://192.168.1.10:3080"), /loopback HTTP/);
  assert.throws(() => normalizeDshBaseUrl("http://user:pass@localhost:3080"), /loopback HTTP/);
  assert.throws(() => normalizeDshBaseUrl("http://localhost:3080/nested"), /loopback HTTP/);
});

test("host applier sends a minimal image payload and waits for browser ack", async (t) => {
  const bridge = await mockBridge();
  t.after(() => bridge.close());
  const host = new DshHostApplier({ baseUrl: bridge.url, token: TOKEN, pollMs: 10 });
  await host.apply({
    generation: 7,
    media: "image",
    imageDataUrl: "data:image/png;base64,should-not-cross-bridge",
    imageUrl: "http://127.0.0.1:45678/media/image?t=secret",
    video: null,
    cssText: "should-not-cross-bridge",
  });
  assert.deepEqual(bridge.received, {
    generation: 7,
    media: "image",
    imageUrl: "http://127.0.0.1:45678/media/image?t=secret",
    videoUrl: null,
    startAt: null,
  });
  const verified = await host.verify(
    { generation: 7, media: "image" },
    { deadlineMs: 100 },
  );
  assert.equal(verified.status, "pass");
  assert.equal(host.activeSessionCount, 1);
  await host.apply({
    generation: 71,
    media: "image",
    imageDataUrl: "data:image/png;base64,should-not-cross-bridge",
    imageUrl: "http://127.0.0.1:45678/media/image?t=secret",
    video: null,
    cssText: "",
    atmosphere: { preset: "infernal", rain: true, overlay: true, water: true },
  });
  assert.equal(bridge.received.atmosphere.preset, "infernal");
});

test("host applier sends loopback MP4 only and controls browser modes", async (t) => {
  const bridge = await mockBridge();
  t.after(() => bridge.close());
  const host = new DshHostApplier({ baseUrl: bridge.url, token: TOKEN, pollMs: 5 });
  await host.apply({
    generation: 8,
    media: "video",
    imageDataUrl: "data:image/png;base64,private",
    imageUrl: "http://127.0.0.1:45678/media/image?t=poster",
    video: {
      mode: "server",
      srcUrl: "http://127.0.0.1:45678/media/video?t=movie",
      localPath: "C:\\private\\movie.mp4",
      startAt: 4.5,
    },
    cssText: "private-css",
  });
  assert.deepEqual(bridge.received, {
    generation: 8,
    media: "video",
    imageUrl: "http://127.0.0.1:45678/media/image?t=poster",
    videoUrl: "http://127.0.0.1:45678/media/video?t=movie",
    startAt: 4.5,
  });
  assert.equal((await host.verify({ generation: 8, media: "video" }, { deadlineMs: 50 })).status, "pass");
  assert.deepEqual(await host.getPlaybackPosition(), {
    ok: true,
    currentTime: 8.25,
    duration: 30,
    hasVideo: true,
  });
  assert.equal((await host.setFishMode(true)).fish, true);
  assert.equal((await host.setMuted(false)).muted, false);
  assert.equal((await host.setBackgroundTone("light")).tone, "light");
});

test("verify is inconclusive when no DSH browser page is connected", async (t) => {
  const bridge = await mockBridge();
  t.after(() => bridge.close());
  bridge.setConnected(0);
  const host = new DshHostApplier({ baseUrl: bridge.url, token: TOKEN, pollMs: 5 });
  await host.apply({
    generation: 3,
    media: "clear",
    imageDataUrl: null,
    imageUrl: null,
    video: null,
    cssText: "",
  });
  const verified = await host.verify(
    { generation: 3, media: "clear" },
    { deadlineMs: 20 },
  );
  assert.equal(verified.status, "inconclusive");
  assert.match(verified.reason, /No DeepSeek Harness browser client/);
});

test("verify preserves the renderer media failure details", async (t) => {
  const bridge = await mockBridge();
  t.after(() => bridge.close());
  bridge.setRenderError(
    "视频解码器报告失败；mediaError=MEDIA_ERR_DECODE；readyState=1；networkState=2；paused=true",
  );
  const host = new DshHostApplier({ baseUrl: bridge.url, token: TOKEN, pollMs: 5 });
  await host.apply({
    generation: 9,
    media: "video",
    imageDataUrl: null,
    imageUrl: "http://127.0.0.1:45678/media/image?t=poster",
    video: {
      mode: "server",
      srcUrl: "http://127.0.0.1:45678/media/video?t=movie",
      localPath: "C:\\movie.mp4",
    },
    cssText: "",
  });
  const verified = await host.verify(
    { generation: 9, media: "video" },
    { deadlineMs: 50 },
  );
  assert.equal(verified.status, "fail");
  assert.match(verified.reason, /MEDIA_ERR_DECODE/);
  assert.match(verified.reason, /readyState=1/);
});

test("verify does not treat a generic transient heartbeat as terminal failure", async (t) => {
  const bridge = await mockBridge();
  t.after(() => bridge.close());
  bridge.setRenderReady(false);
  bridge.setRenderFailed(true);
  const host = new DshHostApplier({ baseUrl: bridge.url, token: TOKEN, pollMs: 5 });
  await host.apply({
    generation: 10,
    media: "video",
    imageDataUrl: null,
    imageUrl: "http://127.0.0.1:45678/media/image?t=poster",
    video: {
      mode: "server",
      srcUrl: "http://127.0.0.1:45678/media/video?t=movie",
      localPath: "C:\\movie.mp4",
    },
    cssText: "",
  });
  const verified = await host.verify(
    { generation: 10, media: "video" },
    { deadlineMs: 20 },
  );
  assert.equal(verified.status, "inconclusive");
});

test("DSH session applies MP4, restores its position, and controls modes", async (t) => {
  const bridge = await mockBridge(null);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-test-"));
  const image = path.join(root, "input.png");
  const video = path.join(root, "input.mp4");
  const dataRoot = path.join(root, "data");
  await fs.writeFile(image, PNG_1X1);
  await fs.writeFile(video, mp4Fixture());
  const session = new DshSession({
    baseUrl: bridge.url,
    dataRoot,
    verifyDeadlineMs: 200,
    pollMs: 60_000,
  });
  t.after(async () => {
    await session.stop();
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await session.start();
  const applied = await session.apply({ type: "image", imagePath: image });
  assert.equal(applied.ok, true);
  assert.equal((await session.status()).manifest.background?.type, "image");

  const videoApplied = await session.applyAndSaveTheme(
    { type: "video", imagePath: image, videoPath: video, source: "local" },
    "本地视频主题",
  );
  assert.equal(videoApplied.ok, true);
  assert.equal(videoApplied.theme?.name, "本地视频主题");
  assert.equal((await session.status()).manifest.background?.type, "video");
  assert.equal((await session.status()).manifest.background?.source?.path, video);
  assert.deepEqual((await fs.readdir(path.join(dataRoot, "active"))).sort(), [
    "background.json",
    "poster.png",
  ]);
  assert.equal(
    (await session.listSavedThemes()).find((theme) => !theme.bundled)?.id,
    videoApplied.theme?.id,
  );
  assert.equal((await session.setFishMode(true)).ok, true);
  assert.equal((await session.setMuted(false)).ok, true);
  assert.equal((await session.setBackgroundTone("light")).ok, true);
  const status = await session.status();
  assert.equal(status.fish, true);
  assert.equal(status.muted, false);
  assert.equal(status.tone, "light");

  bridge.setPlaybackTime(8.25);
  const saved = await session.saveCurrentTheme("视频主题");
  assert.equal(saved.videoPositionSec, 8.25);
  bridge.setPlaybackTime(11.5);
  const restored = await session.useSavedTheme(saved.id);
  assert.equal(restored.ok, true);
  assert.equal(bridge.received.startAt, 8.25);
  bridge.setPlaybackTime(13.5);
  assert.equal((await session.reapply()).ok, true);
  assert.equal(bridge.received.startAt, 13.5);
});

test("DSH watch loop does not republish a matching generation while render ack is pending", async (t) => {
  const bridge = await mockBridge(null);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-watch-"));
  const image = path.join(root, "input.png");
  await fs.writeFile(image, PNG_1X1);
  const session = new DshSession({
    baseUrl: bridge.url,
    dataRoot: path.join(root, "data"),
    verifyDeadlineMs: 100,
    pollMs: 20,
  });
  t.after(async () => {
    await session.stop();
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await session.start();
  const firstApply = await session.apply({ type: "image", imagePath: image });
  assert.equal(firstApply.ok, true, JSON.stringify(firstApply));
  const applyCount = bridge.applyCount;

  bridge.setRenderReady(false);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(bridge.applyCount, applyCount);
});

test("DSH session yields the injector lock when the tray claims it", async (t) => {
  const bridge = await mockBridge(null);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-yield-"));
  const dataRoot = path.join(root, "data");
  const session = new DshSession({
    baseUrl: bridge.url,
    dataRoot,
    verifyDeadlineMs: 50,
    pollMs: 60_000,
  });
  t.after(async () => {
    await session.stop();
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await session.start();
  assert.equal(session.isOpen, true);
  await fs.writeFile(
    path.join(dataRoot, "tray-claim.json"),
    `${JSON.stringify({
      schema: "beauticode.tray-claim/v1",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`,
  );
  const deadline = Date.now() + 3_000;
  while (session.isOpen && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(session.isOpen, false);
  const lockPath = path.join(dataRoot, "injector.lock");
  const lockDeadline = Date.now() + 3_000;
  while (Date.now() < lockDeadline) {
    try {
      await fs.access(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  await assert.rejects(() => fs.readFile(lockPath), {
    code: "ENOENT",
  });
});

test("DSH video media permits localhost and IPv6 loopback origins on the same port", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-dsh-origin-"));
  const videoPath = path.join(root, "background.mp4");
  await fs.writeFile(videoPath, mp4Fixture("ORIGIN"));
  const media = new MediaServerController({
    trustedOrigins: dshTrustedOrigins("http://127.0.0.1:3080"),
  });
  t.after(async () => {
    await media.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const staged = await media.stage(videoPath);
  assert.ok(staged);

  for (const origin of ["http://localhost:3080", "http://[::1]:3080"]) {
    const response = await fetch(staged.srcUrl, {
      headers: { Origin: origin, Range: "bytes=0-1" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal((await response.arrayBuffer()).byteLength, 2);
  }

  const denied = await fetch(staged.srcUrl, {
    headers: { Origin: "http://192.168.1.10:3080", Range: "bytes=0-1" },
  });
  assert.equal(denied.status, 403);
});

test("DSH session rolls disk state back when the bridge disappears", async (t) => {
  const bridge = await mockBridge(null);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-rollback-"));
  const firstImage = path.join(root, "first.png");
  const secondImage = path.join(root, "second.png");
  await fs.writeFile(firstImage, PNG_1X1);
  await fs.writeFile(secondImage, Buffer.concat([PNG_1X1, Buffer.from("different")]));
  const session = new DshSession({
    baseUrl: bridge.url,
    dataRoot: path.join(root, "data"),
    verifyDeadlineMs: 50,
    pollMs: 60_000,
  });
  t.after(async () => {
    await session.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await session.start();
  assert.equal((await session.apply({ type: "image", imagePath: firstImage })).ok, true);
  const before = (await session.status()).manifest;
  await bridge.close();

  const failed = await session.applyAndSaveTheme(
    { type: "image", imagePath: secondImage, source: "local" },
    "不应保留",
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  const after = (await session.status()).manifest;
  assert.deepEqual(after.background, before.background);
  assert.deepEqual(
    (await session.listSavedThemes()).filter((theme) => !theme.bundled),
    [],
  );
  assert.ok(after.generation > before.generation);
  assert.deepEqual(
    await fs.readFile(path.join(root, "data", "active", after.background.image)),
    PNG_1X1,
  );
});

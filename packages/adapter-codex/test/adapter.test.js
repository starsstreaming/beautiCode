import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessReadiness,
  browserIdFromVersion,
  buildInjectionExpression,
  CodexHostApplier,
  isCandidatePageTarget,
  MemoryHostApplier,
  readBoundedJson,
  runApplyOnce,
  runWatch,
  validatedDebuggerUrl,
  acquireInjectorLock,
  CdpError,
  parseRemoteDebuggingFlags,
  discoverCdpEndpoints,
  getCodexLaunchGuidance,
  BeautiSession,
} from "../dist/index.js";
import { startMockCdp } from "./mock-cdp.js";
import http from "node:http";

test("buildInjectionExpression JSON-encodes payload args", () => {
  const runtime = "((a,b,c,d,e,f)=>{return {a,b,c,d,e,f}})";
  const expr = buildInjectionExpression(
    runtime,
    {
      generation: 7,
      media: "image",
      imageDataUrl: 'data:image/png;base64,abc"XSS',
      imageUrl: "http://127.0.0.1:9/media/abc?t=abc",
      video: null,
      cssText: "body{}",
    },
    "body{outline:0}",
  );
  assert.match(
    expr,
    /,7,"http:\/\/127\.0\.0\.1:9\/media\/abc\?t=abc",false\)$/,
  );
  assert.equal(expr.includes('abc"XSS'), false);
  assert.ok(expr.includes("abc\\\"XSS"));
  const forced = buildInjectionExpression(
    runtime,
    {
      generation: 7,
      media: "clear",
      imageDataUrl: null,
      video: null,
      cssText: "",
    },
    "",
    true,
  );
  assert.match(forced, /,true\)$/);
});

test("assessReadiness enforces generation, pointer-events, overflow, hidden", () => {
  const base = {
    generation: 3,
    active: true,
    media: "image",
    videoReady: false,
    hasStage: true,
    hasImage: true,
    imageLoaded: true,
    imageFailed: false,
    hasVideo: false,
    hasPlayableSrc: false,
    stagePointerEvents: "none",
    horizontalOverflow: false,
  };
  assert.equal(
    assessReadiness(base, { generation: 3, media: "image" }).status,
    "pass",
  );
  assert.equal(
    assessReadiness(
      { ...base, generation: 2 },
      { generation: 3, media: "image" },
    ).status,
    "fail",
  );
  assert.equal(
    assessReadiness(
      { ...base, stagePointerEvents: "auto" },
      { generation: 3, media: "image" },
    ).status,
    "fail",
  );
  assert.equal(
    assessReadiness(
      { ...base, horizontalOverflow: true },
      { generation: 3, media: "image" },
    ).status,
    "fail",
  );
  // Hidden document must not false-rollback a structural image apply (#267).
  assert.equal(
    assessReadiness(
      { ...base, documentHidden: true },
      { generation: 3, media: "image" },
    ).status,
    "pass",
  );
  // Video still decoding under a hidden doc stays inconclusive (#294).
  assert.equal(
    assessReadiness(
      {
        ...base,
        media: "video",
        hasVideo: true,
        videoReady: false,
        documentHidden: true,
      },
      { generation: 3, media: "video" },
    ).status,
    "inconclusive",
  );
  assert.equal(
    assessReadiness(
      {
        ...base,
        media: "video",
        hasVideo: true,
        videoReady: false,
      },
      { generation: 3, media: "video" },
    ).status,
    "inconclusive",
  );
  assert.equal(
    assessReadiness(
      {
        ...base,
        media: "video",
        hasVideo: true,
        videoReady: false,
        videoFailed: true,
      },
      { generation: 3, media: "video" },
    ).status,
    "fail",
  );
  assert.equal(
    assessReadiness(
      { ...base, imageLoaded: false, imageFailed: true },
      { generation: 3, media: "image" },
    ).status,
    "fail",
  );
  assert.equal(
    assessReadiness(
      { ...base, imageLoaded: false },
      { generation: 3, media: "image" },
    ).status,
    "inconclusive",
  );
  assert.equal(
    assessReadiness(
      { ...base, media: "video", hasVideo: true, videoReady: true },
      { generation: 3, media: "image" },
    ).status,
    "fail",
  );
  assert.equal(
    assessReadiness(
      { ...base, media: "image", hasVideo: true, videoReady: true },
      { generation: 3, media: "video" },
    ).status,
    "fail",
  );
});

test("readBoundedJson caps body size", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true,"pad":"' + "x".repeat(5000) + '"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    await assert.rejects(
      () =>
        readBoundedJson(`http://127.0.0.1:${port}/json/version`, {
          maxBytes: 100,
        }),
      /exceeded/,
    );
    const ok = await readBoundedJson(`http://127.0.0.1:${port}/json/version`, {
      maxBytes: 50_000,
    });
    assert.equal(ok.ok, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("MemoryHostApplier records payloads", async () => {
  const host = new MemoryHostApplier();
  await host.apply({
    generation: 1,
    media: "image",
    imageDataUrl: "data:image/png;base64,AA",
    video: null,
    cssText: "",
  });
  const v = await host.verify(
    { generation: 1, media: "image" },
    { deadlineMs: 1000 },
  );
  assert.equal(v.status, "pass");
  assert.equal(host.payloads.length, 1);
});

test("validatedDebuggerUrl rejects non-loopback and bad paths", () => {
  const port = 9335;
  assert.equal(
    validatedDebuggerUrl(
      {
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/abc`,
      },
      port,
    ),
    `ws://127.0.0.1:${port}/devtools/page/abc`,
  );
  assert.throws(
    () =>
      validatedDebuggerUrl(
        {
          webSocketDebuggerUrl: `ws://192.168.1.5:${port}/devtools/page/abc`,
        },
        port,
      ),
    /loopback/,
  );
  assert.throws(
    () =>
      validatedDebuggerUrl(
        {
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/abc?x=1`,
        },
        port,
      ),
    /loopback/,
  );
  assert.throws(
    () =>
      validatedDebuggerUrl(
        {
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/evil`,
        },
        port,
      ),
    /loopback/,
  );
});

test("isCandidatePageTarget filters types and paths", () => {
  const port = 9335;
  const good = {
    id: "page-test",
    type: "page",
    url: "app://-/x",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-test`,
  };
  assert.equal(isCandidatePageTarget(good, port), true);
  assert.equal(
    isCandidatePageTarget(
      {
        ...good,
        url: "http://localhost.evil.example/steal",
      },
      port,
      { allowLoopbackHttp: true },
    ),
    false,
  );
  assert.equal(
    isCandidatePageTarget(
      {
        ...good,
        url: "http://localhost:3000/test",
      },
      port,
    ),
    false,
  );
  assert.equal(
    isCandidatePageTarget(
      {
        ...good,
        url: "http://localhost:3000/test",
      },
      port,
      { allowLoopbackHttp: true },
    ),
    true,
  );
  assert.equal(
    isCandidatePageTarget(
      {
        ...good,
        url: "app://other/index.html",
      },
      port,
    ),
    false,
  );
  assert.equal(
    isCandidatePageTarget({ ...good, type: "service_worker" }, port),
    false,
  );
  assert.equal(
    isCandidatePageTarget(
      {
        ...good,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/page-test`,
      },
      port,
    ),
    false,
  );
  assert.equal(
    browserIdFromVersion(
      {
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/br-1`,
      },
      port,
    ),
    "br-1",
  );
});

test("CodexHostApplier injects and verifies against mock CDP", async () => {
  const mock = await startMockCdp();
  const host = new CodexHostApplier({
    port: mock.port,
    requireAppProtocol: true,
    connectDeadlineMs: 5_000,
    pollMs: 50,
  });
  try {
    const connected = await host.connect();
    assert.equal(connected.length, 1);

    await host.apply({
      generation: 4,
      media: "image",
      imageDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      imageUrl: null,
      video: null,
      cssText: "#beauticode-bg-stage{}",
    });

    const result = await host.verify(
      { generation: 4, media: "image" },
      { deadlineMs: 3_000 },
    );
    assert.equal(result.status, "pass", result.reason);
    assert.equal(host.activeSessionCount, 1);
  } finally {
    host.close();
    await mock.close();
  }
});

test("CodexHostApplier verify fails on generation mismatch", async () => {
  const mock = await startMockCdp();
  const host = new CodexHostApplier({
    port: mock.port,
    connectDeadlineMs: 5_000,
    pollMs: 40,
  });
  try {
    await host.connect();
    await host.apply({
      generation: 1,
      media: "image",
      imageDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      imageUrl: null,
      video: null,
      cssText: "",
    });
    const result = await host.verify(
      { generation: 99, media: "image" },
      { deadlineMs: 400 },
    );
    assert.equal(result.status, "fail");
    assert.match(result.reason, /generation mismatch/);
  } finally {
    host.close();
    await mock.close();
  }
});

test("CodexHostApplier close interrupts an inconclusive verify", async () => {
  const mock = await startMockCdp();
  const host = new CodexHostApplier({
    port: mock.port,
    connectDeadlineMs: 5_000,
    pollMs: 25,
  });
  try {
    await host.connect();
    const started = Date.now();
    const verifying = host.verify(
      { generation: 1, media: "image" },
      { deadlineMs: 10_000 },
    );
    setTimeout(() => host.close(), 50);
    const result = await verifying;
    assert.equal(result.status, "fail");
    assert.match(result.reason, /closed during verification/);
    assert.ok(Date.now() - started < 1_000);
  } finally {
    host.close();
    await mock.close();
  }
});

test("runApplyOnce end-to-end with mock CDP + store", async () => {
  const mock = await startMockCdp();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-e2e-"));
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const imagePath = path.join(root, "a.png");
  await fs.writeFile(imagePath, png);
  try {
    const result = await runApplyOnce({
      port: mock.port,
      dataRoot: path.join(root, "data"),
      input: { type: "image", imagePath },
      verifyDeadlineMs: 5_000,
      requireAppProtocol: true,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (result.ok) {
      assert.equal(result.mode, "image");
      assert.ok(result.generation >= 1);
    }
  } finally {
    await mock.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runWatch uses one session and releases its lock on abort", async () => {
  const mock = await startMockCdp();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-watch-"));
  const dataRoot = path.join(root, "data");
  const controller = new AbortController();
  let ticks = 0;
  try {
    await runWatch({
      port: mock.port,
      dataRoot,
      pollMs: 25,
      signal: controller.signal,
      onTick() {
        ticks += 1;
        controller.abort();
      },
    });
    assert.ok(ticks >= 1);
    const release = await acquireInjectorLock(dataRoot, mock.port);
    await release();
  } finally {
    controller.abort();
    await mock.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("acquireInjectorLock prevents dueling injectors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-lock-"));
  const release = await acquireInjectorLock(root, 9335);
  try {
    await assert.rejects(() => acquireInjectorLock(root, 9335), CdpError);
  } finally {
    await release();
  }

  // A live pre-nonce lock from an older version must also block takeover.
  const lockFile = path.join(root, "injector.lock");
  await fs.writeFile(
    lockFile,
    JSON.stringify({
      pid: process.pid,
      port: 9335,
      startedAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(() => acquireInjectorLock(root, 9335), CdpError);
  await fs.rm(lockFile, { force: true });

  // Fresh lock after release works
  const release2 = await acquireInjectorLock(root, 9335);
  await release2();
  await fs.rm(root, { recursive: true, force: true });
});

test("parseRemoteDebuggingFlags accepts loopback only", () => {
  const ok = parseRemoteDebuggingFlags(
    `"ChatGPT.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9335`,
  );
  assert.equal(ok.safe, true);
  assert.equal(ok.port, 9335);
  assert.equal(ok.address, "127.0.0.1");

  const bad = parseRemoteDebuggingFlags(
    `app --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222`,
  );
  assert.equal(bad.safe, false);
  assert.equal(bad.port, 9222);

  const missing = parseRemoteDebuggingFlags("no flags here");
  assert.equal(missing.port, null);
  assert.equal(missing.safe, false);

  const missingAddress = parseRemoteDebuggingFlags(
    `app --remote-debugging-port=9335`,
  );
  assert.equal(missingAddress.port, 9335);
  assert.equal(missingAddress.safe, false);
});

test("discoverCdpEndpoints finds mock loopback CDP", async () => {
  const mock = await startMockCdp();
  try {
    const hits = await discoverCdpEndpoints({
      ports: [mock.port],
      scanProcesses: false,
      requirePages: true,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].port, mock.port);
    assert.ok(hits[0].primaryPages >= 1);
  } finally {
    await mock.close();
  }
});

test("getCodexLaunchGuidance is loopback-only", () => {
  const g = getCodexLaunchGuidance();
  assert.ok(g.preferredFlags.every((f) => !/0\.0\.0\.0/.test(f)));
  assert.ok(g.preferredFlags.some((f) => /127\.0\.0\.1/.test(f)));
});

test("BeautiSession applies image against mock CDP", async () => {
  const mock = await startMockCdp();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-sess-"));
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const imagePath = path.join(root, "a.png");
  await fs.writeFile(imagePath, png);
  const session = new BeautiSession({
    port: mock.port,
    dataRoot: path.join(root, "data"),
    verifyDeadlineMs: 5_000,
    pollMs: 200,
    autoDiscover: false,
    // CLI/test path: connect host before start() returns.
    deferHostConnect: false,
  });
  try {
    const started = await session.start();
    assert.equal(started.port, mock.port);
    const result = await session.apply({ type: "image", imagePath });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    const st = await session.status();
    assert.equal(st.manifest.background?.type, "image");
    const reapplied = await session.reapply();
    assert.equal(reapplied.ok, true, reapplied.ok ? "" : reapplied.error);
    const clear = await session.apply({ type: "clear" });
    assert.equal(clear.ok, true, clear.ok ? "" : clear.error);
  } finally {
    await session.stop();
    await mock.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("BeautiSession reapply reconnects after CDP browser identity changes", async () => {
  const mock = await startMockCdp();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-restart-"));
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const imagePath = path.join(root, "a.png");
  await fs.writeFile(imagePath, png);
  const errors = [];
  const session = new BeautiSession({
    port: mock.port,
    dataRoot: path.join(root, "data"),
    verifyDeadlineMs: 5_000,
    pollMs: 10_000,
    autoDiscover: false,
    deferHostConnect: false,
    onError: (err) => errors.push(err),
  });
  try {
    await session.start();
    const applied = await session.apply({ type: "image", imagePath });
    assert.equal(applied.ok, true, applied.ok ? "" : applied.error);

    mock.rotateBrowserIdentity("test-browser-after-restart");
    const reapplied = await session.reapply();

    assert.equal(reapplied.ok, true, reapplied.ok ? "" : reapplied.error);
    assert.equal(session.isHostReady, true);
    assert.equal(errors.length, 0);
  } finally {
    await session.stop();
    await mock.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("BeautiSession stop drains a deferred startup and releases its lock", async () => {
  const mock = await startMockCdp();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-stop-"));
  const dataRoot = path.join(root, "data");
  const session = new BeautiSession({
    port: mock.port,
    dataRoot,
    pollMs: 50,
    deferHostConnect: true,
    autoDiscover: false,
  });
  await session.start();
  await session.stop();
  assert.equal(session.isOpen, false);
  assert.equal(session.isHostReady, false);
  const release = await acquireInjectorLock(dataRoot, mock.port);
  await release();
  await mock.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("BeautiSession fish mode requires background and toggles", async () => {
  const mock = await startMockCdp();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-fish-"));
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const imagePath = path.join(root, "a.png");
  await fs.writeFile(imagePath, png);
  const session = new BeautiSession({
    port: mock.port,
    dataRoot: path.join(root, "data"),
    verifyDeadlineMs: 5_000,
    pollMs: 200,
    autoDiscover: false,
    deferHostConnect: false,
  });
  try {
    await session.start();
    // Refuse without background.
    const denied = await session.setFishMode(true);
    assert.equal(denied.ok, false);
    assert.equal(denied.fish, false);
    assert.match(String(denied.error || ""), /No active background/i);

    const applied = await session.apply({ type: "image", imagePath });
    assert.equal(applied.ok, true, applied.ok ? "" : applied.error);

    const on = await session.setFishMode(true);
    assert.equal(on.ok, true, on.ok ? "" : on.error);
    assert.equal(on.fish, true);
    assert.equal(session.isFishMode, true);
    const stOn = await session.status();
    assert.equal(stOn.fish, true);

    const off = await session.setFishMode(false);
    assert.equal(off.ok, true, off.ok ? "" : off.error);
    assert.equal(off.fish, false);
    assert.equal(session.isFishMode, false);

    // Re-enter then clear must drop fish.
    const on2 = await session.setFishMode(true);
    assert.equal(on2.ok, true, on2.ok ? "" : on2.error);
    const cleared = await session.apply({ type: "clear" });
    assert.equal(cleared.ok, true, cleared.ok ? "" : cleared.error);
    assert.equal(session.isFishMode, false);
    const stClear = await session.status();
    assert.equal(stClear.fish, false);
  } finally {
    await session.stop();
    await mock.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fish mode CSS and runtime expose data-bc-fish helpers", async () => {
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const css = await fs.readFile(
    path.join(here, "../src/renderer/background.css"),
    "utf8",
  );
  const runtime = await fs.readFile(
    path.join(here, "../src/renderer/background-runtime.js"),
    "utf8",
  );
  assert.match(css, /data-bc-fish/);
  assert.match(css, /filter:\s*none/);
  assert.match(runtime, /setFishMode/);
  assert.match(runtime, /isFishMode/);
  assert.match(runtime, /data-bc-fish/);
  assert.match(runtime, /setMuted/);
  assert.match(runtime, /isMuted/);
  assert.match(runtime, /applyMutePreference/);
  assert.match(runtime, /getPlaybackPosition/);
  assert.match(runtime, /seekTo/);
  assert.match(runtime, /startAt/);
  assert.match(runtime, /pendingStartAt/);
});

test("BeautiSession video mute defaults on and toggles without rebuild", async () => {
  const mock = await startMockCdp();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-mute-"));
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const imagePath = path.join(root, "a.png");
  await fs.writeFile(imagePath, png);
  const session = new BeautiSession({
    port: mock.port,
    dataRoot: path.join(root, "data"),
    verifyDeadlineMs: 5_000,
    pollMs: 200,
    autoDiscover: false,
    deferHostConnect: false,
  });
  try {
    await session.start();
    assert.equal(session.isVideoMuted, true);
    const st0 = await session.status();
    assert.equal(st0.muted, true);

    // Preference can be set before media exists.
    const open = await session.setMuted(false);
    assert.equal(open.ok, true, open.ok ? "" : open.error);
    assert.equal(open.muted, false);
    assert.equal(session.isVideoMuted, false);

    const applied = await session.apply({ type: "image", imagePath });
    assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
    // Preference survives apply.
    assert.equal(session.isVideoMuted, false);

    const silent = await session.setMuted(true);
    assert.equal(silent.ok, true, silent.ok ? "" : silent.error);
    assert.equal(silent.muted, true);
    assert.equal(session.isVideoMuted, true);
    const st1 = await session.status();
    assert.equal(st1.muted, true);
  } finally {
    await session.stop();
    await mock.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

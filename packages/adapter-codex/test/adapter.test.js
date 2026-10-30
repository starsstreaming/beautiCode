import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessReadiness,
  browserIdFromVersion,
  buildInjectionExpression,
  slimCodexCdpPayload,
  TINY_PNG_DATA_URL,
  MAX_CDP_DATA_URL_CHARS,
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
  DEFAULT_CODEX_CDP_PORT,
  codexInstallCandidates,
  pickAvailableCodexPort,
  ensureCodexCdp,
} from "../dist/index.js";
import { startMockCdp } from "./mock-cdp.js";
import http from "node:http";
import net from "node:net";
import {
  buildCodexLaunchCommand,
} from "../dist/launch.js";
import {
  buildWindowsCodexProcessStartScript,
} from "../dist/startup-repair.js";
import {
  CodexStartupRepairController,
  classifyCodexStartupProcess,
} from "../dist/startup-policy.js";
import {
  looksLikeCodexMain,
  parseAppxCodexInstallLocations,
} from "../dist/processes.js";

test("slimCodexCdpPayload drops huge video posters and blob dataUrls", () => {
  const huge = `data:image/png;base64,${"A".repeat(MAX_CDP_DATA_URL_CHARS + 10)}`;
  const slim = slimCodexCdpPayload({
    generation: 3,
    media: "video",
    imageDataUrl: huge,
    imageUrl: null,
    video: {
      mode: "blob",
      localPath: "C:\\tmp\\a.mp4",
      dataUrl: "data:video/mp4;base64,AAAA",
    },
    cssText: "",
  });
  assert.equal(slim.imageDataUrl, TINY_PNG_DATA_URL);
  assert.equal(slim.video?.mode, "blob");
  assert.equal(slim.video?.localPath, "C:\\tmp\\a.mp4");
  assert.equal("dataUrl" in (slim.video ?? {}), false);
  const image = slimCodexCdpPayload({
    generation: 3,
    media: "image",
    imageDataUrl: huge,
    imageUrl: null,
    video: null,
    cssText: "",
  });
  assert.equal(image.imageDataUrl, null);
});

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
    /,7,"http:\/\/127\.0\.0\.1:9\/media\/abc\?t=abc",false,false\)$/,
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
  assert.match(forced, /,true,false\)$/);
  const blobStill = buildInjectionExpression(
    runtime,
    {
      generation: 7,
      media: "image",
      imageDataUrl: null,
      imageUrl: null,
      imageLocalPath: "C:\\tmp\\big.png",
      video: null,
      cssText: "",
    },
    "",
  );
  assert.match(blobStill, /,7,null,false,true\)$/);
  assert.equal(blobStill.includes("C:\\\\tmp\\\\big.png"), false);
  assert.equal(blobStill.includes("C:\\tmp\\big.png"), false);
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

test("CodexHostApplier connects to untitled app:// Codex shell", async () => {
  const mock = await startMockCdp({ title: "" });
  const host = new CodexHostApplier({
    port: mock.port,
    requireAppProtocol: true,
    connectDeadlineMs: 5_000,
    pollMs: 50,
  });
  try {
    const connected = await host.connect();
    assert.equal(connected.length, 1);
  } finally {
    host.close();
    await mock.close();
  }
});

test("CodexHostApplier still injects 背景 console after addBinding already exists", async () => {
  const mock = await startMockCdp({ addBindingError: "binding already registered" });
  const host = new CodexHostApplier({
    port: mock.port,
    requireAppProtocol: true,
    connectDeadlineMs: 5_000,
    pollMs: 50,
    onConsoleRequest: async () => ({ ok: true }),
  });
  try {
    await host.connect();
    assert.equal(mock.state.consoleInstalled, true);
  } finally {
    host.close();
    await mock.close();
  }
});

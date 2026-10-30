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

test("BeautiSession background tone changes CSS only and survives publish", async () => {
  const mock = await startMockCdp();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-tone-"));
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
    const applied = await session.apply({ type: "image", imagePath });
    assert.equal(applied.ok, true, applied.ok ? "" : applied.error);
    const generation = applied.generation;

    const light = await session.setBackgroundTone("light");
    assert.equal(light.ok, true, light.ok ? "" : light.error);
    assert.equal(light.tone, "light");
    const auto = await session.setBackgroundTone("auto");
    assert.equal(auto.ok, true, auto.ok ? "" : auto.error);
    const status = await session.status();
    assert.equal(status.tone, "auto");
    assert.equal(status.manifest.generation, generation);
  } finally {
    await session.stop();
    await mock.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

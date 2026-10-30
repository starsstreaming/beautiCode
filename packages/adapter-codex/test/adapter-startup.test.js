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

test("parseRemoteDebuggingFlags treats omitted address as a loopback-probe candidate", () => {
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

  const badQuoted = parseRemoteDebuggingFlags(
    `app --remote-debugging-address="0.0.0.0" --remote-debugging-port="9222"`,
  );
  assert.equal(badQuoted.safe, false);
  assert.equal(badQuoted.port, 9222);

  const missing = parseRemoteDebuggingFlags("no flags here");
  assert.equal(missing.port, null);
  assert.equal(missing.safe, false);

  const missingAddress = parseRemoteDebuggingFlags(
    `app --remote-debugging-port=9335`,
  );
  assert.equal(missingAddress.port, 9335);
  assert.equal(missingAddress.safe, true);
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

test("Codex auto-launch does not mistake WorkBuddy CDP for Codex", async () => {
  const mock = await startMockCdp({
    title: "WorkBuddy",
    pageUrl: "file:///C:/Programs/WorkBuddy/resources/app.asar/renderer/index.html",
  });
  try {
    await assert.rejects(
      () =>
        ensureCodexCdp({
          preferredPort: mock.port,
          candidatePorts: [mock.port],
          scanProcesses: false,
          launch: false,
          timeoutMs: 500,
        }),
      /CDP is missing/,
    );
  } finally {
    await mock.close();
  }
});

test("getCodexLaunchGuidance is loopback-only", () => {
  const g = getCodexLaunchGuidance();
  assert.ok(g.preferredFlags.every((f) => !/0\.0\.0\.0/.test(f)));
  assert.ok(g.preferredFlags.some((f) => /127\.0\.0\.1/.test(f)));
});

test("codex install candidates include the usual Windows locations", () => {
  const win = codexInstallCandidates(
    { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "C:\\Program Files" },
    "win32",
  );
  assert.ok(win.some((p) => p.endsWith("ChatGPT.exe")));
  assert.ok(win.some((p) => p.endsWith("Codex.exe")));
  assert.equal(DEFAULT_CODEX_CDP_PORT, 9335);
  assert.equal(codexInstallCandidates({}, "darwin").length, 0);
});

test("Codex CDP launch avoids a preferred port already used by WorkBuddy", async () => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = occupied.address();
    assert.ok(address && typeof address === "object");
    const picked = await pickAvailableCodexPort(address.port, [address.port]);
    assert.notEqual(picked, address.port);
    assert.ok(picked > 0 && picked <= 65535);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("Windows Store Codex is launched directly so Chromium receives CDP flags", () => {
  const executable =
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__test\\app\\ChatGPT.exe";
  const command = buildCodexLaunchCommand(9222, executable);
  assert.equal(command.file, executable);
  assert.deepEqual(command.args, [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
  ]);
});

test("Codex process scan filters the app-server helper", () => {
  assert.equal(
    looksLikeCodexMain(
      '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe"',
      "ChatGPT.exe",
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe",
    ),
    true,
  );
  assert.equal(
    looksLikeCodexMain(
      "C:\\Users\\me\\OpenAI\\Codex\\bin\\codex.exe app-server --analytics-default-enabled",
      "codex.exe",
      "C:\\Users\\me\\OpenAI\\Codex\\bin\\codex.exe",
    ),
    false,
  );
});

test("fresh Codex without CDP is repaired immediately only inside the 10s window", () => {
  const now = 50_000;
  const blind = {
    pid: 101,
    name: "ChatGPT.exe",
    executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe",
    commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\ChatGPT.exe"',
    port: null,
    createdAtMs: now - 9_999,
  };

  assert.equal(classifyCodexStartupProcess(blind, now), "repair-now");
  assert.equal(
    classifyCodexStartupProcess({ ...blind, createdAtMs: now - 10_000 }, now),
    "ignore-stale",
  );
  assert.equal(
    classifyCodexStartupProcess(
      {
        ...blind,
        commandLine: `${blind.commandLine} --remote-debugging-port=9222`,
        port: 9222,
      },
      now,
    ),
    "wait-for-cdp",
  );
});

test("Codex startup repair runs once per process generation without a CDP wait", async () => {
  const calls = [];
  const controller = new CodexStartupRepairController({
    now: () => 20_000,
    repair: async (process) => {
      calls.push(process.pid);
    },
  });
  const process = {
    pid: 202,
    name: "ChatGPT.exe",
    executablePath: "C:\\Codex\\ChatGPT.exe",
    commandLine: '"C:\\Codex\\ChatGPT.exe"',
    port: null,
    createdAtMs: 19_500,
  };

  assert.equal(await controller.observe(process), "repaired");
  assert.equal(await controller.observe(process), "already-handled");
  assert.deepEqual(calls, [202]);
});

test("Codex startup monitor detects new PIDs without privileged WMI events", () => {
  const source = buildWindowsCodexProcessStartScript(4321);
  assert.match(source, /Get-Process -Id 4321/);
  assert.match(source, /Get-Process -Name ChatGPT,Codex/);
  assert.match(source, /Start-Sleep -Milliseconds 200/);
  assert.doesNotMatch(source, /Win32_ProcessStartTrace|Register-WmiEvent/);
  assert.match(source, /CreationDate/);
  assert.ok(
    source.indexOf("$seen[$pidValue]=$true") >
      source.indexOf("if(-not $cmd){continue}"),
  );
});

test("BeautiSession defaults to preserving a user-closed Codex host", () => {
  const session = new BeautiSession({ autoDiscover: false });
  assert.equal(session.autoLaunchHost, false);
});

test("Codex watch host has one serialized ensure owner", async () => {
  const source = await fs.readFile(
    new URL("../../../integrations/codex-desktop/watch-host.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /ensureCodexCdp/);
  assert.equal((source.match(/setInterval\(/g) ?? []).length, 1);
  assert.match(source, /startCodexStartupRepairMonitor/);
  assert.match(source, /repairWindowMs:\s*10_000/);
  assert.match(source, /autoLaunchHost:\s*false/);
});

test("Codex AppX install locations are parsed without locale-dependent JSON", () => {
  assert.deepEqual(
    parseAppxCodexInstallLocations(
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_2.0\r\n\r\nC:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\r\n",
    ),
    [
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_2.0",
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0",
    ],
  );
});

test("Codex installer starts the immediate watcher outside the host process tree", async () => {
  const source = await fs.readFile(
    new URL("../../../integrations/codex-desktop/cli.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /Invoke-CimMethod/);
  assert.match(source, /Win32_Process/);
  assert.match(source, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(source, /\$null\s+-eq\s+\$result/);
  assert.match(source, /本次未能立即启动后台监视器/);
  assert.match(source, /startIndependentWindows\(starter\)/);
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
    assert.equal(mock.state.consoleInstalled, true);
    const clear = await session.apply({ type: "clear" });
    assert.equal(clear.ok, true, clear.ok ? "" : clear.error);
  } finally {
    await session.stop();
    await mock.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

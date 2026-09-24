import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyCodexLock,
  isCodexHelperCommand,
  recoverStaleCodexLock,
} from "../../../integrations/codex-desktop/lifecycle.mjs";
import { startCodexHelperWatchdog } from "../../../integrations/codex-desktop/codex-watchdog.mjs";
import { classifyCodexStartupProcess } from "../dist/launch.js";

// 用平台原生分隔符构造：旧的硬编码 Windows 路径在 Linux 上被
// path.resolve 当作相对段拼上 cwd，includes 匹配永远失败（CI TS2307
// 之后的第二个基线自带问题）。本测试只关心「命令行包含 helper 主目录
// 与 watchdog 脚本」的判定逻辑，不要求该路径真实存在。
const HELPER_HOME = path.join(os.tmpdir(), "beauticode-codex-helper-home");

function lock(pid) {
  return JSON.stringify({
    pid,
    nonce: "01234567-89ab-cdef-0123-456789abcdef",
    startedAt: new Date().toISOString(),
  });
}

test("Codex lock classifies dead and unrelated PIDs as stale", () => {
  assert.equal(
    classifyCodexLock(lock(999999), {
      helperHome: HELPER_HOME,
      pidAlive: () => false,
    }).status,
    "stale",
  );
  assert.equal(
    classifyCodexLock(lock(42), {
      helperHome: HELPER_HOME,
      pidAlive: () => true,
      commandLine: '"C:/Windows/System32/notepad.exe"',
    }).status,
    "stale",
  );
});

test("Codex lock recognizes only the installed helper command", () => {
  assert.equal(
    isCodexHelperCommand(
      `node "${HELPER_HOME}\\watch-host.mjs"`,
      HELPER_HOME,
    ),
    true,
  );
  assert.equal(
    classifyCodexLock(lock(42), {
      helperHome: HELPER_HOME,
      pidAlive: () => true,
      commandLine: `node "${HELPER_HOME}\\codex-watchdog.mjs"`,
    }).status,
    "owned",
  );
});

test("stale recovery is atomic and limited to the Codex host namespace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-codex-lock-"));
  const namespace = path.join(root, "hosts", "codex");
  const unrelated = path.join(root, "unrelated.txt");
  const lockPath = path.join(namespace, "injector.lock");
  try {
    await fs.mkdir(namespace, { recursive: true });
    await fs.writeFile(lockPath, lock(999999), "utf8");
    await fs.writeFile(unrelated, "keep", "utf8");
    assert.equal(await recoverStaleCodexLock(lockPath, HELPER_HOME), true);
    await assert.rejects(() => fs.access(lockPath));
    assert.equal(await fs.readFile(unrelated, "utf8"), "keep");

    const unrelatedLock = path.join(root, "injector.lock");
    const unrelatedRaw = lock(999999);
    await fs.writeFile(unrelatedLock, unrelatedRaw, "utf8");
    assert.equal(await recoverStaleCodexLock(unrelatedLock, HELPER_HOME), false);
    assert.equal(await fs.readFile(unrelatedLock, "utf8"), unrelatedRaw);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

test("watchdog restarts helper after nonzero and zero exits, then stop prevents restart", async () => {
  const children = [];
  const calls = [];
  const watchdog = startCodexHelperWatchdog({
    node: "node",
    helper: "C:\\helper\\watch-host.mjs",
    restartDelayMs: 5,
    spawnImpl: (_node, args) => {
      calls.push(args);
      const child = new FakeChild(100 + children.length);
      children.push(child);
      return child;
    },
  });
  try {
    children[0].emit("exit", 7, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(children.length, 2);
    children[1].emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(children.length, 3);
    assert.equal(calls.every((args) => args[0] === "C:\\helper\\watch-host.mjs"), true);
    assert.equal(calls.some((args) => args.some((arg) => /(?:ChatGPT|Codex)\.exe/i.test(arg))), false);
    watchdog.stop();
    children[2].emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(children.length, 3);
  } finally {
    watchdog.stop();
  }
});

test("old blind Codex is never eligible for automatic repair after the fresh window", () => {
  const now = 100_000;
  assert.equal(
    classifyCodexStartupProcess(
      {
        pid: 31232,
        name: "ChatGPT.exe",
        executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
        commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe"',
        port: null,
        createdAtMs: now - 10_001,
      },
      now,
    ),
    "ignore-stale",
  );
});

test("Codex install and pack entries use the watchdog and atomic refresh", async () => {
  const cli = await fs.readFile(
    new URL("../../../integrations/codex-desktop/cli.js", import.meta.url),
    "utf8",
  );
  const pack = await fs.readFile(
    new URL("../../../scripts/pack-codex-plugin.mjs", import.meta.url),
    "utf8",
  );
  assert.match(cli, /codex-watchdog\.mjs/);
  assert.match(cli, /recoverStaleCodexLock/);
  assert.match(cli, /copyFileAtomic/);
  assert.match(cli, /temporaryVendor/);
  assert.match(pack, /codex-watchdog\.mjs/);
  assert.match(pack, /lifecycle\.mjs/);
});

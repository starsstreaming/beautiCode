import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyEntry, isCodexRuntimeReady, probeCodexHealth } from "../../../integrations/codex-desktop/health.mjs";
import { selectCodexPrimaryTargets } from "../dist/index.js";

const ready = () => ({ runtimeReady: true, taskOwned: true });
const guardian = () => "running";

test("independent watcher installation recognizes owned Run startup wiring", async () => {
  const result = await probeCodexHealth({
    installation: () => ({ runtimeReady: true, taskOwned: false, runKeyOwned: true }),
    guardian, host: () => [],
  });
  assert.equal(result.installation, "ready");
  assert.equal(result.taskOwned, false);
  assert.equal(result.runKeyOwned, true);
  assert.equal(result.action, "wait-for-launch");
  const unowned = await probeCodexHealth({
    installation: () => ({ runtimeReady: true, taskOwned: false, runKeyOwned: false }),
    guardian, host: () => [],
  });
  assert.equal(unowned.installation, "incomplete");
});

test("closed Codex is normal idle and never triggers a launch", async () => {
  const result = await probeCodexHealth({ installation: ready, guardian, host: () => [], cdp: () => { throw Error("not called"); }, entry: () => { throw Error("not called"); } });
  assert.equal(result.host, "closed");
  assert.equal(result.action, "wait-for-launch");
});

test("old blind Codex is reported without an automatic restart", async () => {
  const result = await probeCodexHealth({
    installation: ready, guardian,
    host: () => [{ pid: 42, createdAtMs: Date.now() - 30_000, port: null }],
    cdp: () => ({ state: "missing" }), entry: () => "not-checked",
  });
  assert.equal(result.cdp, "missing");
  assert.equal(result.action, "manual-restart-available");
});

test("wrong host and offscreen entry are not reported as visible", async () => {
  const base = { installation: ready, guardian, host: () => [{ pid: 42, port: 9335 }] };
  assert.equal((await probeCodexHealth({ ...base, cdp: () => ({ state: "wrong-host" }), entry: () => "visible" })).entry, "not-checked");
  assert.equal((await probeCodexHealth({ ...base, cdp: () => ({ state: "connected", primaryPages: 2 }), entry: () => "offscreen" })).entry, "offscreen");
  assert.equal(classifyEntry({ exists: true, inViewport: true, hitTest: false }), "offscreen");
  assert.equal(classifyEntry({ exists: false }), "not-mounted");
});

test("stage-specific timeout preserves independent observations without leaking errors", async () => {
  const result = await probeCodexHealth({ installation: () => new Promise(() => {}), guardian, host: () => [] }, 20);
  assert.equal(result.installation, "incomplete");
  assert.equal(result.reason, "probe-timeout:installation");
  assert.equal(result.host, "closed");
  assert.equal(result.action, "inspect-guardian");
  assert.doesNotMatch(JSON.stringify(result), /Users|private|http/);
});

test("independent slow Windows probes run concurrently within one health deadline", async () => {
  const delay = () => new Promise((resolve) => setTimeout(resolve, 70));
  const result = await probeCodexHealth({
    installation: async () => { await delay(); return ready(); },
    guardian: async () => { await delay(); return "running"; },
    host: async () => { await delay(); return []; },
  }, 180);
  assert.equal(result.installation, "ready");
  assert.equal(result.guardian, "running");
  assert.equal(result.host, "closed");
  assert.equal(result.reason, undefined);
});

test("health chooses the same highest-ranked Codex shell as the injector", () => {
  const targets = [
    { id: "z", url: "app://-/", title: "Codex" },
    { id: "a", url: "app://-/index.html", title: "Codex" },
    { id: "0", url: "app://-/index.html?initialRoute=%2Favatar-overlay", title: "Codex" },
  ];
  assert.deepEqual(selectCodexPrimaryTargets(targets).map((target) => target.id), ["a"]);
});

test("runtime health requires a valid pointer, launcher and active entrypoint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-health-"));
  try {
    const helper = path.join(root, "codex-plugin");
    const runtime = helper;
    await fs.mkdir(helper, { recursive: true });
    await fs.writeFile(path.join(helper, "codex-watchdog.mjs"), "");
    assert.equal(isCodexRuntimeReady(root), false);
    await fs.mkdir(path.join(runtime, "versions", "v1"), { recursive: true });
    await fs.writeFile(path.join(runtime, "launcher.ps1"), "");
    await fs.writeFile(path.join(runtime, "current.json"), JSON.stringify({ schema: "beauticode.runtime/v1", host: "codex-plugin", version: "v1", entrypoint: "codex-watchdog.mjs" }));
    assert.equal(isCodexRuntimeReady(root), false);
    await fs.writeFile(path.join(runtime, "versions", "v1", "codex-watchdog.mjs"), "");
    assert.equal(isCodexRuntimeReady(root), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createHealthRunner } from "../src/health.mjs";

test("Codex aggregate health uses the same host/client/guardian/CDP shape", async () => {
  const health = createHealthRunner({
    hosts: ["codex"],
    defaultOptions: (value) => value,
    getHostStatus: () => ({ installed: true }),
    runCodexHealth: async () => ({
      installation: "ready", guardian: "running", host: "running",
      cdp: "connected", entry: "visible", primaryPages: 1, action: "none",
    }),
  });
  const result = await health.runHostHealth("codex");
  assert.equal(result.host, "codex");
  assert.equal(result.client, "running");
  assert.equal(result.guardian, "running");
  assert.equal(result.cdp, "connected");
  assert.equal(result.entry, "visible");
  assert.equal(result.state, "ready");
});

test("a closed desktop client reports waiting-for-launch while its guardian is running", async () => {
  const health = createHealthRunner({
    hosts: ["cursor"], defaultOptions: (value) => value,
    getHostStatus: () => ({ installed: true }),
  });
  const result = await health.runHostHealth("cursor", {
    platform: "win32", runtimeRoot: "C:/package/runtime",
    spawnSync: () => ({ status: 0, stdout: JSON.stringify({
      running: true, cdp: { client: "closed", processCount: 0, connected: false, state: "cdp-missing" },
    }) }),
  });
  assert.equal(result.guardian, "running");
  assert.equal(result.client, "closed");
  assert.equal(result.state, "waiting-for-launch");
});

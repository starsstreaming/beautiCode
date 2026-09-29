import assert from "node:assert/strict";
import test from "node:test";
import { runGuardedMsixRepair } from "../dist/msix-repair.js";

test("MSIX repair checks activation and freshness before terminating the original", async () => {
  const steps = [];
  const result = await runGuardedMsixRepair({
    preflight: async () => { steps.push("preflight"); },
    stillFresh: async () => { steps.push("fresh"); return false; },
    stop: async () => { steps.push("stop"); },
    launchWithCdp: async () => { steps.push("launch"); },
    verifyCdp: async () => true,
    markFailure: async () => {},
    restorePlain: async () => {},
    clearFailure: async () => {},
  });
  assert.equal(result, false);
  assert.deepEqual(steps, ["preflight", "fresh"]);
});

test("MSIX repair records a failed CDP launch before restoring ordinary Codex", async () => {
  const steps = [];
  await assert.rejects(runGuardedMsixRepair({
    preflight: async () => { steps.push("preflight"); },
    stillFresh: async () => { steps.push("fresh"); return true; },
    stop: async () => { steps.push("stop"); },
    launchWithCdp: async () => { steps.push("launch"); },
    verifyCdp: async () => { steps.push("verify"); return false; },
    markFailure: async () => { steps.push("mark"); },
    restorePlain: async () => { steps.push("restore"); },
    clearFailure: async () => { steps.push("clear"); },
  }), /CDP/);
  assert.deepEqual(steps, [
    "preflight", "fresh", "stop", "launch", "verify", "mark", "restore",
  ]);
});

test("MSIX repair clears prior cooldown only after verified CDP", async () => {
  const steps = [];
  const result = await runGuardedMsixRepair({
    preflight: async () => { steps.push("preflight"); },
    stillFresh: async () => true,
    stop: async () => { steps.push("stop"); },
    launchWithCdp: async () => { steps.push("launch"); },
    verifyCdp: async () => { steps.push("verify"); return true; },
    markFailure: async () => { steps.push("mark"); },
    restorePlain: async () => { steps.push("restore"); },
    clearFailure: async () => { steps.push("clear"); },
  });
  assert.equal(result, true);
  assert.deepEqual(steps, ["preflight", "stop", "launch", "verify", "clear"]);
});

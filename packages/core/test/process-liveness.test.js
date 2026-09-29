import assert from "node:assert/strict";
import test from "node:test";
import { isRecordedPidLive } from "../dist/process-liveness.js";

test("a live process may create its claim long after it starts", async () => {
  // A later claim timestamp must not make the original process look recycled.
  const claimTime = new Date(Date.now() + 60_000).toISOString();
  assert.equal(await isRecordedPidLive(process.pid, claimTime), true);
});

test("a claim from before this process started cannot identify this PID", async () => {
  const oldClaim = new Date(Date.now() - Math.max(120_000, process.uptime() * 1_000 + 120_000)).toISOString();
  assert.equal(await isRecordedPidLive(process.pid, oldClaim), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { isRecordedPidLive } from "../dist/process-liveness.js";

test("a live process may create its claim long after it starts", async () => {
  // A later claim timestamp must not make the original process look recycled.
  const claimTime = new Date(Date.now() + 60_000).toISOString();
  assert.equal(await isRecordedPidLive(process.pid, claimTime), true);
});

test("a claim from before this process started cannot identify this PID", async (t) => {
  const start = Date.now();
  t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => callback(null, new Date(start).toISOString()));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const oldClaim = new Date(start - 120_000).toISOString();
  assert.equal(await isRecordedPidLive(process.pid, oldClaim), false);
});

test("a live process is retained when its platform start-time probe is unavailable", async (t) => {
  t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => callback(new Error("probe unavailable"), ""));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await isRecordedPidLive(process.pid, new Date(0).toISOString()), true);
});

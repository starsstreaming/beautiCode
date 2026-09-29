import assert from "node:assert/strict";
import test from "node:test";
import { isManagedWorkBuddyRunner } from "../../../scripts/guardian-process.mjs";

const root = "C:\\Users\\test\\AppData\\Local\\beautiCode\\runtime\\workbuddy";
const runner = `${root}\\versions\\v1\\scripts\\wb-cdp-runner.mjs`;
const pidFile = "C:\\Users\\test\\AppData\\Roaming\\beauticode\\wb-runner.pid";
const record = { schema: "beauticode.wb-runner/v1", pid: 123,
  startedAtMs: 1_000_000, runner, image: "C:\\Program Files\\nodejs\\node.exe", pidFile };
const current = { pid: 123, createdAtMs: 1_000_100,
  image: record.image, commandLine: `"${record.image}" "${runner}" --watchdog` };
const context = { stableHostRoot: root, sourceRunner: "C:\\repo\\scripts\\wb-cdp-runner.mjs", pidFile };

test("WorkBuddy guardian status rejects a recycled PID and foreign command", () => {
  assert.equal(isManagedWorkBuddyRunner(record, current, context), true);
  assert.equal(isManagedWorkBuddyRunner({ ...record, pid: 124 }, current, context), false);
  assert.equal(isManagedWorkBuddyRunner(record, { ...current, createdAtMs: 800_000 }, context), false);
  assert.equal(isManagedWorkBuddyRunner(record, { ...current, commandLine: 'node "other.mjs" --watchdog' }, context), false);
  assert.equal(isManagedWorkBuddyRunner({ ...record, schema: "other" }, current, context), false);
});

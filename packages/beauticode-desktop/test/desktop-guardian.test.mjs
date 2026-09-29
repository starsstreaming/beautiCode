import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const guardian = await import("../../../scripts/desktop-runner-identity.mjs").catch(() => ({}));

const context = {
  host: "cursor",
  stableHostRoot: "C:\\Users\\test\\AppData\\Local\\beautiCode\\runtime\\cursor",
  sourceRunner: "C:\\source\\scripts\\desktop-cdp-runner.mjs",
  pidFile: "C:\\Users\\test\\AppData\\Local\\beautiCode\\hosts\\cursor\\runner.pid",
};
const runner = `${context.stableHostRoot}\\versions\\v1\\scripts\\desktop-cdp-runner.mjs`;
const record = { schema: "beauticode.desktop-runner/v1", host: "cursor", pid: 42,
  image: "C:\\Program Files\\nodejs\\node.exe", runner, pidFile: context.pidFile, startedAtMs: 1000 };
const live = { pid: 42, image: "C:\\Program Files\\nodejs\\node.exe", createdAtMs: 1000,
  commandLine: `"C:\\Program Files\\nodejs\\node.exe" "${runner}" --host cursor --watchdog --pid-file "${context.pidFile}"` };

test("owned guardian identity rejects stale PID, wrong host and recycled creation time", () => {
  assert.equal(typeof guardian.isManagedDesktopRunner, "function");
  assert.equal(guardian.isManagedDesktopRunner(record, live, context), true);
  assert.equal(guardian.isManagedDesktopRunner({ ...record, host: "doubao" }, live, context), false);
  assert.equal(guardian.isManagedDesktopRunner(record, { ...live, createdAtMs: 900_000 }, context), false);
  assert.equal(guardian.isManagedDesktopRunner(record, { ...live, commandLine: 'node "other.mjs" --host cursor --watchdog' }, context), false);
});

test("startup acknowledgement waits for the actual owned runner, not its launcher", async () => {
  assert.equal(typeof guardian.startDesktopGuardian, "function");
  let now = 1000;
  let polls = 0;
  const result = await guardian.startDesktopGuardian({
    context, deadlineMs: 500, now: () => now, sleep: async () => { now += 100; },
    start: () => 777,
    readRecord: () => (++polls < 3 ? null : record),
    readProcess: () => live,
  });
  assert.deepEqual(result, { pid: 42, createdAtMs: 1000 });
  assert.notEqual(result.pid, 777);
  await assert.rejects(guardian.startDesktopGuardian({
    context, deadlineMs: 300, now: () => now, sleep: async () => { now += 100; },
    start: () => 777, readRecord: () => ({ ...record, host: "doubao" }), readProcess: () => live,
  }), /guardian-not-ready/);
});

test("failed guardian activation restores the prior runtime pointer and startup wiring", async () => {
  assert.equal(typeof guardian.withDesktopWiringRollback, "function");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-guardian-rollback-"));
  const pointerPath = path.join(dir, "current.json");
  const startupVbs = path.join(dir, "beauticode-cursor-runner.vbs");
  const executableRecord = path.join(dir, "executable.json");
  try {
    await fs.writeFile(pointerPath, "old pointer");
    await fs.writeFile(startupVbs, "old wiring");
    await fs.writeFile(executableRecord, "old executable");
    await assert.rejects(guardian.withDesktopWiringRollback({
      pointerPath, startupVbs, executableRecord,
      run: async () => {
        await fs.writeFile(pointerPath, "new pointer");
        await fs.writeFile(startupVbs, "new wiring");
        await fs.writeFile(executableRecord, "new executable");
        throw new Error("guardian-not-ready");
      },
    }), /guardian-not-ready/);
    assert.equal(await fs.readFile(pointerPath, "utf8"), "old pointer");
    assert.equal(await fs.readFile(startupVbs, "utf8"), "old wiring");
    assert.equal(await fs.readFile(executableRecord, "utf8"), "old executable");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

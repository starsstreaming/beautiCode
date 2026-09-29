import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireFileLock } from "../dist/file-lock.js";

const NONCE = "01234567-89ab-cdef-0123-456789abcdef";

function existingOwner(pid, startedAt = new Date().toISOString()) {
  return `${JSON.stringify({
    pid,
    nonce: NONCE,
    startedAt,
  })}\n`;
}

async function writeStaleOwner(file, raw) {
  await fs.writeFile(file, raw, "utf8");
  const old = new Date(Date.now() - 5_000);
  await fs.utimes(file, old, old);
}

test("does not reclaim a lock when PID probing is denied with EPERM", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-file-lock-eperm-"));
  const file = path.join(root, "lock.json");
  const raw = existingOwner(process.pid, new Date(Date.now() - 5_000).toISOString());
  const originalKill = process.kill;
  t.after(async () => {
    process.kill = originalKill;
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeStaleOwner(file, raw);

  process.kill = ((pid, signal) => {
    if (pid === process.pid && signal === 0) {
      const error = new Error("operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalKill.call(process, pid, signal);
  });

  await assert.rejects(
    () => acquireFileLock(file, { purpose: "test", staleMs: 1_000 }),
    /Another test is running \(pid \d+\)\./,
  );
  assert.equal(await fs.readFile(file, "utf8"), raw);
});

test("reclaims a stale lock only when PID probing reports ESRCH", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-file-lock-esrch-"));
  const file = path.join(root, "lock.json");
  const deadPid = 4_242_424;
  const raw = existingOwner(deadPid, new Date(Date.now() - 5_000).toISOString());
  const originalKill = process.kill;
  t.after(async () => {
    process.kill = originalKill;
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeStaleOwner(file, raw);

  process.kill = ((pid, signal) => {
    if (pid === deadPid && signal === 0) {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
    return originalKill.call(process, pid, signal);
  });

  const lease = await acquireFileLock(file, {
    purpose: "test",
    staleMs: 1_000,
  });
  try {
    assert.equal(lease.owner.pid, process.pid);
    assert.notEqual(lease.owner.nonce, NONCE);
  } finally {
    await lease.release();
  }
  await assert.rejects(() => fs.access(file), { code: "ENOENT" });
});

test("keeps a freshly written dead-PID lock during the startup grace period", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-file-lock-fresh-"));
  const file = path.join(root, "lock.json");
  const deadPid = 4_242_426;
  const raw = existingOwner(deadPid);
  const originalKill = process.kill;
  t.after(async () => {
    process.kill = originalKill;
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeStaleOwner(file, raw);
  // Keep the record timestamp fresh while making its mtime old. This checks
  // that the owner timestamp is part of the conservative stale decision.
  await fs.utimes(file, new Date(Date.now() - 5_000), new Date(Date.now() - 5_000));

  process.kill = ((pid, signal) => {
    if (pid === deadPid && signal === 0) {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
    return originalKill.call(process, pid, signal);
  });

  await assert.rejects(
    () => acquireFileLock(file, { purpose: "test", staleMs: 1_000 }),
    /Another test may be starting; lock owner is not readable yet\./,
  );
  assert.equal(await fs.readFile(file, "utf8"), raw);
});

test("does not reclaim a lock when PID probing returns an unknown error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-file-lock-unknown-"));
  const file = path.join(root, "lock.json");
  const deadPid = 4_242_425;
  const raw = existingOwner(deadPid, new Date(Date.now() - 5_000).toISOString());
  const originalKill = process.kill;
  t.after(async () => {
    process.kill = originalKill;
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeStaleOwner(file, raw);

  process.kill = ((pid, signal) => {
    if (pid === deadPid && signal === 0) {
      throw new Error("permission status unavailable");
    }
    return originalKill.call(process, pid, signal);
  });

  await assert.rejects(
    () => acquireFileLock(file, { purpose: "test", staleMs: 1_000 }),
    /Another test is running \(pid 4242425\)\./,
  );
  assert.equal(await fs.readFile(file, "utf8"), raw);
});

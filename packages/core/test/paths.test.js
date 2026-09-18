import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyFileAtomic,
  renameWithRetry,
  retryTransientRename,
} from "../dist/paths.js";

// Keep the backoff measurable but negligible so the suite stays fast.
const FAST_RETRY = { attempts: 4, baseDelayMs: 1, maxDelayMs: 2 };

function transientError(code) {
  const error = new Error(`${code}: operation not permitted, rename`);
  error.code = code;
  return error;
}

test("retryTransientRename retries a transient Windows handle error, then succeeds", async () => {
  let calls = 0;
  const result = await retryTransientRename(async () => {
    calls += 1;
    if (calls <= 2) throw transientError("EPERM");
    return "done";
  }, FAST_RETRY);
  assert.equal(result, "done");
  assert.equal(calls, 3);
});

test("retryTransientRename also retries EACCES and EBUSY", async () => {
  for (const code of ["EACCES", "EBUSY"]) {
    let calls = 0;
    const result = await retryTransientRename(async () => {
      calls += 1;
      if (calls === 1) throw transientError(code);
      return code;
    }, FAST_RETRY);
    assert.equal(result, code);
    assert.equal(calls, 2, `${code} must be retried once`);
  }
});

test("retryTransientRename fails fast on a permanent error", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientRename(async () => {
      calls += 1;
      throw transientError("ENOENT");
    }, FAST_RETRY),
    (error) => error.code === "ENOENT",
  );
  assert.equal(calls, 1, "a missing source must not consume the retry budget");
});

test("retryTransientRename rethrows the last error once the budget is spent", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientRename(
      async () => {
        calls += 1;
        throw transientError("EPERM");
      },
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    ),
    (error) => error.code === "EPERM",
  );
  assert.equal(calls, 3);
});

test("renameWithRetry replaces an existing destination", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-rename-"));
  try {
    const source = path.join(dir, "source.txt");
    const destination = path.join(dir, "destination.txt");
    await fs.writeFile(source, "new", "utf8");
    await fs.writeFile(destination, "old", "utf8");

    await renameWithRetry(source, destination);

    assert.equal(await fs.readFile(destination, "utf8"), "new");
    await assert.rejects(fs.access(source));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("copyFileAtomic still promotes over an existing destination", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-copy-"));
  try {
    const source = path.join(dir, "poster.png");
    const destination = path.join(dir, "active.png");
    await fs.writeFile(source, "fresh", "utf8");
    await fs.writeFile(destination, "stale", "utf8");

    await copyFileAtomic(source, destination);

    assert.equal(await fs.readFile(destination, "utf8"), "fresh");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

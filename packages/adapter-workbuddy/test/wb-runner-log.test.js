import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkBuddyLogger } from "../../../scripts/wb-runner-log.mjs";

test("runner logs without inherited stdio and rotates within a bound", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-wb-log-"));
  try {
    const file = path.join(dir, "runner.log");
    const logger = createWorkBuddyLogger({ file, maxBytes: 256, stderr: () => {} });
    logger.info("started");
    logger.info("selected C:\\Users\\me\\private.jpg");
    logger.info("url https://example.test/?account=alice");
    for (let index = 0; index < 20; index++) logger.info(`tick-${index}`);
    const current = await fs.readFile(file, "utf8");
    assert.match(current, /tick-19/);
    assert.ok((await fs.stat(file)).size <= 256);
    assert.ok((await fs.stat(file + ".previous")).size <= 256);
    assert.doesNotMatch(current, /private\.jpg|account=alice/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("log failure is nonfatal and reports once to foreground stderr", () => {
  const errors = [];
  const logger = createWorkBuddyLogger({ file: "\0invalid", stderr: (message) => errors.push(message) });
  logger.info("one"); logger.info("two");
  assert.equal(errors.length, 1);
});

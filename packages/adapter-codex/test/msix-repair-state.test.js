import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearMsixRepairFailure,
  isMsixRepairSuppressed,
  markMsixRepairFailure,
} from "../dist/msix-repair-state.js";

test("failed MSIX activation suppresses repeated repair across guardian restarts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-msix-repair-"));
  const marker = path.join(dir, "failure.json");
  try {
    assert.equal(await isMsixRepairSuppressed("OpenAI.Codex_v1", marker, 1000), false);
    await markMsixRepairFailure("OpenAI.Codex_v1", marker, 1000);
    assert.equal(await isMsixRepairSuppressed("OpenAI.Codex_v1", marker, 1001), true);
    assert.equal(await isMsixRepairSuppressed("OpenAI.Codex_v2", marker, 1001), false);
    assert.equal(await isMsixRepairSuppressed("OpenAI.Codex_v1", marker, 301001), false);
    await clearMsixRepairFailure(marker);
    assert.equal(await isMsixRepairSuppressed("OpenAI.Codex_v1", marker, 1001), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

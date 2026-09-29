import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hostDataRoot,
  migrateLegacyDataRoot,
} from "../dist/paths.js";

test("host data roots are namespaced and migrate legacy data by copy only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-host-paths-"));
  try {
    const legacy = path.join(root, "beautiCode");
    const codex = hostDataRoot("codex", legacy);
    const dsh = hostDataRoot("dsh", legacy);
    assert.equal(codex, path.join(legacy, "hosts", "codex"));
    assert.equal(dsh, path.join(legacy, "hosts", "dsh"));

    await fs.mkdir(path.join(legacy, "saved"), { recursive: true });
    await fs.writeFile(path.join(legacy, "saved", "theme.json"), "legacy", "utf8");
    assert.equal(await migrateLegacyDataRoot(legacy, codex), true);
    assert.equal(await fs.readFile(path.join(codex, "saved", "theme.json"), "utf8"), "legacy");
    assert.equal(await fs.readFile(path.join(legacy, "saved", "theme.json"), "utf8"), "legacy");
    assert.equal(await migrateLegacyDataRoot(legacy, codex), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "beauticode-desktop.mjs");

test("each host status command is safe and returns structured JSON", () => {
  for (const host of ["dsh", "codex", "workbuddy", "cursor", "doubao"]) {
    const result = spawnSync(process.execPath, [cli, host, "status"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${host}: ${result.stderr}`);
    const status = JSON.parse(result.stdout);
    assert.equal(status.host, host);
    assert.equal(typeof status.runtimeReady, "boolean");
    assert.equal(typeof status.installed, "boolean");
  }
});

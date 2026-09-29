import assert from "node:assert/strict";
import test from "node:test";

test("direct Codex CLI status and unknown flags cannot trigger installation", async () => {
  const { parseCodexCliMode } = await import("../../../integrations/codex-desktop/cli.js");
  assert.equal(typeof parseCodexCliMode, "function");
  assert.equal(parseCodexCliMode(["--status"]), "health");
  assert.equal(parseCodexCliMode(["--health"]), "health");
  assert.throws(() => parseCodexCliMode(["--bogus"]), /Unknown Codex option/);
});

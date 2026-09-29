import assert from "node:assert/strict";
import test from "node:test";
import { buildWindowsGenerationKillScript } from "../dist/index.js";

test("the controlled kill checks PID generation, executable and main-process identity", () => {
  const script = buildWindowsGenerationKillScript({
    pid: 42, createdAtMs: 1_000_000, name: "WorkBuddy.exe",
    executablePath: "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
  }, true);
  assert.match(script, /ProcessId=42/);
  assert.match(script, /\$created -ne 1000000/);
  assert.match(script, /WorkBuddy\.exe/);
  assert.match(script, /ExecutablePath/);
  assert.match(script, /--type=/);
  assert.match(script, /taskkill\.exe \/PID 42 \/T \/F/);
  assert.throws(() => buildWindowsGenerationKillScript({ pid: 0, createdAtMs: null,
    name: "WorkBuddy.exe", executablePath: "C:\\WorkBuddy.exe" }, true));
});

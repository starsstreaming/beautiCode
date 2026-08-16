import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const scripts = [
  "scripts/start-beauticode-dsh.ps1",
  "scripts/start-beauticode.ps1",
  "apps/tray/start-tray.ps1",
];

test("DSH launcher scripts parse", () => {
  for (const relative of scripts) {
    const full = path.join(repoRoot, relative);
    const command = [
      "$errors = $null",
      `$null = [System.Management.Automation.Language.Parser]::ParseFile('${full.replace(/'/g, "''")}', [ref]$null, [ref]$errors)`,
      "if ($errors -and $errors.Count) { $errors | ForEach-Object { $_.ToString() }; exit 1 }",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(
      result.status,
      0,
      `${relative} failed to parse:\n${result.stdout}\n${result.stderr}`,
    );
  }
});

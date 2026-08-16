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
  "scripts/start-beauticode-engine.ps1",
  "scripts/bc-tray-singleton.ps1",
  "apps/tray/start-tray.ps1",
];

test("DSH wait notice exits when close event is already signaled", () => {
  const script = path.join(repoRoot, "scripts/start-beauticode.ps1");
  const eventName = `Local\\beautiCode.Test.DshWait.${Date.now()}`;
  const command = [
    `$name = '${eventName.replace(/'/g, "''")}'`,
    "$event = New-Object System.Threading.EventWaitHandle($true, [System.Threading.EventResetMode]::ManualReset, $name)",
    `$p = Start-Process -FilePath powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}','-WaitNotice','-WaitNoticeEvent',$name)`,
    "if (-not $p.WaitForExit(12000)) { $p.Kill(); throw 'wait notice did not exit' }",
    "if ($p.ExitCode -ne 0) { throw ('wait notice exit ' + $p.ExitCode) }",
    "$event.Dispose()",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 20000 },
  );
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
});

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

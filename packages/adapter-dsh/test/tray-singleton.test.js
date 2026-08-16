import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const singleton = path.join(repoRoot, "scripts/bc-tray-singleton.ps1");

function runPs(command) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 20000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return (result.stdout || "").trim();
}

test("tray command-line matcher accepts only -File start-tray.ps1", () => {
  const command = [
    `. '${singleton.replace(/'/g, "''")}'`,
    "if (-not (Test-BcTrayCommandLine '-NoProfile -File C:\\app\\apps\\tray\\start-tray.ps1 -TargetHost dsh')) { throw 'plain -File missed' }",
    "if (-not (Test-BcTrayCommandLine '-File \"C:\\app\\apps\\tray\\start-tray.ps1\"')) { throw 'quoted -File missed' }",
    "if (Test-BcTrayCommandLine '-Command Get-Content start-tray.ps1') { throw 'mentioned path should not match' }",
    "if (Test-BcTrayCommandLine 'powershell.exe -NoProfile') { throw 'bare powershell should not match' }",
    "'ok'",
  ].join("; ");
  assert.equal(runPs(command), "ok");
});

test("named mutex can be taken over after the owner exits", () => {
  const name = `Local\\beautiCode.Test.TrayLock.${Date.now()}`;
  const command = [
    `. '${singleton.replace(/'/g, "''")}'`,
    `$name = '${name.replace(/'/g, "''")}'`,
    "$holder = Start-Process -FilePath powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',\"`$c=`$false; `$m=[System.Threading.Mutex]::new(`$true,'$name',[ref]`$c); Start-Sleep 8\")",
    "Start-Sleep -Milliseconds 400",
    "Stop-Process -Id $holder.Id -Force",
    "Start-Sleep -Milliseconds 300",
    "$lock = Enter-BcNamedMutex -Name $name",
    "if (-not $lock.Owned) { throw 'failed to take over abandoned mutex' }",
    "$lock.Mutex.ReleaseMutex()",
    "$lock.Mutex.Dispose()",
    "'ok'",
  ].join("; ");
  assert.equal(runPs(command), "ok");
});

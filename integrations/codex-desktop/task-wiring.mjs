import { execFileSync } from "node:child_process";
import path from "node:path";

export const CODEX_TASK_NAME = "beautiCode Codex Guardian";
const RUN_PATH = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "BeautiCodeCodex";

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function powershell(script) {
  if (process.platform !== "win32") throw new Error("Codex guardian task requires Windows");
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`, "utf16le").toString("base64");
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(`Codex task scheduler command failed (exit ${error?.status ?? "unknown"})`);
  }
}

function taskOwner(record, starter, sid) {
  if (!record) return false;
  const expectedSid = String(sid || "").trim().toLowerCase();
  const actualSid = String(record.userSid || "").trim().toLowerCase();
  const sameUser = expectedSid.startsWith("s-1-") && actualSid === expectedSid;
  const command = String(record.execute).replaceAll("/", "\\").toLowerCase();
  const argument = String(record.arguments).replaceAll("/", "\\").toLowerCase();
  return sameUser && path.win32.basename(command) === "powershell.exe" &&
    argument.includes(`-file "${path.win32.resolve(starter).toLowerCase()}"`);
}

/** The adapter never mutates an unrelated same-name task. */
export function createCodexTaskAdapter(starter, { taskName = CODEX_TASK_NAME, runPowerShell = powershell } = {}) {
  if (!path.win32.isAbsolute(starter) || starter.includes('"')) throw new Error("invalid Codex starter path");
  const name = quote(taskName);
  const identity = () => JSON.parse(runPowerShell("$i=[Security.Principal.WindowsIdentity]::GetCurrent(); @{sid=$i.User.Value; name=$i.Name} | ConvertTo-Json -Compress"));
  const read = async () => {
    // A task principal may be serialized as a bare local username; resolve it to a SID before ownership checks.
    const raw = runPowerShell(`$t=Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue; if($t){ $principal=$t.Principal.UserId; $sid=try { if($principal -match '^S-') { $principal } else { try { [System.Security.Principal.NTAccount]::new($principal).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { if($principal -match '[\\\\/]') { throw }; [System.Security.Principal.NTAccount]::new("$env:COMPUTERNAME\\$principal").Translate([System.Security.Principal.SecurityIdentifier]).Value } } } catch { '' }; @{user=$principal; userSid=$sid; execute=$t.Actions[0].Execute; arguments=$t.Actions[0].Arguments; state=[string]$t.State; xml=(Export-ScheduledTask -TaskName ${name})} | ConvertTo-Json -Compress -Depth 5 }; exit 0`);
    return raw ? JSON.parse(raw) : null;
  };
  const assertOwned = async () => {
    const item = await read();
    const user = identity();
    if (!taskOwner(item, starter, user.sid)) throw new Error("Codex task is not owned by beautiCode");
    return item;
  };
  return {
    read,
    async assertAbsentOrOwned() { if (await read()) await assertOwned(); },
    assertOwned,
    async register() {
      const user = identity();
      const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${starter}"`;
      // Task Scheduler accepts account names consistently; readback resolves to SID, which alone authorizes ownership.
      // Keep the CDP recovery observer active when a laptop switches to battery power.
      runPowerShell(`$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(args)}; ` +
        `$t=New-ScheduledTaskTrigger -AtLogOn -User ${quote(user.name)}; ` +
        `$p=New-ScheduledTaskPrincipal -UserId ${quote(user.name)} -LogonType Interactive -RunLevel Limited; ` +
        "$s=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; " +
        `Register-ScheduledTask -TaskName ${name} -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`);
    },
    async start() { await assertOwned(); runPowerShell(`Start-ScheduledTask -TaskName ${name}`); },
    async isRunning() {
      for (let attempt = 0; attempt < 12; attempt++) {
        const item = await assertOwned();
        if (item.state === "Running") return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return false;
    },
    async stop() { await assertOwned(); runPowerShell(`Stop-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue`); },
    async removeOwned() { if (await read()) { await assertOwned(); runPowerShell(`Unregister-ScheduledTask -TaskName ${name} -Confirm:$false`); } },
    async restore(previous) {
      if (!previous) return;
      if (await read()) await assertOwned();
      runPowerShell(`Register-ScheduledTask -TaskName ${name} -Xml ${quote(previous.xml)} -Force | Out-Null`);
      if (previous.state === "Running") runPowerShell(`Start-ScheduledTask -TaskName ${name}`);
    },
  };
}

export function createCodexRunKeyAdapter(starter, { valueName = RUN_VALUE } = {}) {
  if (!/^BeautiCodeCodex[A-Za-z0-9_]*$/.test(valueName)) throw new Error("invalid Codex Run value name");
  return {
    async read() {
      const raw = powershell(`$p=${quote(RUN_PATH)}; if(Test-Path -LiteralPath $p){ $item=Get-ItemProperty -LiteralPath $p; $v=$item.PSObject.Properties[${quote(valueName)}]; if($null -ne $v){ ConvertTo-Json -InputObject ([string]$v.Value) -Compress } }`);
      if (!raw) return null;
      const command = JSON.parse(raw);
      const expected = starter && `powershell.exe -NoProfile -WindowStyle Hidden -File "${path.win32.resolve(starter)}"`;
      if (expected && String(command).trim().replaceAll("/", "\\").toLowerCase() !== expected.toLowerCase()) {
        throw new Error("Codex Run value is not owned by beautiCode");
      }
      return command;
    },
    async remove() {
      if (await this.read() === null) return;
      powershell(`Remove-ItemProperty -Path ${quote(RUN_PATH)} -Name ${quote(valueName)}`);
    },
    async restore(previous) {
      if (previous == null) return this.remove();
      powershell(`New-Item -Path ${quote(RUN_PATH)} -Force | Out-Null; Set-ItemProperty -Path ${quote(RUN_PATH)} -Name ${quote(valueName)} -Value ${quote(previous)}`);
    },
  };
}

export async function uninstallCodexWiring({ task, runKey, stopOwned }) {
  await runKey.read();
  if (await task.read()) await task.assertOwned();
  if (await task.read()) {
    await task.stop();
    await stopOwned();
    await task.removeOwned();
  } else {
    await stopOwned();
  }
  await runKey.remove();
}

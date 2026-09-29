import { spawnSync } from "node:child_process";
import path from "node:path";

const normalized = (value) => path.win32.normalize(String(value || "")).toLowerCase();

/** Read the current PID generation, not merely the existence of a PID file. */
export function readWindowsProcess(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";`,
    "if(-not $p){exit 1};",
    "$created=0;try{$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "[pscustomobject]@{pid=[int]$p.ProcessId;name=[string]$p.Name;image=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine;createdAtMs=$created}|ConvertTo-Json -Compress -Depth 3;",
  ].join("");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  if (result.status !== 0) return null;
  try {
    const value = JSON.parse(String(result.stdout || "").trim());
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

export function isManagedWorkBuddyRunner(record, current, context) {
  if (!record || !current || !context || record.schema !== "beauticode.wb-runner/v1") return false;
  if (Number(record.pid) !== Number(current.pid)) return false;
  if (normalized(record.image) !== normalized(current.image) || !/\\node(?:\.exe)?$/i.test(normalized(current.image))) return false;
  const runner = normalized(record.runner);
  const stable = runner.startsWith(`${normalized(context.stableHostRoot)}\\`) && runner.endsWith("\\scripts\\wb-cdp-runner.mjs");
  if (!stable && runner !== normalized(context.sourceRunner)) return false;
  if (normalized(record.pidFile) !== normalized(context.pidFile)) return false;
  const cmd = normalized(current.commandLine);
  if (!cmd.includes(runner) || !/(?:^|\s)--watchdog(?:\s|$)/i.test(cmd)) return false;
  const created = Number(current.createdAtMs);
  const started = Number(record.startedAtMs);
  return Number.isFinite(created) && created > 0 && Number.isFinite(started) && started > 0 &&
    Math.abs(created - started) <= 120_000;
}

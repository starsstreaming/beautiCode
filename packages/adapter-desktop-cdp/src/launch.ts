import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { parseRemoteDebuggingFlags, probeDesktopCdp } from "./cdp.js";
import type { DesktopCdpHostSpec, DesktopProcess } from "./types.js";

const execFileAsync = promisify(execFile);

function normalizedWinPath(value: string): string {
  try {
    return path.win32.normalize(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

export function isDesktopMainProcess(
  spec: DesktopCdpHostSpec,
  commandLine: string,
  name: string,
  executablePath: string,
  platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  if (name.toLowerCase() !== spec.processName.toLowerCase()) return false;
  if (/(?:^|\s)--type(?:=|\s)/.test(commandLine)) return false;
  const actual = normalizedWinPath(executablePath);
  return spec.executableCandidates.some(
    (candidate) => normalizedWinPath(candidate) === actual,
  );
}

export interface DesktopProcessSnapshotRow {
  pid: number;
  parentPid?: number;
  name: string;
  exe: string;
  cmd: string;
  created: number;
}

export function selectDesktopMainProcesses(
  spec: DesktopCdpHostSpec,
  rows: readonly DesktopProcessSnapshotRow[],
  platform = process.platform,
): DesktopProcess[] {
  const sameImagePids = new Set(rows.filter((row) =>
    row.name.toLowerCase() === spec.processName.toLowerCase(),
  ).map((row) => row.pid));
  return rows.filter((row) =>
    !sameImagePids.has(row.parentPid ?? -1) &&
    isDesktopMainProcess(spec, row.cmd, row.name, row.exe, platform),
  ).map((row) => {
    const flags = parseRemoteDebuggingFlags(row.cmd);
    return {
      pid: row.pid,
      name: row.name,
      executablePath: row.exe,
      commandLine: row.cmd,
      port: flags.safe ? flags.port : null,
      createdAtMs: Number.isFinite(row.created) && row.created > 0 ? row.created : null,
    };
  });
}

export async function listDesktopProcesses(
  spec: DesktopCdpHostSpec,
): Promise<DesktopProcess[]> {
  if (process.platform !== "win32") return [];
  const escapedName = spec.processName.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `Get-CimInstance Win32_Process -Filter \"Name='${escapedName}'\" | ForEach-Object {`,
    "$cmd=[string]$_.CommandLine;",
    "$exe=[string]$_.ExecutablePath;",
    "$created=0;",
    "try{$created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "$o=@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;exe=$exe;cmd=$cmd;created=$created};",
    "($o | ConvertTo-Json -Compress -Depth 3)",
    "}",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const rows: DesktopProcessSnapshotRow[] = [];
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      rows.push({
        pid: Number(raw.pid) || 0,
        parentPid: Number(raw.parentPid) || 0,
        name: typeof raw.name === "string" ? raw.name : "",
        exe: typeof raw.exe === "string" ? raw.exe : "",
        cmd: typeof raw.cmd === "string" ? raw.cmd : "",
        created: Number(raw.created) || 0,
      });
    }
    return selectDesktopMainProcesses(spec, rows);
  } catch {
    return [];
  }
}

export function findDesktopExecutable(spec: DesktopCdpHostSpec): string | null {
  for (const candidate of spec.executableCandidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Continue to the next measured install location.
    }
  }
  return null;
}

export async function isLoopbackPortFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function pickAvailableDesktopPort(
  spec: DesktopCdpHostSpec,
): Promise<number> {
  for (const port of [spec.defaultPort, ...spec.candidatePorts]) {
    const own = await probeDesktopCdp(spec, port, 250);
    if (own || (await isLoopbackPortFree(port))) return port;
  }
  throw new Error(`${spec.displayName} 的受限 CDP 端口均被占用。`);
}

export function buildDesktopLaunchCommand(
  executable: string,
  port: number,
  originalArguments = "",
): { file: string; args: string[] } {
  // Preserve only flag-shaped arguments. The source is a live process command
  // line, not trusted shell input; never copy separators or free-form tokens
  // into PowerShell's ArgumentList.
  const preserved = (String(originalArguments).match(
    /--[A-Za-z0-9][A-Za-z0-9_.-]*(?:=(?:"[^"]*"|'[^']*'|[^\s;&|<>]+))?/g,
  ) ?? []).join(" ");
  return {
    file: executable,
    args: [
      ...(preserved ? [preserved] : []),
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
    ],
  };
}

export function originalDesktopArguments(
  commandLine: string,
  executable: string,
): string {
  const raw = String(commandLine).trim();
  if (!raw) return "";
  let remainder = "";
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    remainder = end >= 0 ? raw.slice(end + 1) : "";
  } else if (raw.toLowerCase().startsWith(executable.toLowerCase())) {
    remainder = raw.slice(executable.length);
  }
  return remainder
    .replace(
      /--remote-debugging-address(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi,
      "",
    )
    .replace(
      /--remote-debugging-port(?:=|\s+)(?:"[^\"]*"|'[^']*'|[^\s"']+)/gi,
      "",
    )
    .trim();
}

export async function launchDesktopWithCdp(
  executable: string,
  port: number,
  originalArguments = "",
): Promise<void> {
  const command = buildDesktopLaunchCommand(executable, port, originalArguments);
  if (process.platform === "win32") {
    const psLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference='Stop';",
      `Start-Process -FilePath ${psLiteral(command.file)} `,
      `-WorkingDirectory ${psLiteral(path.win32.dirname(command.file))} `,
      `-ArgumentList @(${command.args.map(psLiteral).join(",")}) | Out-Null;`,
    ].join("");
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    return;
  }
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export function buildWindowsDesktopProcessStartScript(
  spec: DesktopCdpHostSpec,
  parentPid: number,
): string {
  const processBase = path.win32.basename(spec.processName, ".exe").replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    "while($true){",
    `if(-not (Get-Process -Id ${Math.max(0, Math.trunc(parentPid))} -ErrorAction SilentlyContinue)){break};`,
    "$rows=@();",
    `$matches=Get-CimInstance Win32_Process -Filter \"Name='${processBase}.exe'\" -ErrorAction SilentlyContinue;`,
    "$sameImagePids=@{};",
    "foreach($p in @($matches)){if($null -ne $p){$sameImagePids[[int]$p.ProcessId]=$true}};",
    "foreach($p in @($matches)){",
    "$pidValue=[int]$p.ProcessId;",
    "if($null -eq $p){continue};",
    "if($sameImagePids.ContainsKey([int]$p.ParentProcessId)){continue};",
    "$cmd=[string]$p.CommandLine;",
    "if(-not $cmd -or $cmd -match '(?:^|\\s)--type(?:=|\\s)'){continue};",
    "$exe=[string]$p.ExecutablePath;",
    "if(-not $exe){continue};",
    "$created=0;",
    "try{$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "if($created -le 0){continue};",
    "$o=@{pid=$pidValue;name=[string]$p.Name;exe=$exe;cmd=$cmd;created=$created};",
    "$rows += $o;",
    "}",
    "([pscustomobject]@{snapshot=$true;rows=$rows} | ConvertTo-Json -Compress -Depth 4);",
    "Start-Sleep -Milliseconds 500;",
    "}",
  ].join(" ");
}

import fs from "node:fs";
import path from "node:path";

/**
 * Read-only Linux process snapshot built from /proc. It is the Linux
 * counterpart of the Windows `Get-CimInstance Win32_Process` reads: no shell,
 * no `ps` parsing, and only the current user's readable entries.
 */
export interface LinuxProcessInfo {
  pid: number;
  parentPid: number;
  /** Kernel short name (comm), at most 15 characters. */
  name: string;
  /** Resolved executable path, or "" when /proc/<pid>/exe is unreadable. */
  executablePath: string;
  argv: string[];
  /** argv joined with spaces; arguments containing whitespace are double-quoted. */
  commandLine: string;
  /** Process start time in epoch milliseconds, or null when unavailable. */
  createdAtMs: number | null;
}

/** Linux exposes USER_HZ=100 on every mainstream architecture. */
const CLOCK_TICKS_PER_SECOND = 100;

let cachedBootTimeMs: number | null | undefined;

export function linuxBootTimeMs(procRoot = "/proc"): number | null {
  if (procRoot === "/proc" && cachedBootTimeMs !== undefined) return cachedBootTimeMs;
  let value: number | null = null;
  try {
    const match = /^btime\s+(\d+)$/m.exec(fs.readFileSync(path.join(procRoot, "stat"), "utf8"));
    value = match ? Number(match[1]) * 1_000 : null;
  } catch {
    value = null;
  }
  if (procRoot === "/proc") cachedBootTimeMs = value;
  return value;
}

/** Parse /proc/<pid>/stat; the comm field may contain spaces and parentheses. */
export function parseLinuxProcStat(raw: string): { name: string; parentPid: number; startTicks: number } | null {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  // rest[0] is field 3 (state); ppid is field 4, starttime is field 22.
  const parentPid = Number(rest[1]);
  const startTicks = Number(rest[19]);
  if (!Number.isFinite(parentPid) || !Number.isFinite(startTicks)) return null;
  return { name: raw.slice(open + 1, close), parentPid, startTicks };
}

export function joinLinuxCommandLine(argv: readonly string[]): string {
  return argv.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
}

export function readLinuxProcess(pid: number, procRoot = "/proc"): LinuxProcessInfo | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const dir = path.join(procRoot, String(pid));
  let stat: ReturnType<typeof parseLinuxProcStat>;
  let argv: string[];
  try {
    stat = parseLinuxProcStat(fs.readFileSync(path.join(dir, "stat"), "utf8"));
    argv = fs.readFileSync(path.join(dir, "cmdline"), "utf8").split("\0");
  } catch {
    return null;
  }
  if (!stat) return null;
  while (argv.length && argv[argv.length - 1] === "") argv.pop();
  let executablePath = "";
  try {
    executablePath = fs.readlinkSync(path.join(dir, "exe")).replace(/ \(deleted\)$/, "");
  } catch {
    /* Kernel threads and other users' processes are unreadable. */
  }
  const boot = linuxBootTimeMs(procRoot);
  return {
    pid,
    parentPid: stat.parentPid,
    name: stat.name,
    executablePath,
    argv,
    commandLine: joinLinuxCommandLine(argv),
    createdAtMs: boot == null ? null : Math.round(boot + (stat.startTicks * 1_000) / CLOCK_TICKS_PER_SECOND),
  };
}

export function listLinuxProcesses(
  filter: (info: LinuxProcessInfo) => boolean = () => true,
  procRoot = "/proc",
): LinuxProcessInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  const out: LinuxProcessInfo[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const info = readLinuxProcess(Number(entry), procRoot);
    if (info && filter(info)) out.push(info);
  }
  return out;
}

/**
 * Electron/Chromium hosts re-exec their own binary for helpers (`--type=…`)
 * and for ELECTRON_RUN_AS_NODE workers (a script path argument). The main
 * process is the one whose parent is not the same executable.
 */
export function selectLinuxMainProcesses(
  rows: readonly LinuxProcessInfo[],
  isCandidate: (info: LinuxProcessInfo) => boolean,
): LinuxProcessInfo[] {
  const candidates = rows.filter(isCandidate);
  const images = new Map(rows.map((row) => [row.pid, row.executablePath]));
  return candidates.filter((row) =>
    !/(?:^|\s)--type(?:=|\s)/.test(row.commandLine) &&
    images.get(row.parentPid) !== row.executablePath,
  );
}

/** Same-user liveness check with an optional creation-time identity guard. */
export function signalLinuxProcess(
  pid: number,
  signal: NodeJS.Signals,
  expectedCreatedAtMs?: number | null,
): boolean {
  if (expectedCreatedAtMs != null) {
    const current = readLinuxProcess(pid);
    if (!current || current.createdAtMs == null) return false;
    if (Math.abs(current.createdAtMs - expectedCreatedAtMs) > 1_000) return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

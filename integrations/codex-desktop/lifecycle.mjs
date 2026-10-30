import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * The Codex watcher owns the host-namespaced injector lock.  A lock PID is
 * useful only when it still belongs to this installed helper; Windows can
 * reuse a PID after the old watcher has died.
 */
export function parseCodexLockOwner(raw) {
  try {
    const value = JSON.parse(String(raw));
    const pid = Number(value?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      commandLine: typeof value?.commandLine === "string" ? value.commandLine : "",
      startedAt: typeof value?.startedAt === "string" ? value.startedAt : "",
      nonce: typeof value?.nonce === "string" ? value.nonce : "",
    };
  } catch {
    return null;
  }
}

export function isCodexHelperCommand(commandLine, helperHome) {
  const command = String(commandLine ?? "").replaceAll("\\", "/").toLowerCase();
  const home = path.resolve(String(helperHome ?? "")).replaceAll("\\", "/").toLowerCase();
  if (!home || !command.includes(home)) return false;
  return (
    command.includes("/watch-host.mjs") ||
    command.includes("/codex-watchdog.mjs")
  );
}

export function classifyCodexLock(raw, opts = {}) {
  const owner = parseCodexLockOwner(raw);
  if (!owner) return { status: "stale", owner: null };
  const pidAlive = opts.pidAlive ?? (() => false);
  if (!pidAlive(owner.pid)) return { status: "stale", owner };
  const commandLine = opts.commandLine ?? owner.commandLine;
  if (!isCodexHelperCommand(commandLine, opts.helperHome)) {
    return { status: "stale", owner };
  }
  return { status: "owned", owner };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function linuxCommandLine(pid) {
  try {
    return readFileSync(`/proc/${Math.trunc(pid)}/cmdline`, "utf8")
      .split("\0").filter(Boolean)
      .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  } catch {
    return "";
  }
}

export function processCommandLine(pid) {
  if (process.platform === "linux") return linuxCommandLine(pid);
  if (process.platform !== "win32") return "";
  try {
    const script =
      "$p=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + " +
      `${Math.trunc(pid)}` +
      "); if($p){[string]$p.CommandLine}";
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 2_000 },
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Reclaim only the Codex host namespace lock.  The rename is conditional on
 * the bytes staying unchanged, so a concurrently starting helper is never
 * deleted.  A quarantined file is removed only after the comparison succeeds.
 */
export async function recoverStaleCodexLock(lockPath, helperHome) {
  if (!isCodexNamespaceLock(lockPath)) return false;
  let raw;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const owner = parseCodexLockOwner(raw);
  const commandLine = owner ? processCommandLine(owner.pid) : "";
  const state = classifyCodexLock(raw, {
    helperHome,
    pidAlive,
    commandLine,
  });
  if (state.status === "owned") return false;

  return quarantineUnchanged(lockPath, raw);
}

/** A reused PID is safe to reclaim only when its actual command is unrelated. */
export async function recoverStaleCodexGuardianLock(lockPath, helperHomes, probes = {}) {
  if (!isCodexNamespaceLock(lockPath, "guardian.lock")) return false;
  let raw;
  try { raw = await fs.readFile(lockPath, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  const owner = parseCodexLockOwner(raw);
  if (!owner) {
    const info = await fs.stat(lockPath).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < 10_000) return false;
  }
  const alive = probes.pidAlive ?? pidAlive;
  const readCommand = probes.commandLine ?? processCommandLine;
  if (owner && alive(owner.pid)) {
    const command = readCommand(owner.pid);
    if (!command) return false;
    const normalized = command.replaceAll("\\", "/").toLowerCase();
    const homes = (Array.isArray(helperHomes) ? helperHomes : [helperHomes])
      .map((home) => path.resolve(home).replaceAll("\\", "/").toLowerCase());
    if (homes.some((home) => normalized.includes(`${home}/`) && normalized.includes("/codex-watchdog.mjs"))) return false;
  }
  return quarantineUnchanged(lockPath, raw);
}

async function quarantineUnchanged(lockPath, raw) {
  const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantine);
    const moved = await fs.readFile(quarantine, "utf8").catch(() => "");
    if (moved !== raw) {
      await fs.rename(quarantine, lockPath).catch(() => {});
      return false;
    }
    await fs.rm(quarantine, { force: true });
    return true;
  } catch {
    await fs.rm(quarantine, { force: true }).catch(() => {});
    return false;
  }
}

export function shouldRestartCodexHelper({ stopping = false } = {}) {
  return !stopping;
}

/** Stop only verified installed beautiCode guardian processes, never Codex. */
/** Same-user node processes from /proc, shaped like the Win32_Process rows. */
function linuxNodeProcessRows() {
  let entries = [];
  try { entries = readdirSync("/proc"); } catch { return []; }
  return entries.filter((entry) => /^\d+$/.test(entry)).flatMap((entry) => {
    const command = linuxCommandLine(Number(entry));
    const first = command.split(" ", 1)[0] || "";
    return /(?:^|\/)node$|(?:^|\/)sh$/.test(first) ? [{ ProcessId: Number(entry), CommandLine: command }] : [];
  });
}

export function stopInstalledCodexGuardians(helperHome, stableHostRoot) {
  if (process.platform !== "win32" && process.platform !== "linux") return 0;
  const allowed = [
    path.join(helperHome, "start-watch.ps1"),
    path.join(helperHome, "codex-watchdog.mjs"),
    path.join(helperHome, "watch-host.mjs"),
    path.join(stableHostRoot, "launcher.ps1"),
    path.join(stableHostRoot, "launcher.sh"),
  ].map((value) => path.resolve(value).replaceAll("\\", "/").toLowerCase());
  const versionPrefix = path.join(stableHostRoot, "versions").replaceAll("\\", "/").toLowerCase() + "/";
  if (process.platform === "linux") return stopMatchingRows(linuxNodeProcessRows(), allowed, versionPrefix);
  const script = "$p=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','powershell.exe','pwsh.exe') }; $p | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  let rows;
  try {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024,
    }).trim();
    rows = raw ? JSON.parse(raw) : [];
  } catch { return 0; }
  return stopMatchingRows(rows, allowed, versionPrefix);
}

function stopMatchingRows(rows, allowed, versionPrefix) {
  let stopped = 0;
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const pid = Number(row?.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const command = String(row?.CommandLine || "").replaceAll("\\", "/").toLowerCase();
    const versionedGuardian = command.includes(versionPrefix) &&
      (command.includes("/codex-watchdog.mjs") || command.includes("/watch-host.mjs"));
    if (!versionedGuardian && !allowed.some((scriptPath) => command.includes(scriptPath))) continue;
    try { process.kill(pid); stopped++; } catch { /* already stopped */ }
  }
  return stopped;
}

function isCodexNamespaceLock(lockPath, name = "injector.lock") {
  const resolved = path.resolve(String(lockPath ?? ""));
  const namespace = path.dirname(resolved);
  return (
    path.basename(resolved).toLowerCase() === name &&
    path.basename(namespace).toLowerCase() === "codex" &&
    path.basename(path.dirname(namespace)).toLowerCase() === "hosts"
  );
}

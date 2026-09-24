import crypto from "node:crypto";
import fs from "node:fs/promises";
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
  } catch {
    return false;
  }
}

function processCommandLine(pid) {
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

function isCodexNamespaceLock(lockPath) {
  const resolved = path.resolve(String(lockPath ?? ""));
  const namespace = path.dirname(resolved);
  return (
    path.basename(resolved).toLowerCase() === "injector.lock" &&
    path.basename(namespace).toLowerCase() === "codex" &&
    path.basename(path.dirname(namespace)).toLowerCase() === "hosts"
  );
}

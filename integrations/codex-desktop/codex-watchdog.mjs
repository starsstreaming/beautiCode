#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { recoverStaleCodexGuardianLock } from "./lifecycle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultHelper = path.join(here, "watch-host.mjs");

export async function acquireCodexGuardianLease(home) {
  const vendor = path.join(here, "vendor", "core", "index.js");
  const workspace = path.join(here, "../../packages/core/dist/index.js");
  const modulePath = fs.existsSync(vendor) ? vendor : workspace;
  const { acquireFileLock } = await import(pathToFileURL(modulePath).href);
  const lockPath = path.join(home, "guardian.lock");
  const helperHome = path.dirname(path.dirname(home));
  await recoverStaleCodexGuardianLock(lockPath, [
    path.join(helperHome, "codex-plugin"),
    path.join(helperHome, "runtime", "codex-plugin"),
  ]);
  return acquireFileLock(lockPath, {
    purpose: "Codex guardian", staleMs: 10_000,
  });
}

export function startCodexHelperWatchdog({
  node = process.execPath,
  helper = defaultHelper,
  helperArgs = [],
  restartDelayMs = 1_000,
  spawnImpl = spawn,
  log = () => {},
} = {}) {
  let stopping = false;
  let child = null;
  let timer = null;

  const start = () => {
    if (stopping) return;
    child = spawnImpl(node, [helper, ...helperArgs], {
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    const current = child;
    let finished = false;
    const restart = (code, signal) => {
      if (finished) return;
      finished = true;
      if (child === current) child = null;
      if (stopping) return;
      log(`watch-host 退出（${code ?? signal ?? "unknown"}），${restartDelayMs}ms 后恢复`);
      timer = setTimeout(() => {
        timer = null;
        start();
      }, restartDelayMs);
    };
    child.once("exit", restart);
    child.once("error", (error) => restart(null, error?.message));
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
    child = null;
  };

  start();
  return {
    stop,
    get childPid() {
      return child?.pid ?? null;
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    fileURLToPath(import.meta.url).toLowerCase()
) {
  try {
    const root = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const lease = await acquireCodexGuardianLease(path.join(root, "beautiCode", "hosts", "codex"));
    const watchdog = startCodexHelperWatchdog({
      log: (message) => process.stderr.write(`[codex-watchdog] ${message}\n`),
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        watchdog.stop();
        void lease.release().finally(() => process.exit(0));
      });
    }
    await new Promise(() => {});
  } catch (error) {
    if (/Another Codex guardian is running/.test(String(error?.message))) process.exit(0);
    throw error;
  }
}

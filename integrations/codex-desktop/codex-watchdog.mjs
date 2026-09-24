#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultHelper = path.join(here, "watch-host.mjs");

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
  const watchdog = startCodexHelperWatchdog({
    log: (message) => process.stderr.write(`[codex-watchdog] ${message}\n`),
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      watchdog.stop();
      setTimeout(() => process.exit(0), 100);
    });
  }
  await new Promise(() => {});
}

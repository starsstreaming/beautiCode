import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { parseRemoteDebuggingFlags } from "./cdp.js";
import { buildWindowsDesktopProcessStartScript, isDesktopMainProcess, listDesktopProcesses } from "./launch.js";
import { DEFAULT_DESKTOP_REPAIR_WINDOW_MS, DesktopStartupRepairController, DesktopStartupSnapshotTracker, repairDesktopProcess } from "./startup-repair.js";
import type { DesktopRepairMonitor } from "./startup-repair.js";
import type { DesktopCdpHostSpec, DesktopEnsureLog, DesktopProcess } from "./types.js";

export function startDesktopStartupRepairMonitor(
  spec: DesktopCdpHostSpec,
  log?: DesktopEnsureLog,
): DesktopRepairMonitor {
  if (spec.startupRepair === false) return { close() {} };
  if (process.platform === "linux") return startLinuxDesktopStartupRepairMonitor(spec, log);
  if (process.platform !== "win32") return { close() {} };
  let closed = false;
  let child: ChildProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const controller = new DesktopStartupRepairController((row) =>
    repairDesktopProcess(spec, row, log, {
      onVerification: (endpoint) => {
        if (endpoint) controller.markVerified();
      },
    }),
    Date.now,
    spec.repairWindowMs ?? DEFAULT_DESKTOP_REPAIR_WINDOW_MS,
    spec.repairSuppressionMs ?? 0,
  );

  const tracker = new DesktopStartupSnapshotTracker(async (row) => {
    const result = await controller.observe(row);
    if (result === "repair-suppressed") {
      log?.info(`${spec.displayName} 本次启动已在已验证的 CDP 修复窗口内，跳过重复修复。`);
    } else if (result === "repair-failed") {
      log?.warn(`${spec.displayName} 启动修复未完成；本次进程不再自动重启。`);
    }
  }, { minStableSamples: 1 });
  const start = () => {
    if (closed) return;
    const monitor = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildWindowsDesktopProcessStartScript(spec, process.pid),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = monitor;
    const lines = readline.createInterface({ input: monitor.stdout! });
    lines.on("line", (line) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (raw.snapshot === true && Array.isArray(raw.rows)) {
        const rows = raw.rows.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const row = value as Record<string, unknown>;
          const commandLine = typeof row.cmd === "string" ? row.cmd : "";
          const name = typeof row.name === "string" ? row.name : "";
          const executablePath = typeof row.exe === "string" ? row.exe : "";
          if (!isDesktopMainProcess(spec, commandLine, name, executablePath)) return [];
          const flags = parseRemoteDebuggingFlags(commandLine);
          return [{
            pid: Number(row.pid) || 0,
            name,
            executablePath,
            commandLine,
            port: flags.safe ? flags.port : null,
            createdAtMs: Number(row.created) || null,
          } satisfies DesktopProcess];
        });
        controller.observeSnapshot(rows);
        void tracker.observeSnapshot(rows).catch((error) => {
          log?.warn(`${spec.displayName} 启动修复失败：${String(error)}`);
        });
        return;
      }
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      lines.close();
      if (child === monitor) child = null;
      if (!closed) restartTimer = setTimeout(start, 1_000);
    };
    monitor.once("error", finish);
    monitor.once("exit", finish);
    void listDesktopProcesses(spec).then((rows) => {
      controller.observeSnapshot(rows);
      return tracker.observeSnapshot(rows);
    }).catch((error) => {
      log?.warn(`${spec.displayName} 快照扫描失败：${String(error)}`);
    });
  };
  start();
  return {
    close() {
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      child?.kill();
      child = null;
    },
  };
}

function createStartupRepairPipeline(
  spec: DesktopCdpHostSpec,
  log?: DesktopEnsureLog,
): (rows: DesktopProcess[]) => Promise<void> {
  const controller = new DesktopStartupRepairController((row) =>
    repairDesktopProcess(spec, row, log, {
      onVerification: (endpoint) => {
        if (endpoint) controller.markVerified();
      },
    }),
    Date.now,
    spec.repairWindowMs ?? DEFAULT_DESKTOP_REPAIR_WINDOW_MS,
    spec.repairSuppressionMs ?? 0,
  );
  const tracker = new DesktopStartupSnapshotTracker(async (row) => {
    const result = await controller.observe(row);
    if (result === "repair-suppressed") {
      log?.info(`${spec.displayName} 本次启动已在已验证的 CDP 修复窗口内，跳过重复修复。`);
    } else if (result === "repair-failed") {
      log?.warn(`${spec.displayName} 启动修复未完成；本次进程不再自动重启。`);
    }
  }, { minStableSamples: 1 });
  return async (rows) => {
    controller.observeSnapshot(rows);
    await tracker.observeSnapshot(rows);
  };
}

/**
 * Linux has no process-start event without privileges; a 500 ms /proc
 * snapshot matches the Windows monitor's sampling interval and feeds the same
 * controller, so the one-repair-per-fresh-process invariant is shared.
 */
function startLinuxDesktopStartupRepairMonitor(
  spec: DesktopCdpHostSpec,
  log?: DesktopEnsureLog,
): DesktopRepairMonitor {
  if (!spec.linux?.executableCandidates.length) return { close() {} };
  const observe = createStartupRepairPipeline(spec, log);
  let closed = false;
  let busy = false;
  const tick = () => {
    if (closed || busy) return;
    busy = true;
    void listDesktopProcesses(spec)
      .then((rows) => {
        // Like the Windows monitor, a repair transaction must not block sampling.
        void observe(rows).catch((error) => {
          log?.warn(`${spec.displayName} 启动修复失败：${String(error)}`);
        });
      })
      .catch((error) => log?.warn(`${spec.displayName} 快照扫描失败：${String(error)}`))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(tick, 500);
  tick();
  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}


import { execFile, spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DEFAULT_CDP_CANDIDATE_PORTS, parseRemoteDebuggingFlags } from "./host-discover.js";
import { DEFAULT_CODEX_CDP_PORT, launchCodexWithCdp, pickAvailableCodexPort, type EnsureCodexLog } from "./launch.js";
import {
  findCodexExecutable,
  findPackagedCodexExecutable,
  listCodexProcesses,
  looksLikeCodexMain,
  parseExecutableFromProcess,
  scanLinuxCodexProcesses,
  stopLinuxCodexProcess,
  type CodexProcess,
} from "./processes.js";
import {
  DEFAULT_CODEX_REPAIR_WINDOW_MS,
  classifyCodexStartupProcess,
  CodexStartupRepairController,
  type CodexStartupRepairControllerOptions,
} from "./startup-policy.js";

const execFileAsync = promisify(execFile);

export interface CodexStartupRepairMonitorOptions {
  preferredPort?: number;
  candidatePorts?: readonly number[];
  repairWindowMs?: number;
  log?: EnsureCodexLog;
}

export interface CodexStartupRepairMonitor {
  close: () => void;
}

/**
 * PowerShell emits one compact JSON record for each new Codex main process.
 * Win32_ProcessStartTrace requires privileges that are unavailable on some
 * desktop installs, so PID discovery uses cheap Get-Process snapshots and only
 * performs a targeted CIM command-line read once per new PID.
 */
export function buildWindowsCodexProcessStartScript(parentPid: number): string {
  const safeParentPid = Math.max(0, Math.trunc(parentPid));
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    "$seen=@{};",
    "while($true){",
    `if(-not (Get-Process -Id ${safeParentPid} -ErrorAction SilentlyContinue)){break};`,
    "$current=@{};",
    "$matches=Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue;",
    "foreach($match in @($matches)){",
    "$pidValue=[int]$match.Id;",
    "$current[$pidValue]=$true;",
    "if($seen.ContainsKey($pidValue)){continue};",
    "$p=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $pidValue);",
    "if($null -eq $p){continue};",
    "$name=[string]$p.Name;",
    "$cmd=[string]$p.CommandLine;",
    "$path=[string]$p.ExecutablePath;",
    "if(-not $cmd){continue};",
    "if($cmd -match '\\s--type='){continue};",
    "if($cmd -match '\\bapp-server\\b'){continue};",
    "$created=0;",
    "try{$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "if($created -le 0){$created=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()};",
    "$seen[$pidValue]=$true;",
    "$o=@{pid=$pidValue;name=$name;exe=$path;cmd=$cmd;created=$created};",
    "($o | ConvertTo-Json -Compress -Depth 3);",
    "}",
    "foreach($known in @($seen.Keys)){if(-not $current.ContainsKey($known)){$seen.Remove($known)}};",
    "Start-Sleep -Milliseconds 200;",
    "}",
  ].join(" ");
}

async function repairFreshBlindCodexProcess(
  observed: CodexProcess,
  opts: CodexStartupRepairMonitorOptions,
): Promise<void> {
  const repairWindowMs =
    opts.repairWindowMs ?? DEFAULT_CODEX_REPAIR_WINDOW_MS;
  const live = await listCodexProcesses();
  const exact = live.find((proc) => proc.pid === observed.pid);
  if (!exact) return;
  if (
    classifyCodexStartupProcess(exact, Date.now(), repairWindowMs) !==
    "repair-now"
  ) {
    return;
  }

  // Never recycle a newly spawned secondary instance while an older primary
  // is already serving the user. That path needs an explicit/manual repair.
  if (live.some((proc) => proc.pid !== exact.pid)) {
    opts.log?.warn(
      `检测到 Codex 新进程 ${exact.pid}，但已有主进程；跳过自动重启以保护正在运行的任务。`,
    );
    return;
  }

  const executable =
    parseExecutableFromProcess(exact) ||
    (await findPackagedCodexExecutable()) ||
    findCodexExecutable();
  if (!executable) {
    opts.log?.warn("检测到新的 Codex 进程，但无法确认可执行文件；跳过自动重启。");
    return;
  }

  const preferred = opts.preferredPort ?? DEFAULT_CODEX_CDP_PORT;
  const candidates = opts.candidatePorts ?? DEFAULT_CDP_CANDIDATE_PORTS;
  const port = await pickAvailableCodexPort(preferred, candidates);
  opts.log?.warn(
    `Codex 新主进程 ${exact.pid} 未带 CDP 参数，立即使用 :${port} 修复性重启。`,
  );

  if (process.platform === "linux") {
    // SIGTERM is Chromium's fast clean exit; wait so the relaunch is not
    // swallowed by the still-running singleton.
    if (!(await stopLinuxCodexProcess(exact, true, 5_000))) return;
  } else try {
    // Exact fresh PID only: no /T and no name-wide kill. At <10s there is no
    // established user task to preserve, and /F avoids the old 8s stop delay.
    await execFileAsync("taskkill.exe", ["/PID", String(exact.pid), "/F"], {
      windowsHide: true,
      timeout: 2_000,
    });
  } catch {
    return;
  }
  await delay(120);
  await launchCodexWithCdp(port, executable);
  opts.log?.info(`已立即带 --remote-debugging-port=${port} 重启 Codex`);
}

/**
 * Event-driven fast lane for the original Windows icon. It does not wait for
 * CDP when the newly created main process has no debugging flag at all.
 */
export function startCodexStartupRepairMonitor(
  opts: CodexStartupRepairMonitorOptions = {},
): CodexStartupRepairMonitor {
  if (process.platform === "linux") return startLinuxCodexStartupRepairMonitor(opts);
  if (process.platform !== "win32") return { close: () => {} };

  let closed = false;
  let child: ChildProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const controllerOptions: CodexStartupRepairControllerOptions = {
    repair: (proc) => repairFreshBlindCodexProcess(proc, opts),
  };
  if (opts.repairWindowMs !== undefined) {
    controllerOptions.repairWindowMs = opts.repairWindowMs;
  }
  const controller = new CodexStartupRepairController(controllerOptions);

  const observe = (proc: CodexProcess) => {
    void controller.observe(proc).catch((error) => {
      opts.log?.warn(
        `Codex 启动快速修复失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const reconcile = () => {
    void listCodexProcesses().then(
      (processes) => processes.forEach(observe),
      () => undefined,
    );
  };

  const startChild = () => {
    if (closed) return;
    const script = buildWindowsCodexProcessStartScript(process.pid);
    const monitor = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = monitor;
    let stderr = "";
    monitor.stderr?.on("data", (chunk) => {
      if (stderr.length < 2_000) stderr += String(chunk);
    });
    const lines = readline.createInterface({ input: monitor.stdout! });
    lines.on("line", (line) => {
      let row: {
        pid?: unknown;
        name?: unknown;
        exe?: unknown;
        cmd?: unknown;
        created?: unknown;
      };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        return;
      }
      const commandLine = typeof row.cmd === "string" ? row.cmd : "";
      const name = typeof row.name === "string" ? row.name : "ChatGPT.exe";
      const executablePath = typeof row.exe === "string" ? row.exe : "";
      if (!looksLikeCodexMain(commandLine, name, executablePath)) return;
      const flags = parseRemoteDebuggingFlags(commandLine);
      observe({
        pid: Number(row.pid) || 0,
        name,
        executablePath,
        commandLine,
        port: flags.port,
        createdAtMs:
          Number.isFinite(Number(row.created)) && Number(row.created) > 0
            ? Number(row.created)
            : null,
      });
    });
    let finished = false;
    const finish = (code: number | null, spawnError?: Error) => {
      if (finished) return;
      finished = true;
      lines.close();
      if (child === monitor) child = null;
      if (!closed) {
        const detail = (spawnError?.message || stderr)
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 500);
        opts.log?.warn(
          `Codex 进程启动监听器退出（${code ?? "unknown"}）${detail ? `：${detail}` : ""}，1 秒后恢复。`,
        );
        restartTimer = setTimeout(startChild, 1_000);
      }
    };
    monitor.once("error", (error) => finish(null, error));
    monitor.once("exit", (code) => finish(code));
    reconcile();
  };

  startChild();

  return {
    close: () => {
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      child?.kill();
      child = null;
    },
  };
}

/**
 * Linux fast lane: sample /proc every 300 ms (no unprivileged process-start
 * event exists) and feed the same controller as the Windows monitor.
 */
function startLinuxCodexStartupRepairMonitor(
  opts: CodexStartupRepairMonitorOptions,
): CodexStartupRepairMonitor {
  const controllerOptions: CodexStartupRepairControllerOptions = {
    repair: (proc) => repairFreshBlindCodexProcess(proc, opts),
  };
  if (opts.repairWindowMs !== undefined) {
    controllerOptions.repairWindowMs = opts.repairWindowMs;
  }
  const controller = new CodexStartupRepairController(controllerOptions);
  const timer = setInterval(() => {
    for (const proc of scanLinuxCodexProcesses()) {
      void controller.observe(proc).catch((error) => {
        opts.log?.warn(
          `Codex 启动快速修复失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }, 300);
  return { close: () => clearInterval(timer) };
}

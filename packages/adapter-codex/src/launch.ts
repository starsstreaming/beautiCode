import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DEFAULT_CDP_CANDIDATE_PORTS, discoverCdpEndpoints, type DiscoveredCdpEndpoint } from "./host-discover.js";
import {
  findCodexExecutable,
  findPackagedCodexExecutable,
  listCodexProcesses,
  parseExecutableFromProcess,
  stopLinuxCodexProcess,
  type CodexProcess,
} from "./processes.js";
import { classifyCodexStartupProcess } from "./startup-policy.js";

const execFileAsync = promisify(execFile);
export const DEFAULT_CODEX_CDP_PORT = 9335;

export interface EnsureCodexLog {
  info: (...m: string[]) => void;
  warn: (...m: string[]) => void;
}

export async function isLoopbackPortFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Choose a loopback port without colliding with WorkBuddy or another Electron
 * host. Both products historically default to 9335, so blindly reusing the
 * preferred port makes Codex auto-injection fail whenever WorkBuddy won the
 * race to bind it.
 */
export async function pickAvailableCodexPort(
  preferred: number = DEFAULT_CODEX_CDP_PORT,
  candidates: readonly number[] = DEFAULT_CDP_CANDIDATE_PORTS,
): Promise<number> {
  const ordered = [preferred, ...candidates.filter((port) => port !== preferred)];
  for (const port of ordered) {
    if (
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535 &&
      (await isLoopbackPortFree(port))
    ) {
      return port;
    }
  }
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object"
          ? address.port
          : DEFAULT_CODEX_CDP_PORT;
      server.close(() => resolve(port));
    });
  });
}

export async function stopCodexProcesses(
  procs: readonly CodexProcess[],
): Promise<void> {
  if (process.platform === "linux") {
    for (const proc of procs) await stopLinuxCodexProcess(proc, true);
    return;
  }
  for (const proc of procs) {
    if (!proc.pid || proc.pid <= 0) continue;
    await execFileAsync("taskkill.exe", ["/PID", String(proc.pid), "/T"], {
      windowsHide: true,
      timeout: 8_000,
    }).catch(() => {});
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const still = await listCodexProcesses();
    if (still.length === 0) return;
    await delay(250);
  }
  for (const proc of await listCodexProcesses()) {
    await execFileAsync(
      "taskkill.exe",
      ["/PID", String(proc.pid), "/T", "/F"],
      { windowsHide: true, timeout: 8_000 },
    ).catch(() => {});
  }
}

export interface CodexLaunchCommand {
  file: string;
  args: string[];
}

export function buildCodexLaunchCommand(
  port: number,
  executable: string,
): CodexLaunchCommand {
  return {
    file: executable,
    args: [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
    ],
  };
}

export async function launchCodexWithCdp(
  port: number,
  executable: string,
): Promise<void> {
  const command = buildCodexLaunchCommand(port, executable);
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export interface EnsureCodexCdpOptions {
  preferredPort?: number;
  /** Bounded fallback ports; override in deterministic tests. */
  candidatePorts?: readonly number[];
  /** Include same-user process flags in discovery. Defaults to true on Windows. */
  scanProcesses?: boolean;
  launch?: boolean;
  restartIfBlind?: boolean;
  timeoutMs?: number;
  log?: EnsureCodexLog;
}

export interface EnsuredCodexCdp extends DiscoveredCdpEndpoint {
  launched: boolean;
  restarted: boolean;
}

async function waitForCodexCdp(
  port: number,
  timeoutMs: number,
): Promise<DiscoveredCdpEndpoint | null> {
  return await waitForAnyCodexCdp([port], timeoutMs);
}

async function waitForAnyCodexCdp(
  ports: readonly number[],
  timeoutMs: number,
): Promise<DiscoveredCdpEndpoint | null> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    const hits = await discoverCdpEndpoints({
      ports: [...new Set(ports)],
      scanProcesses: false,
      requirePages: true,
      timeoutMs: 400,
    });
    const hit = hits[0];
    if (hit) return hit;
    await delay(400);
  }
  return null;
}

let ensureChain: Promise<unknown> = Promise.resolve();

async function ensureCodexCdpUnqueued(
  opts: EnsureCodexCdpOptions,
): Promise<EnsuredCodexCdp> {
  const preferred = opts.preferredPort ?? DEFAULT_CODEX_CDP_PORT;
  const candidatePorts = opts.candidatePorts ?? DEFAULT_CDP_CANDIDATE_PORTS;
  const launch = opts.launch !== false;
  const restartIfBlind = opts.restartIfBlind !== false;
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const log = opts.log;

  const existing = (
    await discoverCdpEndpoints({
      ports: [preferred, ...candidatePorts],
      scanProcesses: opts.scanProcesses ?? process.platform === "win32",
      requirePages: true,
      timeoutMs: 450,
    })
  )[0];
  if (existing) {
    return { ...existing, launched: false, restarted: false };
  }

  if (!launch) {
    throw new Error(
      `Codex CDP is missing on loopback (preferred ${preferred}). Start Codex with --remote-debugging-port.`,
    );
  }

  const procs = await listCodexProcesses();
  const exe =
    parseExecutableFromProcess(procs[0]) ||
    (await findPackagedCodexExecutable()) ||
    findCodexExecutable();
  if (!exe) {
    throw new Error(
      "找不到 Codex/ChatGPT Desktop。请先安装，或用带 --remote-debugging-port=9335 的方式启动它。",
    );
  }

  let restarted = false;
  if (procs.length > 0) {
    const hasCdp = procs.some((p) => p.port != null);
    if (!hasCdp && restartIfBlind) {
      const repairable = procs.filter(
        (proc) =>
          classifyCodexStartupProcess(proc, Date.now()) === "repair-now",
      );
      if (repairable.length !== 1 || procs.length !== 1) {
        throw new Error(
          "Codex 已运行超过 10 秒或存在多个主进程；为保护正在运行的任务，不自动重启。请手动退出后重开。",
        );
      }
      const proc = repairable[0]!;
      log?.warn(
        `Codex 新主进程 ${proc.pid} 未带 CDP 参数，立即修复性重启…`,
      );
      if (process.platform === "linux") {
        if (!(await stopLinuxCodexProcess(proc, true, 5_000))) {
          throw new Error("Codex 新主进程已退出，取消本次自动重启。");
        }
      } else try {
        await execFileAsync("taskkill.exe", ["/PID", String(proc.pid), "/F"], {
          windowsHide: true,
          timeout: 2_000,
        });
      } catch {
        throw new Error("Codex 新主进程已退出，取消本次自动重启。");
      }
      await delay(120);
      restarted = true;
    } else if (hasCdp) {
      const declaredPorts = procs
        .map((proc) => proc.port)
        .filter((port): port is number => port != null);
      const waiting = await waitForAnyCodexCdp(
        declaredPorts,
        Math.min(timeoutMs, 15_000),
      );
      if (waiting) return { ...waiting, launched: false, restarted: false };
      throw new Error(
        "Codex 已带调试端口，但 CDP 尚未就绪；已停止自动重启以避免启动循环。",
      );
    } else if (!restartIfBlind) {
      throw new Error(
        "Codex 已在运行但未开启 CDP。请退出后用带 --remote-debugging-address=127.0.0.1 --remote-debugging-port=9335 的方式启动。",
      );
    }
  }

  const port = await pickAvailableCodexPort(preferred, candidatePorts);
  if (port !== preferred) {
    log?.warn(`本机端口 ${preferred} 已被占用，Codex 改用 ${port}`);
  }
  log?.info(`带 --remote-debugging-port=${port} 启动 Codex`);
  await launchCodexWithCdp(port, exe);
  const ready = await waitForCodexCdp(port, timeoutMs);
  if (!ready) {
    throw new Error(
      `已直接启动 Codex，但 ${timeoutMs}ms 内未出现带 app:// 主页面的本机 CDP。`,
    );
  }
  return { ...ready, launched: true, restarted };
}

/**
 * WorkBuddy-style ensure: attach if a Codex CDP is already up; otherwise
 * launch (or restart a blind instance) with loopback debugging flags.
 */
export function ensureCodexCdp(
  opts: EnsureCodexCdpOptions = {},
): Promise<EnsuredCodexCdp> {
  const run = () => ensureCodexCdpUnqueued(opts);
  const next = ensureChain.then(run, run);
  ensureChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

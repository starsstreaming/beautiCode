import { discoverDesktopCdp } from "./cdp.js";
import { listDesktopProcesses } from "./launch.js";
import { classifyDesktopStartupProcess, repairDesktopProcess, waitForDesktopCdp } from "./startup-repair.js";
import type { DesktopCdpEndpoint, DesktopCdpHostSpec, DesktopEnsureLog } from "./types.js";

/**
 * Attach or repair only a fresh, already-started host. A missing process is
 * never launched: that invariant is what makes an intentional user close stay
 * closed while the guardian remains alive.
 */
export async function ensureDesktopCdp(
  spec: DesktopCdpHostSpec,
  opts: { timeoutMs?: number; log?: DesktopEnsureLog } = {},
): Promise<DesktopCdpEndpoint> {
  const ports = [spec.defaultPort, ...spec.candidatePorts];
  const existing = await discoverDesktopCdp(spec, ports);
  if (existing) return existing;
  const processes = await listDesktopProcesses(spec);
  if (processes.length === 0) {
    throw new Error(`${spec.displayName} 未运行；等待用户从原始图标启动。`);
  }
  const declared = processes
    .map((row) => row.port)
    .filter((port): port is number => port != null);
  if (declared.length > 0) {
    const ready = await waitForDesktopCdp(
      spec,
      declared,
      Math.min(opts.timeoutMs ?? 15_000, 15_000),
    );
    if (ready) return ready;
    throw new Error(`${spec.displayName} 已带 CDP 参数，但目标页尚未就绪。`);
  }
  const repairable = processes.filter(
    (row) => classifyDesktopStartupProcess(row) === "repair-now",
  );
  if (processes.length !== 1 || repairable.length !== 1) {
    throw new Error(`${spec.displayName} 已运行超过 10 秒；为保护用户会话，不自动重启。`);
  }
  const repaired = await repairDesktopProcess(spec, repairable[0]!, opts.log);
  if (repaired !== "launched") {
    throw new Error(`${spec.displayName} 修复事务未通过 CDP 验证。`);
  }
  const ready = await waitForDesktopCdp(spec, ports, opts.timeoutMs ?? 30_000);
  if (!ready) throw new Error(`${spec.displayName} 修复性重启后 CDP 未就绪。`);
  return ready;
}


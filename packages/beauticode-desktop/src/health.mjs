import path from "node:path";
import { spawnSync } from "node:child_process";

/** Read-only host diagnostics, wired to the aggregate's install and runtime boundaries. */
export function createHealthRunner(deps) {
  function runJsonProbe(script, args, options) {
    try {
      const result = (options.spawnSync || spawnSync)(process.execPath, [script, ...args], {
        cwd: options.runtimeRoot,
        env: { ...process.env, ...(options.env || {}), BEAUTICODE_PACKAGED_RUNTIME: "1" },
        encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 0) return { ok: false, reason: "probe-failed" };
      return JSON.parse(String(result.stdout || ""));
    } catch {
      return { ok: false, reason: "probe-invalid-response" };
    }
  }

  async function runHostHealth(host, options = {}) {
    const resolved = deps.defaultOptions(options);
    const installation = deps.getHostStatus(host, resolved);
    if (host === "codex") {
      const codex = await deps.runCodexHealth(options);
      const client = codex.host || "unknown";
      const state = codex.installation !== "ready" || codex.guardian !== "running"
        ? "guardian-not-ready"
        : client === "closed" ? "waiting-for-launch"
        : client !== "running" ? "host-ambiguous"
        : codex.cdp !== "connected" ? "cdp-missing"
        : codex.entry === "visible" ? "ready" : "entry-missing";
      return {
        ...codex,
        host: "codex", client, state,
        processCount: client === "closed" ? 0 : client === "running" ? 1 : null,
        clientGeneration: null,
        executableFingerprint: null,
      };
    }
    if (host === "dsh") {
      const conflict = resolved.platform === "win32" ? deps.inspectDshLinkConflict(resolved) : null;
      return {
        host, installation: installation.installed ? "plugin-present" : "missing",
        runtime: "dsh-plugin", guardian: "not-applicable",
        entry: installation.installed ? "not-observable" : "missing",
        state: conflict ? "conflict" : installation.installed ? "plugin-installed" : "not-installed",
        ...(conflict ? { reason: conflict } : {}),
      };
    }
    if (resolved.platform !== "win32") return { host, installation: "unsupported-platform", state: "not-checked" };
    const runtimeRoot = options.runtimeRoot || deps.defaultRuntimeRoot;
    const script = host === "workbuddy"
      ? path.join(runtimeRoot, "workbuddy", "scripts", "wb-setup.mjs")
      : path.join(runtimeRoot, "desktop", "scripts", "desktop-cdp-setup.mjs");
    const args = host === "workbuddy"
      ? ["status", "--machine-status"]
      : ["--host", host, "status"];
    const status = runJsonProbe(script, args, { ...options, runtimeRoot });
    if (status.ok === false) return { host, installation: installation.installed ? "installed" : "missing", guardian: "unknown", state: status.reason };
    const health = host === "workbuddy" ? status.health : status.cdp;
    const guardian = status.running === true ? "running" : "not-running";
    const client = health?.client || status.cdp?.client || (status.cdp?.connected ? "running" : "closed-or-unknown");
    const state = !installation.installed ? "not-installed"
      : guardian !== "running" ? "guardian-not-ready"
      : client === "closed" ? "waiting-for-launch"
      : health?.state || status.cdp?.state || "not-checked";
    return {
      host,
      installation: installation.installed ? "installed" : "missing",
      guardian,
      client,
      processCount: health?.processCount ?? status.cdp?.processCount ?? null,
      clientGeneration: health?.clientGeneration ?? status.cdp?.clientGeneration ?? null,
      executableFingerprint: health?.executableFingerprint ?? status.cdp?.executableFingerprint ?? null,
      cdp: health?.cdp || (status.cdp?.connected ? "connected" : "missing"),
      port: health?.port ?? status.cdp?.port ?? null,
      anchor: health?.anchor ?? status.cdp?.anchor ?? null,
      anchorTextMatches: health?.anchorTextMatches ?? status.cdp?.anchorTextMatches ?? null,
      entry: health?.entry ?? status.cdp?.entry ?? null,
      style: health?.style ?? status.cdp?.style ?? null,
      stage: health?.stage ?? status.cdp?.stage ?? null,
      state,
    };
  }

  async function runAllHealth(options = {}) {
    const hosts = await Promise.all(deps.hosts.map((host) => runHostHealth(host, options)));
    return { command: "health", hosts };
  }

  return { runHostHealth, runAllHealth };
}

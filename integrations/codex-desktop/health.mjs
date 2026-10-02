import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCodexRunKeyAdapter, createCodexTaskAdapter } from "./task-wiring.mjs";
import { parseCodexLockOwner, processCommandLine } from "./lifecycle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "beautiCode");

export function classifyEntry(node) {
  if (!node?.exists) return "not-mounted";
  return node.inViewport && node.hitTest ? "visible" : "offscreen";
}

function actionFor(result) {
  if (result.installation !== "ready" || result.guardian !== "running") return "inspect-guardian";
  if (result.host === "unknown") return "inspect-guardian";
  if (result.host === "closed") return "wait-for-launch";
  if (result.host === "running" && result.cdp === "missing") return "manual-restart-available";
  return "none";
}

export async function probeCodexHealth(deps, timeoutMs = 16_000) {
  const result = {
    installation: "incomplete", taskOwned: false, runKeyOwned: false,
    guardian: "unknown", host: "unknown", cdp: "unknown",
    entry: "not-checked", primaryPages: 0, action: "none",
  };
  const deadline = Date.now() + timeoutMs;
  async function stage(name, read) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: `probe-timeout:${name}` };
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(read),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error("timeout")), remaining); }),
      ]);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, reason: error?.message === "timeout" ? `probe-timeout:${name}` : `probe-failed:${name}` };
    } finally { clearTimeout(timer); }
  }
  const [installation, guardian, host] = await Promise.all([
    stage("installation", deps.installation),
    stage("guardian", deps.guardian),
    stage("host", deps.host),
  ]);
  if (installation.ok) {
    result.taskOwned = installation.value?.taskOwned === true;
    result.runKeyOwned = installation.value?.runKeyOwned === true;
    const startupOwned = result.taskOwned || result.runKeyOwned;
    result.installation = installation.value?.runtimeReady && startupOwned ? "ready" : installation.value?.runtimeReady ? "incomplete" : "missing";
  }
  if (guardian.ok) result.guardian = guardian.value;
  if (host.ok && Array.isArray(host.value)) {
    result.host = host.value.length === 0 ? "closed" : host.value.length === 1 ? "running" : "ambiguous";
  }
  result.reason = [installation, guardian, host].find((value) => !value.ok)?.reason;
  if (!result.reason && result.host === "running") {
    const cdp = await stage("cdp", () => deps.cdp(host.value[0]));
    if (!cdp.ok) result.reason = cdp.reason;
    else {
      result.cdp = cdp.value?.state ?? "unknown";
      result.primaryPages = Number.isInteger(cdp.value?.primaryPages) ? cdp.value.primaryPages : 0;
      if (result.cdp === "connected") {
        const entry = await stage("entry", () => deps.entry(cdp.value));
        if (entry.ok) result.entry = entry.value;
        else result.reason = entry.reason;
      }
    }
  }
  result.action = actionFor(result);
  return { ...result };
}

function adapterFile() {
  const vendor = path.join(here, "vendor", "adapter-codex", "index.js");
  return fs.existsSync(vendor) ? vendor : path.join(here, "../../packages/adapter-codex/dist/index.js");
}

export function isCodexRuntimeReady(baseRoot) {
  const home = path.join(baseRoot, "codex-plugin");
  const runtimeHome = home;
  if (!fs.existsSync(path.join(home, "codex-watchdog.mjs")) ||
      !fs.existsSync(path.join(runtimeHome, "launcher.ps1"))) return false;
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(runtimeHome, "current.json"), "utf8"));
    if (pointer.schema !== "beauticode.runtime/v1" || pointer.host !== "codex-plugin" ||
        !/^[A-Za-z0-9._-]+$/.test(pointer.version) || pointer.entrypoint !== "codex-watchdog.mjs") return false;
    return fs.existsSync(path.join(runtimeHome, "versions", pointer.version, pointer.entrypoint));
  } catch { return false; }
}

async function installed() {
  const home = path.join(base(), "codex-plugin");
  const runtimeReady = isCodexRuntimeReady(base());
  if (process.platform !== "win32") return { runtimeReady: false, taskOwned: false, runKeyOwned: false };
  const starter = path.join(home, "start-watch.ps1");
  const task = createCodexTaskAdapter(starter);
  let runKeyOwned = false;
  try { runKeyOwned = await createCodexRunKeyAdapter(starter).read() !== null; }
  catch { /* Unowned or unreadable startup wiring cannot establish readiness. */ }
  try {
    if (!(await task.read())) return { runtimeReady, taskOwned: false, runKeyOwned };
    await task.assertOwned();
    return { runtimeReady, taskOwned: true, runKeyOwned };
  } catch { return { runtimeReady, taskOwned: false, runKeyOwned }; }
}

async function guardianState() {
  const lock = path.join(base(), "hosts", "codex", "guardian.lock");
  let raw;
  try { raw = await fsp.readFile(lock, "utf8"); }
  catch (error) { return error?.code === "ENOENT" ? "stopped" : "unknown"; }
  const owner = parseCodexLockOwner(raw);
  if (!owner) return "unknown";
  const command = processCommandLine(owner.pid).replaceAll("\\", "/").toLowerCase();
  return command.includes("/codex-watchdog.mjs") &&
    (command.includes(path.join(base(), "codex-plugin").replaceAll("\\", "/").toLowerCase()) ||
     command.includes(path.join(base(), "runtime", "codex-plugin").replaceAll("\\", "/").toLowerCase()))
    ? "running" : "unknown";
}

const ENTRY_EXPRESSION = `(() => {
  const node = document.getElementById('beauticode-console');
  if (!node) return { exists: false };
  const rect = node.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const inViewport = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  const front = inViewport ? document.elementFromPoint(x, y) : null;
  return { exists: true, inViewport, hitTest: Boolean(front && (front === node || node.contains(front))) };
})()`;

export async function probeLocalCodexHealth() {
  if (process.platform !== "win32") return {
    installation: "missing", taskOwned: false, runKeyOwned: false, guardian: "unknown", host: "unknown",
    cdp: "unknown", entry: "not-checked", primaryPages: 0, action: "none", reason: "unsupported-platform",
  };
  const adapter = await import(pathToFileURL(adapterFile()).href);
  return probeCodexHealth({
    installation: installed,
    guardian: guardianState,
    host: adapter.listCodexProcesses,
    async cdp(host) {
      if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) return { state: "missing" };
      try {
        const version = await adapter.fetchCdpVersion(host.port);
        const browserId = adapter.browserIdFromVersion(version, host.port);
        const targets = await adapter.listPageTargets(host.port, browserId);
        const primary = adapter.selectCodexPrimaryTargets(targets);
        return primary.length ? { state: "connected", primaryPages: primary.length, port: host.port, target: primary[0] } : { state: "wrong-host" };
      } catch { return { state: "unknown" }; }
    },
    async entry(cdp) {
      const session = await adapter.connectPageTarget(cdp.target, cdp.port, {
        openTimeoutMs: 1_000, commandTimeoutMs: 1_000, enableDomains: false,
      });
      try { return classifyEntry(await session.evaluate(ENTRY_EXPRESSION, { userGesture: false })); }
      finally { session.close(); }
    },
  });
}

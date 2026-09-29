import fs from "node:fs";
import path from "node:path";
import { discoverWorkBuddyCdp, readBoundedJson, DEFAULT_WORKBUDDY_CDP_PORTS } from "./discovery.js";
import { listWorkBuddyProcesses } from "./launch.js";
import { assertLoopbackDebuggerUrl, pickWorkBuddyTarget, type WorkBuddyTarget } from "./target.js";

export interface WorkBuddyUiHealthSnapshot {
  host: "workbuddy";
  client: "closed" | "running" | "ambiguous" | "unknown";
  processCount: number;
  clientGeneration: number | null;
  executableFingerprint: string | null;
  cdp: "connected" | "missing";
  port: number | null;
  anchor: boolean | null;
  entry: boolean | null;
  style: boolean | null;
  stage: boolean | null;
  state: "ready" | "waiting-for-launch" | "cdp-missing" | "host-ui-updated" | "entry-missing" | "partial-injection" | "probe-failed";
}

type WorkBuddyUiProbe = Pick<WorkBuddyUiHealthSnapshot, "anchor" | "entry" | "style" | "stage">;

async function evaluatePage(target: WorkBuddyTarget, port: number): Promise<WorkBuddyUiProbe> {
  if (!target.webSocketDebuggerUrl) throw new Error("WorkBuddy target omitted its debugger socket.");
  const ws = new WebSocket(assertLoopbackDebuggerUrl(target.webSocketDebuggerUrl, port));
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("WebSocket open failed.")); };
      const onClose = () => { cleanup(); reject(new Error("WebSocket closed before open.")); };
      timer = setTimeout(() => { cleanup(); reject(new Error("WebSocket open timeout.")); }, 1_200);
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("close", onClose, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const requestId = 1;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      };
      const onError = () => { cleanup(); reject(new Error("Runtime probe socket failed.")); };
      const onClose = () => { cleanup(); reject(new Error("Runtime probe socket closed.")); };
      const onMessage = (event: MessageEvent) => {
        let message: unknown;
        try { message = JSON.parse(String(event.data)) as unknown; }
        catch { return; }
        if (!message || typeof message !== "object") return;
        const record = message as Record<string, unknown>;
        if (record.id !== requestId) return;
        cleanup();
        if (record.error) {
          reject(new Error("Runtime probe command failed."));
          return;
        }
        const result = record.result;
        const nested = result && typeof result === "object" ? (result as Record<string, unknown>).result : null;
        const value = nested && typeof nested === "object" ? (nested as Record<string, unknown>).value : null;
        if (!value || typeof value !== "object") {
          reject(new Error("Invalid runtime probe response."));
          return;
        }
        const fields = value as Record<string, unknown>;
        if (["anchor", "entry", "style", "stage"].some((key) => typeof fields[key] !== "boolean")) {
          reject(new Error("Invalid runtime probe fields."));
          return;
        }
        resolve({ anchor: fields.anchor as boolean, entry: fields.entry as boolean, style: fields.style as boolean, stage: fields.stage as boolean });
      };
      timer = setTimeout(() => { cleanup(); reject(new Error("Runtime probe timeout.")); }, 1_200);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      try {
        ws.send(JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: {
            returnByValue: true,
            expression: `(() => ({anchor:!!document.querySelector('.conversation-list .conversation-list-tabs'),entry:!!document.getElementById('beauticode-workbuddy-bg-entry'),style:!!document.getElementById('beauticode-workbuddy-bg-style'),stage:!!document.getElementById('beauticode-bg-stage')}))()`,
          },
        }));
      } catch {
        cleanup();
        reject(new Error("Runtime probe could not be sent."));
      }
    });
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

/** Read-only host-specific probe; WorkBuddy's navigation contract differs from the desktop-CDP hosts. */
export async function inspectWorkBuddyUiHealth(): Promise<WorkBuddyUiHealthSnapshot> {
  const processes = await listWorkBuddyProcesses();
  const primary = processes.length === 1 ? processes[0] : null;
  let executableFingerprint: string | null = null;
  if (primary?.executablePath) {
    try {
      const resources = path.join(path.dirname(primary.executablePath), "resources", "app.asar");
      const file = fs.existsSync(resources) ? resources : primary.executablePath;
      const stat = fs.statSync(file);
      executableFingerprint = `${path.basename(file)}:${Math.trunc(stat.mtimeMs)}-${stat.size}`;
    } catch { /* executable metadata can be temporarily unavailable during update */ }
  }
  const client: WorkBuddyUiHealthSnapshot["client"] = processes.length === 0 ? "closed" : processes.length === 1 ? "running" : "ambiguous";
  const endpoint = await discoverWorkBuddyCdp({ ports: [...new Set(DEFAULT_WORKBUDDY_CDP_PORTS)] });
  const identity = {
    host: "workbuddy" as const,
    client,
    processCount: processes.length,
    clientGeneration: primary?.createdAtMs ?? null,
    executableFingerprint,
  };
  if (!endpoint) return {
    ...identity,
    cdp: "missing", port: null, anchor: null, entry: null, style: null, stage: null,
    state: client === "closed" ? "waiting-for-launch" : "cdp-missing",
  };
  try {
    const raw = await readBoundedJson(`${endpoint.browserUrl}/json/list`, { timeoutMs: 700 });
    const targets: WorkBuddyTarget[] = [];
    if (Array.isArray(raw) && raw.length <= 500) {
      for (const row of raw) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.type !== "string" || typeof record.url !== "string") continue;
        const target: WorkBuddyTarget = { id: record.id, type: record.type, url: record.url };
        if (typeof record.title === "string") target.title = record.title;
        if (typeof record.webSocketDebuggerUrl === "string") target.webSocketDebuggerUrl = record.webSocketDebuggerUrl;
        targets.push(target);
      }
    }
    const target = pickWorkBuddyTarget(targets);
    if (!target) throw new Error("WorkBuddy target missing.");
    const ui = await evaluatePage(target, endpoint.port);
    const state = !ui.anchor ? "host-ui-updated" : !ui.entry ? "entry-missing" : !ui.style || !ui.stage ? "partial-injection" : "ready";
    return { ...identity, client: client === "closed" ? "unknown" : client, cdp: "connected", port: endpoint.port, ...ui, state };
  } catch {
    return {
      ...identity,
      client: client === "closed" ? "unknown" : client,
      cdp: "connected", port: endpoint.port,
      anchor: null, entry: null, style: null, stage: null, state: "probe-failed",
    };
  }
}

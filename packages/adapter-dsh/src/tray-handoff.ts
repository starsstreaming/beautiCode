import fs from "node:fs/promises";
import path from "node:path";

export const TRAY_CLAIM_FILE = "tray-claim.json";
export const TRAY_CLAIM_SCHEMA = "beauticode.tray-claim/v1";
export const SESSION_HOST_FILE = "session-host.json";
export const SESSION_HOST_SCHEMA = "beauticode.session-host/v1";
export const DSH_CONTROL_FILE = "dsh-control.json";
export const DSH_CONTROL_SCHEMA = "beauticode.dsh-control/v1";

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function readLivePid(filePath: string, schema?: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { schema?: unknown; pid?: unknown };
    if (schema && parsed.schema !== schema) return null;
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

/** True when the tray is starting or a different session-host owns the data root. */
export async function trayHandoffRequested(
  dataRoot: string,
  selfPid: number = process.pid,
): Promise<boolean> {
  const root = path.resolve(dataRoot);
  const claimPid = await readLivePid(path.join(root, TRAY_CLAIM_FILE), TRAY_CLAIM_SCHEMA);
  // In-process sessions never write this file; any live claim means the tray wants the lock.
  if (claimPid != null) return true;
  const hostPid = await readLivePid(path.join(root, SESSION_HOST_FILE), SESSION_HOST_SCHEMA);
  if (hostPid != null && hostPid !== selfPid) return true;
  const controlPid = await readLivePid(path.join(root, DSH_CONTROL_FILE), DSH_CONTROL_SCHEMA);
  return controlPid != null && controlPid !== selfPid;
}

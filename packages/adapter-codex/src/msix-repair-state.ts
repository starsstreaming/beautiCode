import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const COOLDOWN_MS = 5 * 60_000;

export function defaultMsixRepairMarkerPath(): string {
  const local = process.env.LOCALAPPDATA
    || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "beautiCode", "hosts", "codex", "msix-repair-failed.json");
}

export async function isMsixRepairSuppressed(
  packageFullName: string,
  markerPath = defaultMsixRepairMarkerPath(),
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    const raw = await fs.readFile(markerPath, "utf8");
    const marker = JSON.parse(raw) as { packageFullName?: unknown; untilMs?: unknown };
    return marker.packageFullName === packageFullName
      && typeof marker.untilMs === "number"
      && Number.isFinite(marker.untilMs)
      && nowMs < marker.untilMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // A partial or unreadable failure marker must not trigger another kill.
    return true;
  }
}

export async function markMsixRepairFailure(
  packageFullName: string,
  markerPath = defaultMsixRepairMarkerPath(),
  nowMs = Date.now(),
): Promise<void> {
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  const temporary = `${markerPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({
      packageFullName,
      untilMs: nowMs + COOLDOWN_MS,
    }), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, markerPath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function clearMsixRepairFailure(
  markerPath = defaultMsixRepairMarkerPath(),
): Promise<void> {
  await fs.unlink(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

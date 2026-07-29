import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface FileLockOwner {
  pid: number;
  nonce: string;
  startedAt: string;
  purpose?: string;
}

export interface FileLockLease {
  owner: FileLockOwner;
  release(): Promise<void>;
}

export interface AcquireFileLockOptions {
  purpose?: string;
  staleMs?: number;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseOwner(raw: string): FileLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<FileLockOwner>;
    if (
      !Number.isInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.nonce !== "string" ||
      !/^[a-f0-9-]{16,80}$/i.test(value.nonce) ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return value as FileLockOwner;
  } catch {
    return null;
  }
}

function parseOwnerPid(raw: string): number | null {
  const owner = parseOwner(raw);
  if (owner) return owner.pid;
  // Migration guard for pre-nonce injector.lock files. They cannot be safely
  // released by this implementation, but a live legacy pid must still block
  // takeover instead of creating two injectors.
  try {
    const value = JSON.parse(raw) as { pid?: unknown };
    const pid = Number(value?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Cross-process lease acquired with O_EXCL (`wx`).
 *
 * The nonce prevents one same-pid owner from releasing another lock. Dead or
 * stale malformed owners are quarantined before retrying, so takeover never
 * uses a read-then-overwrite window.
 */
export async function acquireFileLock(
  filePath: string,
  opts: AcquireFileLockOptions = {},
): Promise<FileLockLease> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const staleMs = Math.max(1_000, opts.staleMs ?? 120_000);
  const owner: FileLockOwner = {
    pid: process.pid,
    nonce: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const handle = await fs.open(resolved, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.rm(resolved, { force: true }).catch(() => {});
        throw error;
      }

      let released = false;
      return {
        owner,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            const raw = await fs.readFile(resolved, "utf8");
            const current = parseOwner(raw);
            if (current?.nonce !== owner.nonce) return;
          } catch {
            return;
          } finally {
            await handle.close().catch(() => {});
          }
          try {
            const raw = await fs.readFile(resolved, "utf8");
            if (parseOwner(raw)?.nonce === owner.nonce) {
              await fs.rm(resolved, { force: true });
            }
          } catch {
            /* already released/taken over */
          }
        },
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "EEXIST") throw error;
    }

    let raw = "";
    let age = 0;
    try {
      const [text, stat] = await Promise.all([
        fs.readFile(resolved, "utf8"),
        fs.stat(resolved),
      ]);
      raw = text;
      age = Date.now() - stat.mtimeMs;
    } catch {
      continue;
    }
    const existing = parseOwner(raw);
    const existingPid = parseOwnerPid(raw);
    if (existingPid != null && isPidAlive(existingPid)) {
      throw new Error(
        `Another ${opts.purpose ?? "operation"} is running (pid ${existingPid}).`,
      );
    }
    if (!existing && age <= staleMs) {
      throw new Error(
        `Another ${opts.purpose ?? "operation"} may be starting; lock owner is not readable yet.`,
      );
    }

    const quarantine = `${resolved}.stale-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.rename(resolved, quarantine);
      const movedRaw = await fs.readFile(quarantine, "utf8").catch(() => "");
      if (movedRaw !== raw) {
        await fs.rename(quarantine, resolved).catch(() => {});
        continue;
      }
      await fs.rm(quarantine, { force: true });
    } catch {
      await fs.rm(quarantine, { force: true }).catch(() => {});
    }
  }
  throw new Error(`Could not acquire ${opts.purpose ?? "file"} lock.`);
}

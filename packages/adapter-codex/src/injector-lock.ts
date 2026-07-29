import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "@beauticode/core";
import { CdpError } from "./cdp.js";

export interface InjectorLock {
  pid: number;
  port: number;
  startedAt: string;
  nonce: string;
}

function lockPath(dataRoot: string): string {
  return path.join(dataRoot, "injector.lock");
}

/** Single-owner, nonce-bound injector lease. */
export async function acquireInjectorLock(
  dataRoot: string,
  port: number,
): Promise<() => Promise<void>> {
  await fs.mkdir(dataRoot, { recursive: true });
  const file = lockPath(dataRoot);
  try {
    const lease = await acquireFileLock(file, {
      purpose: "beautiCode injector",
    });
    const lock: InjectorLock = {
      pid: lease.owner.pid,
      port,
      startedAt: lease.owner.startedAt,
      nonce: lease.owner.nonce,
    };
    const handle = await fs.open(file, "r+");
    try {
      await handle.truncate(0);
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return () => lease.release();
  } catch (error) {
    throw new CdpError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

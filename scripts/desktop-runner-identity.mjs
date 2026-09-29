import fsp from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "./portable-runtime.mjs";

function normalized(value) {
  return path.win32.normalize(String(value || "")).toLowerCase();
}

export function isManagedDesktopRunner(record, current, context) {
  if (!record || !current || !context || record.schema !== "beauticode.desktop-runner/v1") return false;
  if (record.host !== context.host || Number(record.pid) !== Number(current.pid)) return false;
  if (normalized(record.image) !== normalized(current.image) || !/\\node(?:\.exe)?$/i.test(normalized(current.image))) return false;
  const runner = normalized(record.runner);
  const hostRoot = normalized(context.stableHostRoot);
  const stable = runner.startsWith(`${hostRoot}\\`) && runner.endsWith("\\scripts\\desktop-cdp-runner.mjs");
  if (!stable && runner !== normalized(context.sourceRunner)) return false;
  if (normalized(record.pidFile) !== normalized(context.pidFile)) return false;
  const cmd = String(current.commandLine || "");
  const lower = normalized(cmd);
  if (!lower.includes(runner) || !lower.includes(normalized(context.pidFile))) return false;
  if (!/(?:^|\s)--watchdog(?:\s|$)/i.test(cmd)) return false;
  if (!new RegExp(`(?:^|\\s)--host(?:=|\\s+)${context.host}(?:\\s|$)`, "i").test(cmd)) return false;
  const created = Number(current.createdAtMs);
  const started = Number(record.startedAtMs);
  return Number.isFinite(created) && created > 0 && Number.isFinite(started) && started > 0 &&
    Math.abs(created - started) <= 120_000;
}

export async function startDesktopGuardian({
  context, start, readRecord, readProcess,
  deadlineMs = 8_000, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const startedAt = now();
  await start();
  const deadline = startedAt + deadlineMs;
  do {
    const record = await readRecord();
    if (record && Number(record.startedAtMs) >= startedAt - 1_000) {
      const current = await readProcess(Number(record.pid));
      if (isManagedDesktopRunner(record, current, context)) {
        return { pid: Number(current.pid), createdAtMs: Number(current.createdAtMs) };
      }
    }
    if (now() >= deadline) break;
    await sleep(150);
  } while (now() <= deadline);
  throw new Error("guardian-not-ready");
}

async function readOptional(file) {
  try { return await fsp.readFile(file, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function withDesktopWiringRollback({ pointerPath, startupVbs, executableRecord, run }) {
  const beforePointer = await readOptional(pointerPath);
  const beforeStartup = await readOptional(startupVbs);
  const beforeExecutable = executableRecord ? await readOptional(executableRecord) : null;
  try { return await run(); }
  catch (error) {
    if (beforePointer === null) await fsp.rm(pointerPath, { force: true });
    else await writeTextAtomic(pointerPath, beforePointer);
    if (beforeStartup === null) await fsp.rm(startupVbs, { force: true });
    else await writeTextAtomic(startupVbs, beforeStartup);
    if (executableRecord) {
      if (beforeExecutable === null) await fsp.rm(executableRecord, { force: true });
      else await writeTextAtomic(executableRecord, beforeExecutable);
    }
    throw error;
  }
}

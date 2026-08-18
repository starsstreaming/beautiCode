import path from "node:path";
import {
  TRAY_STARTING_MESSAGE,
  callDshControl,
  readDshControlFile,
  readTrayClaim,
} from "./control-client.mjs";
import { canvasImagePath } from "./presets.mjs";

const sessions = new Map();

export const ENGINE_MISSING_MESSAGE =
  "beautiCode 插件未能加载本机导入引擎。请先自己运行 dsh web，并从完整安装目录加载桥接。";

export function resolvePluginBaseUrl(ctx) {
  const port = ctx?.webServer?.port;
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return `http://127.0.0.1:${port}`;
  }
  const configured = ctx?.webServer?.host;
  if (configured && typeof ctx.webServer.port === "number") {
    return `http://127.0.0.1:${ctx.webServer.port}`;
  }
  return "http://127.0.0.1:3080";
}

function sessionKey(dataRoot) {
  return path.resolve(dataRoot);
}

async function loadAdapter() {
  const errors = [];
  for (const specifier of [
    "@beauticode/adapter-dsh",
    new URL("../../packages/adapter-dsh/dist/index.js", import.meta.url).href,
  ]) {
    try {
      return await import(specifier);
    } catch (error) {
      errors.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const failure = new Error(`${ENGINE_MISSING_MESSAGE}（${errors.join("；")}）`);
  failure.code = "ENGINE_MISSING";
  throw failure;
}

export async function hasLiveTray(dataRoot) {
  const control = await readDshControlFile(dataRoot);
  if (!control) return false;
  try {
    await callDshControl(dataRoot, {
      method: "GET",
      path: "/health",
      timeoutMs: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function hasLiveTrayClaim(dataRoot) {
  return Boolean(await readTrayClaim(dataRoot));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureInProcessSession(options) {
  const dataRoot = path.resolve(options.dataRoot);
  const baseUrl = options.baseUrl || "http://127.0.0.1:3080";
  const key = sessionKey(dataRoot);
  const current = sessions.get(key);
  if (current?.session && !current.session.isOpen) {
    sessions.delete(key);
  } else if (current?.session?.isOpen) {
    return current.session;
  } else if (current?.promise) {
    return current.promise;
  }

  const promise = (async () => {
    if (await hasLiveTray(dataRoot) || await hasLiveTrayClaim(dataRoot)) {
      const error = new Error(TRAY_STARTING_MESSAGE);
      error.code = "TRAY_CLAIMED";
      throw error;
    }
    const adapter = await loadAdapter();
    const session = new adapter.DshSession({
      dataRoot,
      baseUrl,
      verifyDeadlineMs: 30_000,
      bundledGalleryImagePath: canvasImagePath() || undefined,
    });
    try {
      await session.start();
    } catch (error) {
      const message = adapter.toChineseErrorMessage(error);
      throw new Error(message);
    }
    const stored = sessions.get(key);
    if (stored) stored.session = session;
    return session;
  })();

  sessions.set(key, { session: null, promise });
  try {
    return await promise;
  } catch (error) {
    sessions.delete(key);
    throw error;
  }
}

export async function stopInProcessSession(dataRoot) {
  if (dataRoot == null) {
    const all = [...sessions.keys()];
    await Promise.all(all.map((key) => stopInProcessSession(key)));
    return;
  }
  const key = sessionKey(dataRoot);
  const current = sessions.get(key);
  sessions.delete(key);
  if (!current) return;
  try {
    const session = current.session ?? (await current.promise.catch(() => null));
    if (session) await session.stop();
  } catch {
    /* ignore */
  }
}

export async function resolveApplyBackend(options) {
  if (await hasLiveTray(options.dataRoot)) {
    return { kind: "tray" };
  }
  if (await hasLiveTrayClaim(options.dataRoot)) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await hasLiveTray(options.dataRoot)) {
        return { kind: "tray" };
      }
      await sleep(100);
    }
    if (await hasLiveTrayClaim(options.dataRoot)) {
      const error = new Error(TRAY_STARTING_MESSAGE);
      error.code = "TRAY_CLAIMED";
      throw error;
    }
  }
  try {
    const session = await ensureInProcessSession(options);
    return { kind: "local", session };
  } catch (error) {
    if (await hasLiveTray(options.dataRoot)) {
      return { kind: "tray" };
    }
    throw error;
  }
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONTROL_SCHEMA = "beauticode.dsh-control/v1";
export const CONTROL_FILE = "dsh-control.json";
export const SESSION_HOST_SCHEMA = "beauticode.session-host/v1";
export const SESSION_HOST_FILE = "session-host.json";
export const TRAY_CLAIM_SCHEMA = "beauticode.tray-claim/v1";
export const TRAY_CLAIM_FILE = "tray-claim.json";
export const TRAY_MISSING_MESSAGE =
  "未找到正在运行的 beautiCode 托盘。请先启动 beautiCode，再导入背景。";
export const TRAY_STARTING_MESSAGE = "beautiCode 托盘正在启动，请稍后再试。";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const TOKEN_MIN_LENGTH = 24;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function defaultBeauticodeDataRoot() {
  if (process.env.BEAUTICODE_DATA_ROOT) {
    return path.resolve(process.env.BEAUTICODE_DATA_ROOT);
  }
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "beautiCode");
  }
  return path.join(os.homedir(), ".beauticode");
}

export function controlFilePath(dataRoot) {
  return path.join(path.resolve(dataRoot), CONTROL_FILE);
}

export function sessionHostFilePath(dataRoot) {
  return path.join(path.resolve(dataRoot), SESSION_HOST_FILE);
}

export function trayClaimFilePath(dataRoot) {
  return path.join(path.resolve(dataRoot), TRAY_CLAIM_FILE);
}

async function writeAtomicJson(dataRoot, fileName, payload) {
  await fs.mkdir(dataRoot, { recursive: true });
  const file = path.join(dataRoot, fileName);
  const tmp = path.join(
    dataRoot,
    `.${fileName}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.unlink(file);
  } catch (error) {
    if (error && typeof error === "object" && error.code !== "ENOENT") throw error;
  }
  await fs.rename(tmp, file);
  return file;
}

export function isLoopbackControlUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) &&
      !url.username &&
      !url.password &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

let livenessModulePromise;

function loadCoreLiveness() {
  if (!livenessModulePromise) {
    livenessModulePromise = (async () => {
      const candidates = [
        "@beauticode/core",
        new URL("./vendor/core/index.js", import.meta.url).href,
        new URL("../../packages/core/dist/index.js", import.meta.url).href,
      ];
      for (const specifier of candidates) {
        try {
          const mod = await import(specifier);
          if (typeof mod.isRecordedPidLive === "function") return mod;
        } catch {
          /* try the next resolution path */
        }
      }
      return null;
    })();
  }
  return livenessModulePromise;
}

async function isLiveRecordedPid(pid, startedAt, mtimeMs) {
  if (!isPidAlive(pid)) return false;
  const recorded =
    typeof startedAt === "string" && startedAt
      ? startedAt
      : Number.isFinite(mtimeMs)
        ? new Date(mtimeMs).toISOString()
        : null;
  try {
    const core = await loadCoreLiveness();
    if (core) return await core.isRecordedPidLive(pid, recorded);
  } catch {
    /* fall back to the cheap PID check */
  }
  return true;
}

export function stripPathQuotes(value) {
  const text = String(value ?? "").trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

export async function inspectLocalMedia(filePath) {
  const raw = stripPathQuotes(filePath);
  if (!raw) return { ok: false, error: "必须提供文件路径。" };
  if (!path.isAbsolute(raw)) {
    return { ok: false, error: "请使用本机绝对路径。" };
  }
  const resolved = path.resolve(raw);
  try {
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, error: "路径必须是普通文件，不能是目录或符号链接。" };
    }
  } catch {
    return { ok: false, error: `找不到文件：${resolved}。请使用本机绝对路径。` };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".mp4") return { ok: true, kind: "video", path: resolved };
  if (IMAGE_EXTENSIONS.has(ext)) return { ok: true, kind: "image", path: resolved };
  return {
    ok: false,
    error: "只支持图片（jpg / jpeg / png / webp / avif）或 MP4 视频。",
  };
}

export function matchSavedTheme(themes, query) {
  const needle = String(query ?? "").trim();
  if (!needle) return { ok: false, error: "必须提供主题名称或 ID。" };
  const list = Array.isArray(themes) ? themes : [];
  const byId = list.find((theme) => theme.id === needle);
  if (byId) return { ok: true, theme: byId };
  const exactName = list.filter((theme) => theme.name === needle);
  if (exactName.length === 1) return { ok: true, theme: exactName[0] };
  const lower = needle.toLowerCase();
  const ciName = list.filter((theme) => String(theme.name).toLowerCase() === lower);
  if (ciName.length === 1) return { ok: true, theme: ciName[0] };
  const prefixes = list.filter(
    (theme) =>
      String(theme.name).toLowerCase().startsWith(lower) ||
      String(theme.id).toLowerCase().startsWith(lower),
  );
  if (prefixes.length === 1) return { ok: true, theme: prefixes[0] };
  if (prefixes.length > 1) {
    return {
      ok: false,
      error: `有多个主题匹配「${needle}」：${prefixes.map((theme) => theme.name).join("、")}。`,
    };
  }
  if (list.length === 0) return { ok: false, error: "还没有已保存的主题。" };
  return {
    ok: false,
    error: `未找到主题「${needle}」。已保存：${list.map((theme) => theme.name).join("、")}。`,
  };
}

export function formatStatusText(status) {
  const background = status?.manifest?.background;
  let media = "无";
  if (background?.type === "video") media = "视频";
  else if (background?.type === "image") media = "图片";
  const pages = Number.isInteger(status?.sessions) ? status.sessions : 0;
  const fish = status?.fish ? "开" : "关";
  const sound = status?.muted === false ? "开" : "关";
  const tone = status?.tone || "dark";
  const ready = status?.hostReady ? "已连接" : "未就绪";
  return [
    `背景：${media}`,
    `页面：${ready}（${pages}）`,
    `摸鱼：${fish}`,
    `声音：${sound}`,
    `色调：${tone}`,
  ].join(" · ");
}

export async function writeDshControlFile(opts) {
  const dataRoot = path.resolve(opts.dataRoot);
  const url = opts.url;
  const token = opts.token;
  const pid = opts.pid ?? process.pid;
  if (!isLoopbackControlUrl(url)) {
    throw new Error("DSH control URL must be loopback HTTP.");
  }
  if (typeof token !== "string" || token.length < TOKEN_MIN_LENGTH) {
    throw new Error("DSH control token is too short.");
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("DSH control pid is invalid.");
  }
  return writeAtomicJson(dataRoot, CONTROL_FILE, {
    schema: CONTROL_SCHEMA,
    host: "dsh",
    pid,
    url: new URL(url).origin,
    token,
    startedAt: new Date().toISOString(),
  });
}

export async function writeSessionHostFile(opts) {
  const dataRoot = path.resolve(opts.dataRoot);
  const url = opts.url;
  const token = opts.token;
  const pid = opts.pid ?? process.pid;
  const host = opts.host === "codex" ? "codex" : "dsh";
  if (!isLoopbackControlUrl(url)) {
    throw new Error("session-host URL must be loopback HTTP.");
  }
  if (typeof token !== "string" || token.length < TOKEN_MIN_LENGTH) {
    throw new Error("session-host token is too short.");
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("session-host pid is invalid.");
  }
  return writeAtomicJson(dataRoot, SESSION_HOST_FILE, {
    schema: SESSION_HOST_SCHEMA,
    host,
    pid,
    url: new URL(url).origin,
    token,
    startedAt: new Date().toISOString(),
  });
}

export async function writeTrayClaim(opts) {
  const dataRoot = path.resolve(opts.dataRoot);
  const pid = opts.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("tray claim pid is invalid.");
  }
  return writeAtomicJson(dataRoot, TRAY_CLAIM_FILE, {
    schema: TRAY_CLAIM_SCHEMA,
    pid,
    startedAt: new Date().toISOString(),
  });
}

export async function removeDshControlFile(opts) {
  const dataRoot = path.resolve(opts.dataRoot);
  const pid = opts.pid ?? process.pid;
  const file = controlFilePath(dataRoot);
  try {
    const current = await readDshControlFile(dataRoot, { allowDead: true });
    if (!current || current.pid !== pid) return false;
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readDshControlFile(dataRoot, opts = {}) {
  const file = controlFilePath(dataRoot);
  let raw;
  let mtimeMs = 0;
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    raw = text;
    mtimeMs = stat.mtimeMs;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.schema !== CONTROL_SCHEMA ||
    parsed.host !== "dsh" ||
    typeof parsed.token !== "string" ||
    parsed.token.length < TOKEN_MIN_LENGTH ||
    !isLoopbackControlUrl(parsed.url) ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    return null;
  }
  if (
    !opts.allowDead &&
    !(await isLiveRecordedPid(parsed.pid, parsed.startedAt, mtimeMs))
  ) {
    return null;
  }
  return {
    schema: CONTROL_SCHEMA,
    host: "dsh",
    pid: parsed.pid,
    url: new URL(parsed.url).origin,
    token: parsed.token,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
  };
}

export async function removeSessionHostFile(opts) {
  const dataRoot = path.resolve(opts.dataRoot);
  const pid = opts.pid ?? process.pid;
  const file = sessionHostFilePath(dataRoot);
  try {
    const current = await readSessionHostFile(dataRoot, { allowDead: true });
    if (!current || current.pid !== pid) return false;
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readSessionHostFile(dataRoot, opts = {}) {
  const file = sessionHostFilePath(dataRoot);
  let raw;
  let mtimeMs = 0;
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    raw = text;
    mtimeMs = stat.mtimeMs;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.schema !== SESSION_HOST_SCHEMA ||
    (parsed.host !== "dsh" && parsed.host !== "codex") ||
    typeof parsed.token !== "string" ||
    parsed.token.length < TOKEN_MIN_LENGTH ||
    !isLoopbackControlUrl(parsed.url) ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    return null;
  }
  if (
    !opts.allowDead &&
    !(await isLiveRecordedPid(parsed.pid, parsed.startedAt, mtimeMs))
  ) {
    return null;
  }
  return {
    schema: SESSION_HOST_SCHEMA,
    host: parsed.host,
    pid: parsed.pid,
    url: new URL(parsed.url).origin,
    token: parsed.token,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
  };
}

export async function readTrayClaim(dataRoot, opts = {}) {
  const file = trayClaimFilePath(dataRoot);
  let raw;
  let mtimeMs = 0;
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    raw = text;
    mtimeMs = stat.mtimeMs;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.schema !== TRAY_CLAIM_SCHEMA ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    return null;
  }
  if (
    !opts.allowDead &&
    !(await isLiveRecordedPid(parsed.pid, parsed.startedAt, mtimeMs))
  ) {
    return null;
  }
  return {
    schema: TRAY_CLAIM_SCHEMA,
    pid: parsed.pid,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
  };
}

export async function removeTrayClaim(opts) {
  const dataRoot = path.resolve(opts.dataRoot);
  const pid = opts.pid ?? process.pid;
  const file = trayClaimFilePath(dataRoot);
  try {
    const current = await readTrayClaim(dataRoot, { allowDead: true });
    if (!current || current.pid !== pid) return false;
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function mergeSignals(userSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return timeout;
  return AbortSignal.any([userSignal, timeout]);
}

export async function callDshControl(dataRoot, spec) {
  const control = await readDshControlFile(dataRoot);
  if (!control) {
    const error = new Error(TRAY_MISSING_MESSAGE);
    error.code = "TRAY_MISSING";
    throw error;
  }
  const timeoutMs = spec.timeoutMs ?? 180_000;
  const signal = mergeSignals(spec.signal, timeoutMs);
  if (typeof spec.path !== "string" || !spec.path.startsWith("/") || spec.path.startsWith("//")) {
    throw new Error("DSH control path is invalid.");
  }
  const url = new URL(spec.path, `${control.url}/`);
  if (!isLoopbackControlUrl(control.url) || url.origin !== control.url) {
    throw new Error("DSH control URL must be loopback HTTP.");
  }
  let response;
  try {
    response = await fetch(url, {
      method: spec.method,
      headers: {
        authorization: `Bearer ${control.token}`,
        ...(spec.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      signal,
    });
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw new Error("导入已取消或超时。");
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接 beautiCode 托盘（${detail}）。`);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`托盘返回了无法解析的响应（HTTP ${response.status}）。`);
  }
  if (!response.ok || payload?.ok === false) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `托盘请求失败（HTTP ${response.status}）。`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.payload = payload;
    if (payload?.sourceMode != null) error.sourceMode = payload.sourceMode;
    if (payload?.timings != null) error.timings = payload.timings;
    throw error;
  }
  return payload;
}

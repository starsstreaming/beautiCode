import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createBeauticodeActions } from "./agent.mjs";
import { callDshControl } from "./control-client.mjs";
import { createGalleryHandlers, resolveConfiguredSkinCenterUrl } from "./gallery-host.mjs";
import { hasLiveTray, resolveApplyBackend, stopInProcessSession } from "./host-apply.mjs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;
const SELECTION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_SELECTIONS = 16;
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;
const NATIVE_PICKER_UNAVAILABLE = "native_picker_unavailable";
const NATIVE_PICKER_REQUIRED = "native_picker_required";
const PICKER_REQUEST_ABORTED = "picker_request_aborted";
const IMPORT_TIMING_LOG = "import-timing.jsonl";

function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

async function appendImportTiming(dataRoot, entry) {
  try {
    const logsDir = path.join(dataRoot, "logs");
    await fsp.mkdir(logsDir, { recursive: true });
    await fsp.appendFile(
      path.join(logsDir, IMPORT_TIMING_LOG),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    /* Diagnostics must never alter import success/failure semantics. */
  }
}

export function parseImportFilename(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "缺少文件名。" };
  }
  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep raw */
  }
  const name = path.basename(decoded.replaceAll("\\", "/"));
  if (!name || name === "." || name === "..") {
    return { ok: false, error: "文件名无效。" };
  }
  const ext = path.extname(name).toLowerCase();
  if (ext === ".mp4") {
    return { ok: true, name, ext, kind: "video", maxBytes: MAX_VIDEO_BYTES };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { ok: true, name, ext, kind: "image", maxBytes: MAX_IMAGE_BYTES };
  }
  return { ok: false, error: "只支持图片（jpg / jpeg / png / webp / avif）或 MP4 视频。" };
}

export function parseImportThemeName(raw) {
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "请先给该主题取名。" };
  }
  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return { ok: false, error: "主题名编码无效。" };
  }
  const name = decoded.trim();
  if (!name) return { ok: false, error: "主题名不能为空。" };
  if (name.length > 80) {
    return { ok: false, error: "主题名不能超过 80 个字符。" };
  }
  if (/[<>:"/\\|?*]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    return { ok: false, error: "主题名包含非法字符。" };
  }
  return { ok: true, name };
}

function pickerUnavailable(message) {
  const error = new Error(message);
  error.code = NATIVE_PICKER_UNAVAILABLE;
  return error;
}

function isPickerDependencyError(message) {
  return /powershell|system\.windows\.forms|assembly|无法加载|找不到|not recognized/i.test(
    String(message || ""),
  );
}

function suggestedThemeName(fileName, fallback) {
  const ext = path.extname(fileName);
  const stem = (ext ? fileName.slice(0, -ext.length) : fileName)
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return stem || fallback;
}

export function buildWindowsPickerScript(
  kind,
  { parentPid = process.pid, timeoutMs = PICKER_TIMEOUT_MS } = {},
) {
  const filter =
    kind === "video"
      ? "MP4 Video (*.mp4)|*.mp4"
      : "Image Files (*.jpg;*.jpeg;*.png;*.webp;*.avif)|*.jpg;*.jpeg;*.png;*.webp;*.avif";
  const safeParentPid = Number.isSafeInteger(parentPid) && parentPid > 0
    ? parentPid
    : process.pid;
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.ceil(timeoutMs)
    : PICKER_TIMEOUT_MS;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::OutputEncoding = $OutputEncoding",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.Text = 'beautiCode 文件选择器'",
    "$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow",
    "$owner.ShowInTaskbar = $false",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$owner.Size = [System.Drawing.Size]::new(1, 1)",
    "$owner.Opacity = 0.01",
    "$owner.TopMost = $true",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    `$dialog.Filter = '${filter}'`,
    "$dialog.Multiselect = $false",
    "$dialog.CheckFileExists = $true",
    "$dialog.RestoreDirectory = $true",
    "$dialog.Title = '选择 beautiCode 背景文件'",
    `$dshPid = ${safeParentPid}`,
    `$deadlineUtc = [DateTime]::UtcNow.AddMilliseconds(${safeTimeoutMs})`,
    "$watchdog = New-Object System.Windows.Forms.Timer",
    "$watchdog.Interval = 500",
    "$watchdog.Add_Tick({ if ([DateTime]::UtcNow -ge $deadlineUtc -or -not (Get-Process -Id $dshPid -ErrorAction SilentlyContinue)) { $watchdog.Stop(); [Environment]::Exit(0) } })",
    "try { [void]$owner.Show(); [void]$owner.Hide(); [void]$owner.Show(); [void]$owner.Activate(); [void]$owner.BringToFront(); [System.Windows.Forms.Application]::DoEvents(); if (-not $owner.IsHandleCreated) { throw 'Picker owner window was not created.' }; $watchdog.Start(); $result = $dialog.ShowDialog($owner); if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.FileName) } } finally { $watchdog.Stop(); $watchdog.Dispose(); $dialog.Dispose(); $owner.Close(); $owner.Dispose() }",
  ].join("; ");
}

export function createWindowsMediaPicker({
  platform = process.platform,
  spawnProcess = spawn,
  parentProcess = process,
  parentPid = process.pid,
  timeoutMs = PICKER_TIMEOUT_MS,
} = {}) {
  return function pickWindowsMedia(kind, { signal } = {}) {
    if (platform !== "win32") {
      throw pickerUnavailable("当前系统不支持 Windows 原生文件选择器。");
    }
    const script = buildWindowsPickerScript(kind, { parentPid, timeoutMs });
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    return new Promise((resolve, reject) => {
      const child = spawnProcess(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-STA",
          "-EncodedCommand",
          encodedScript,
        ],
        {
          // Hide PowerShell's console while leaving the owned WinForms dialog visible.
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        parentProcess.removeListener("exit", onParentExit);
      };
      const settle = (callback, value, { terminate = false } = {}) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminate && !child.killed) child.kill("SIGKILL");
        callback(value);
      };
      const onAbort = () => {
        const error = new Error("文件选择请求已取消。");
        error.code = PICKER_REQUEST_ABORTED;
        settle(reject, error, { terminate: true });
      };
      const timer = setTimeout(() => {
        settle(reject, new Error("文件选择器超时。"), { terminate: true });
      }, timeoutMs);
      const onParentExit = () => {
        if (!child.killed) child.kill("SIGKILL");
      };
      parentProcess.once("exit", onParentExit);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => {
        settle(
          reject,
          error?.code === "ENOENT"
            ? pickerUnavailable("找不到 Windows PowerShell，无法打开原生文件选择器。")
            : error,
        );
      });
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          const message = stderr.trim() || `文件选择器退出异常（${code}）。`;
          settle(
            reject,
            isPickerDependencyError(message) ? pickerUnavailable(message) : new Error(message),
          );
          return;
        }
        const selected = stdout.trim();
        if (!selected) {
          settle(resolve, { ok: true, cancelled: true });
          return;
        }
        const name = path.basename(selected.replaceAll("\\", "/"));
        const parsed = parseImportFilename(name);
        if (!parsed.ok || parsed.kind !== kind) {
          settle(reject, new Error(parsed.ok ? "选择的文件类型不匹配。" : parsed.error));
          return;
        }
        settle(resolve, { ok: true, kind, path: path.resolve(selected), name });
      });
    });
  };
}

const pickWindowsMedia = createWindowsMediaPicker();

function limitBytes(maxBytes) {
  let size = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("文件过大。");
        error.statusCode = 413;
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}

function publicThemes(list) {
  return (Array.isArray(list) ? list : []).map((theme) => ({
    id: theme.id,
    name: theme.name,
    type: theme.type ?? null,
    ...(theme.bundled ? { bundled: true } : {}),
    sourceMode: theme.sourceMode === "local" ? "local" : "managed",
  }));
}

async function canReachBridge(baseUrl) {
  const origin = typeof baseUrl === "string" && baseUrl ? baseUrl : "http://127.0.0.1:3080";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(new URL("__beauticode/version", origin.endsWith("/") ? origin : `${origin}/`), {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createBeauticodeUi({
  dataRoot,
  baseUrl,
  getBaseUrl,
  sendJson,
  isSameOrigin,
  readJson,
  pickMedia: injectedPicker,
  allowManagedUpload: injectedAllowManagedUpload,
  now: injectedNow,
  selectionTtlMs = SELECTION_TTL_MS,
}) {
  const options = {
    dataRoot,
    get baseUrl() {
      if (typeof getBaseUrl === "function") return getBaseUrl();
      return baseUrl;
    },
  };
  const actions = createBeauticodeActions(options);
  const gallery = createGalleryHandlers({ dataRoot, actions });
  const nativePicker = injectedPicker ?? pickWindowsMedia;
  const allowManagedUpload =
    typeof injectedAllowManagedUpload === "boolean"
      ? injectedAllowManagedUpload
      : process.platform !== "win32";
  const now = typeof injectedNow === "function" ? injectedNow : Date.now;
  const pendingSelections = new Map();
  let restoreStarted = false;
  let pickerBusy = false;
  let activePickerAbort = null;
  let activePickerResponse = null;
  let disposed = false;

  function pruneSelections() {
    const timestamp = now();
    for (const [id, selection] of pendingSelections) {
      if (selection.expiresAt <= timestamp) pendingSelections.delete(id);
    }
    while (pendingSelections.size >= MAX_PENDING_SELECTIONS) {
      const oldest = pendingSelections.keys().next().value;
      if (!oldest) break;
      pendingSelections.delete(oldest);
    }
  }

  function rememberSelection(picked, pickerMs) {
    pruneSelections();
    const selectionId = crypto.randomUUID();
    pendingSelections.set(selectionId, {
      kind: picked.kind,
      path: picked.path,
      name: picked.name,
      pickerMs,
      expiresAt: now() + selectionTtlMs,
    });
    return {
      ok: true,
      cancelled: false,
      selectionId,
      name: picked.name,
      suggestedThemeName: suggestedThemeName(
        picked.name,
        picked.kind === "video" ? "视频" : "图片",
      ),
    };
  }

  async function restoreOnce() {
    if (await hasLiveTray(dataRoot)) {
      return callDshControl(dataRoot, {
        method: "POST",
        path: "/reapply",
        body: {},
        timeoutMs: 30_000,
      });
    }
    if (!(await canReachBridge(options.baseUrl))) return;
    const resolved = await resolveApplyBackend(options);
    if (resolved.kind === "tray") {
      return callDshControl(dataRoot, {
        method: "POST",
        path: "/reapply",
        body: {},
        timeoutMs: 30_000,
      });
    }
    return resolved.session.reapply();
  }

  return {
    dispose() {
      disposed = true;
      activePickerAbort?.abort();
      activePickerResponse?.destroy();
      activePickerAbort = null;
      activePickerResponse = null;
      pickerBusy = false;
      pendingSelections.clear();
      return stopInProcessSession(dataRoot);
    },
    scheduleRestore() {
      if (restoreStarted) return;
      restoreStarted = true;
      queueMicrotask(() => {
        void restoreOnce().catch(() => {
          restoreStarted = false;
        });
      });
    },

    async status(req, res) {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const status = await actions.status();
        const listed = await actions.listThemes();
        const background = status.background ?? null;
        const center = await resolveConfiguredSkinCenterUrl();
        sendJson(res, 200, {
          ok: true,
          media: background?.type ?? null,
          muted: status.muted !== false,
          atmosphere: background?.effects?.preset ?? null,
          themeId: status.themeId || null,
          sourceMode: status.sourceMode ?? "clear",
          themes: publicThemes(listed.themes),
          message: status.message,
          importPolicy: {
            nativeLocalRequired: !allowManagedUpload,
            managedUploadAllowed: allowManagedUpload,
          },
          skinCenter: { url: center, enabled: Boolean(center) },
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async importFile(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      if (!allowManagedUpload) {
        req.resume();
        sendJson(res, 409, {
          ok: false,
          code: "local_import_required",
          error: "Windows 本地导入必须使用原生文件选择器；不会自动上传或复制媒体文件。",
        });
        return;
      }
      const importStartedAt = performance.now();
      const parsed = parseImportFilename(req.headers["x-beauticode-filename"]);
      if (!parsed.ok) {
        req.resume();
        sendJson(res, 400, { ok: false, error: parsed.error });
        return;
      }
      const parsedTheme = parseImportThemeName(
        req.headers["x-beauticode-theme-name"],
      );
      if (!parsedTheme.ok) {
        req.resume();
        sendJson(res, 400, { ok: false, error: parsedTheme.error });
        return;
      }
      const length = Number(req.headers["content-length"]);
      if (Number.isFinite(length) && length > parsed.maxBytes) {
        req.resume();
        sendJson(res, 413, { ok: false, error: "文件过大。" });
        return;
      }
      const tmpDir = path.join(dataRoot, "tmp");
      await fsp.mkdir(tmpDir, { recursive: true });
      const tmpPath = path.join(
        tmpDir,
        `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${parsed.ext}`,
      );
      try {
        await pipeline(req, limitBytes(parsed.maxBytes), fs.createWriteStream(tmpPath));
        const themeName = parsedTheme.name;
        const result =
          parsed.kind === "video"
            ? await actions.applyVideo({ path: tmpPath, themeName, source: "managed" })
            : await actions.applyImage(tmpPath, undefined, { themeName, source: "managed" });
        await appendImportTiming(dataRoot, {
          route: "managed-upload",
          kind: parsed.kind,
          ok: true,
          sourceMode: result.sourceMode ?? "managed",
          uploadAndApplyMs: elapsedMs(importStartedAt),
          core: result.timings ?? null,
        });
        sendJson(res, 200, result);
      } catch (error) {
        await appendImportTiming(dataRoot, {
          route: "managed-upload",
          kind: parsed.kind,
          ok: false,
          sourceMode: error?.sourceMode ?? "managed",
          uploadAndApplyMs: elapsedMs(importStartedAt),
          core: error?.timings ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        const status = error?.statusCode === 413 ? 413 : 422;
        sendJson(res, status, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
      }
    },

    async pickMedia(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readJson(req);
      if (body.kind !== "image" && body.kind !== "video") {
        sendJson(res, 400, { ok: false, error: "kind 必须是 image 或 video。" });
        return;
      }
      if (pickerBusy) {
        sendJson(res, 409, { ok: false, error: "文件选择器已经打开。" });
        return;
      }
      if (disposed) {
        sendJson(res, 503, { ok: false, error: "beautiCode UI 已停止。" });
        return;
      }
      pickerBusy = true;
      const pickerStartedAt = performance.now();
      const pickerAbort = new AbortController();
      activePickerAbort = pickerAbort;
      activePickerResponse = res;
      const onResponseClose = () => {
        if (!res.writableEnded) pickerAbort.abort();
      };
      res.once("close", onResponseClose);
      try {
        const picked = await nativePicker(body.kind, { signal: pickerAbort.signal });
        if (pickerAbort.signal.aborted) return;
        sendJson(
          res,
          200,
          picked?.cancelled
            ? { ok: true, cancelled: true, pickerMs: elapsedMs(pickerStartedAt) }
            : rememberSelection(picked, elapsedMs(pickerStartedAt)),
        );
      } catch (error) {
        if (pickerAbort.signal.aborted || error?.code === PICKER_REQUEST_ABORTED) return;
        const unavailable = error?.code === NATIVE_PICKER_UNAVAILABLE;
        const code = unavailable
          ? allowManagedUpload
            ? NATIVE_PICKER_UNAVAILABLE
            : NATIVE_PICKER_REQUIRED
          : undefined;
        sendJson(res, unavailable ? 501 : 422, {
          ok: false,
          ...(code ? { code } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        res.off("close", onResponseClose);
        if (activePickerAbort === pickerAbort) activePickerAbort = null;
        if (activePickerResponse === res) activePickerResponse = null;
        pickerBusy = false;
      }
    },

    async importSelected(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readJson(req);
      const parsedTheme = parseImportThemeName(body.themeName);
      const selectionId =
        typeof body.selectionId === "string" ? body.selectionId.trim() : "";
      if (!selectionId || !parsedTheme.ok) {
        sendJson(res, 400, {
          ok: false,
          error: !parsedTheme.ok ? parsedTheme.error : "选择令牌无效。",
        });
        return;
      }
      pruneSelections();
      const selected = pendingSelections.get(selectionId);
      if (!selected) {
        sendJson(res, 410, { ok: false, error: "文件选择已失效，请重新选择。" });
        return;
      }
      pendingSelections.delete(selectionId);
      const importStartedAt = performance.now();
      try {
        const result =
          selected.kind === "video"
            ? await actions.applyVideo({
                path: selected.path,
                themeName: parsedTheme.name,
                source: "local",
              })
              : await actions.applyImage(selected.path, undefined, {
                  themeName: parsedTheme.name,
                  source: "local",
                });
        if (result.sourceMode !== "local") {
          throw new Error("本地导入合同失败：后端没有保留 local 来源，操作已拒绝。");
        }
        const importTimings = {
          pickerMs: selected.pickerMs ?? null,
          applyAndSaveMs: elapsedMs(importStartedAt),
          core: result.timings ?? null,
        };
        await appendImportTiming(dataRoot, {
          route: "native-local",
          kind: selected.kind,
          ok: true,
          sourceMode: "local",
          ...importTimings,
        });
        result.importTimings = importTimings;
        sendJson(res, 200, result);
      } catch (error) {
        await appendImportTiming(dataRoot, {
          route: "native-local",
          kind: selected.kind,
          ok: false,
          sourceMode: error?.sourceMode ?? "local",
          pickerMs: selected.pickerMs ?? null,
          applyAndSaveMs: elapsedMs(importStartedAt),
          core: error?.timings ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        sendJson(res, 422, {
          ok: false,
          sourceMode: error?.sourceMode ?? "local",
          timings: error?.timings ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async clear(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      try {
        sendJson(res, 200, await actions.clear());
      } catch (error) {
        sendJson(res, 422, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async mode(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readJson(req);
      if (typeof body.muted !== "boolean" || Object.keys(body).some((key) => key !== "muted")) {
        sendJson(res, 400, { ok: false, error: "只接受 muted 开关。" });
        return;
      }
      try {
        sendJson(res, 200, await actions.setMuted(body.muted));
      } catch (error) {
        sendJson(res, 422, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async useTheme(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readJson(req);
      if (typeof body.id !== "string" || !body.id.trim()) {
        sendJson(res, 400, { ok: false, error: "必须提供主题。" });
        return;
      }
      try {
        sendJson(res, 200, await actions.useTheme(body.id.trim()));
      } catch (error) {
        sendJson(res, 422, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async deleteTheme(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readJson(req);
      if (typeof body.id !== "string" || !body.id.trim()) {
        sendJson(res, 400, { ok: false, error: "必须提供主题。" });
        return;
      }
      try {
        sendJson(res, 200, await actions.deleteTheme(body.id.trim()));
      } catch (error) {
        sendJson(res, 422, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async galleryConfig(req, res) {
      return gallery.config(req, res, sendJson, isSameOrigin);
    },

    async galleryCatalog(req, res) {
      return gallery.catalog(req, res, sendJson, isSameOrigin);
    },

    async galleryInstall(req, res) {
      return gallery.install(req, res, sendJson, isSameOrigin, readJson);
    },

    async applyPreset(req, res) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!isSameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readJson(req);
      if (body.id !== "internal" && body.id !== "infernal") {
        sendJson(res, 400, { ok: false, error: "未知的内置主题。" });
        return;
      }
      try {
        sendJson(res, 200, await actions.applyPreset(body.id));
      } catch (error) {
        sendJson(res, 422, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

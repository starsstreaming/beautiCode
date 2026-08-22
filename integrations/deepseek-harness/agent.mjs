import path from "node:path";
import {
  callDshControl,
  formatStatusText,
  inspectLocalMedia,
  matchSavedTheme,
  stripPathQuotes,
} from "./control-client.mjs";
import { loadAdapter, resolveApplyBackend, stopInProcessSession } from "./host-apply.mjs";
import { ATMOSPHERE_PRESETS, effectsForPreset, presetImagePath } from "./presets.mjs";

const APPLY_TIMEOUT_MS = 180_000;
const QUICK_TIMEOUT_MS = 15_000;

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["ok", "message"],
};

const BG_USAGE =
  "用法：/bg <本机图片或 MP4 绝对路径>。切换主题用 /bg-theme <名称>，清除用 /bg-clear。";

function asText(message) {
  return [{ type: "text", text: String(message) }];
}

function fail(error) {
  throw error instanceof Error ? error : new Error(String(error));
}

export function themeNameFromFilePath(filePath, fallback = "主题") {
  const base = path.basename(String(filePath ?? "").replaceAll("\\", "/"));
  const ext = path.extname(base);
  let name = (ext ? base.slice(0, -ext.length) : base).trim();
  name = name
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) name = fallback;
  if (name.length > 80) name = name.slice(0, 80).trim();
  if (!name) name = fallback;
  return name;
}

async function chineseError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  try {
    const adapter = await loadAdapter();
    if (typeof adapter.toChineseErrorMessage === "function") {
      return adapter.toChineseErrorMessage(error);
    }
  } catch {
    /* keep raw */
  }
  return raw || "操作失败。";
}

async function unwrapApplyResult(result, fallbackMode, message) {
  if (!result || result.ok === false) {
    const failure = new Error(await chineseError(result?.error || "操作失败。"));
    if (result?.sourceMode != null) failure.sourceMode = result.sourceMode;
    if (result?.timings != null) failure.timings = result.timings;
    throw failure;
  }
  return {
    ok: true,
    generation: result.generation ?? null,
    mode: result.mode ?? fallbackMode,
    sourceMode: result.sourceMode ?? null,
    timings: result.timings ?? null,
    message,
    ...(result.theme
      ? {
          theme: {
            id: result.theme.id,
            name: result.theme.name,
            type: result.theme.type ?? null,
          },
        }
      : {}),
  };
}

function commandResultFromError(error) {
  return {
    kind: "error",
    text: error instanceof Error ? error.message : String(error),
  };
}

function normalizeActionOptions(dataRootOrOptions) {
  if (typeof dataRootOrOptions === "string") {
    return { dataRoot: dataRootOrOptions };
  }
  return dataRootOrOptions && typeof dataRootOrOptions === "object"
    ? dataRootOrOptions
    : {};
}

function unwrapApply(result, fallbackMode, message) {
  if (!result || result.ok === false) {
    fail(result?.error || "操作失败。");
  }
  return {
    ok: true,
    generation: result.generation ?? null,
    mode: result.mode ?? fallbackMode,
    message,
    ...(result.theme
      ? {
          theme: {
            id: result.theme.id,
            name: result.theme.name,
            type: result.theme.type ?? null,
          },
        }
      : {}),
  };
}

function presentStatus(status) {
  const background = status.manifest?.background ?? status.background ?? null;
  return {
    ok: true,
    hostReady: status.hostReady === true || status.sessions > 0,
    sessions: status.sessions ?? 0,
    fish: status.fish === true,
    muted: status.muted !== false,
    tone: status.tone ?? "dark",
    background,
    sourceMode: background
      ? background.source?.kind === "local"
        ? "local"
        : "managed"
      : "clear",
    themeId: typeof status.themeId === "string" && status.themeId ? status.themeId : null,
    message: formatStatusText(status),
  };
}

function presentThemes(themes) {
  const list = Array.isArray(themes) ? themes : [];
  return {
    ok: true,
    themes: list,
    message:
      list.length === 0
        ? "还没有已保存的主题。"
        : `已保存主题：${list.map((theme) => theme.name).join("、")}。`,
  };
}

export function createBeauticodeActions(dataRootOrOptions) {
  const options = normalizeActionOptions(dataRootOrOptions);
  const dataRoot = options.dataRoot;
  const request = (spec) =>
    callDshControl(dataRoot, {
      timeoutMs: spec.timeoutMs ?? APPLY_TIMEOUT_MS,
      ...spec,
    });

  async function backend() {
    return resolveApplyBackend(options);
  }

  return {
    async applyImage(imagePath, signal, options) {
      const inspected = await inspectLocalMedia(imagePath);
      if (!inspected.ok) fail(inspected.error);
      if (inspected.kind !== "image") {
        fail("beauticode_apply_image 只接受图片文件。");
      }
      const effects = effectsForPreset(options?.effects?.preset) || options?.effects || null;
      const persistTheme = options?.persistTheme !== false;
      const themeName =
        String(options?.themeName ?? "").trim() ||
        themeNameFromFilePath(inspected.path, "图片");
      const source = options?.source === "managed" ? "managed" : "local";
      const input = { type: "image", imagePath: inspected.path, source };
      if (effects) input.effects = effects;
      const resolved = await backend();
      if (resolved.kind === "tray") {
        const result = await request({
          method: "POST",
          path: persistTheme ? "/theme/apply" : "/apply/image",
          body: persistTheme
            ? { name: themeName, input }
            : {
                imagePath: inspected.path,
                source,
                ...(effects ? { effects } : {}),
              },
          signal,
        });
        return unwrapApplyResult(
          result,
          "image",
          persistTheme
            ? `已将「${result.theme?.name || themeName}」设为背景。`
            : "已将图片设为背景。",
        );
      }
      const applied = persistTheme
        ? await resolved.session.applyAndSaveTheme(input, themeName)
        : await resolved.session.apply(input);
      return unwrapApplyResult(
        applied,
        "image",
        persistTheme
          ? `已将「${applied.theme?.name || themeName}」设为背景。`
          : "已将图片设为背景。",
      );
    },

    async applyPreset(id, signal) {
      const preset = ATMOSPHERE_PRESETS[id];
      const imagePath = presetImagePath(id);
      if (!preset || !imagePath) fail("未找到内置主题文件。");
      const result = await this.applyImage(imagePath, signal, {
        effects: effectsForPreset(id),
        persistTheme: false,
      });
      try {
        await this.setTone(preset.tone, signal);
      } catch {
        /* tone is best-effort; the wallpaper still applied */
      }
      return {
        ...result,
        atmosphere: id,
        message: `已应用 ${preset.name} 活壁纸。`,
      };
    },

    async setTone(tone, signal) {
      const resolved = await backend();
      const result =
        resolved.kind === "tray"
          ? await request({
              method: "POST",
              path: "/mode/tone",
              body: { tone },
              signal,
              timeoutMs: QUICK_TIMEOUT_MS,
            })
          : await resolved.session.setBackgroundTone(tone);
      if (result.ok === false) fail(result.error || "无法切换背景色调。");
      return { ok: true, tone: result.tone ?? tone };
    },

    async applyVideo(input, signal) {
      const inspected = await inspectLocalMedia(input.path);
      if (!inspected.ok) fail(inspected.error);
      if (inspected.kind !== "video") {
        fail("beauticode_apply_video 只接受 .mp4 文件。");
      }
      const persistTheme = input?.persistTheme !== false;
      const themeName =
        String(input?.themeName ?? "").trim() ||
        themeNameFromFilePath(inspected.path, "视频");
      const source = input?.source === "managed" ? "managed" : "local";
      const body = { videoPath: inspected.path, persistTheme, themeName, source };
      const localInput = { type: "video", videoPath: inspected.path, source };
      if (typeof input.poster === "string" && input.poster.trim()) {
        const poster = await inspectLocalMedia(input.poster);
        if (!poster.ok) fail(poster.error);
        if (poster.kind !== "image") fail("poster 必须是图片文件。");
        body.imagePath = poster.path;
        localInput.imagePath = poster.path;
      }
      if (input.startAt != null && input.startAt !== "") {
        const startAt = Number(input.startAt);
        if (!Number.isFinite(startAt) || startAt < 0) {
          fail("startAt 必须是非负数字（秒）。");
        }
        body.startAt = startAt;
        localInput.startAt = startAt;
      }
      const resolved = await backend();
      if (resolved.kind === "tray") {
        const result = await request({
          method: "POST",
          path: persistTheme ? "/theme/apply" : "/apply/video",
          body: persistTheme ? { name: themeName, input: localInput } : body,
          signal,
        });
        return unwrapApplyResult(
          result,
          "video",
          persistTheme
            ? `已将「${result.theme?.name || themeName}」设为背景。`
            : "已将视频设为背景。",
        );
      }
      const applied = persistTheme
        ? await resolved.session.applyAndSaveTheme(localInput, themeName)
        : await resolved.session.apply(localInput);
      return unwrapApplyResult(
        applied,
        "video",
        persistTheme
          ? `已将「${applied.theme?.name || themeName}」设为背景。`
          : "已将视频设为背景。",
      );
    },

    async clear(signal) {
      const resolved = await backend();
      if (resolved.kind === "tray") {
        return unwrapApply(
          await request({
            method: "POST",
            path: "/apply/clear",
            body: {},
            signal,
          }),
          "clear",
          "已清除背景。",
        );
      }
      return unwrapApply(await resolved.session.apply({ type: "clear" }), "clear", "已清除背景。");
    },

    async status(signal) {
      const resolved = await backend();
      if (resolved.kind === "tray") {
        return presentStatus(
          await request({
            method: "GET",
            path: "/status",
            signal,
            timeoutMs: QUICK_TIMEOUT_MS,
          }),
        );
      }
      const status = await resolved.session.status();
      return presentStatus({
        ...status,
        hostReady: resolved.session.isHostReady,
      });
    },

    async importTheme(input, signal) {
      const name = String(input?.name ?? "").trim();
      const imagePath = String(input?.imagePath ?? "").trim();
      if (!name || !imagePath) fail("导入皮肤必须提供名称和图片。");
      const body = {
        name,
        imagePath,
      };
      if (typeof input.videoPath === "string" && input.videoPath.trim()) {
        body.videoPath = input.videoPath.trim();
      }
      if (input.effects) body.effects = input.effects;
      if (input.source) body.source = input.source;
      const resolved = await backend();
      if (resolved.kind === "tray") {
        const result = await request({
          method: "POST",
          path: "/theme/import",
          body,
          signal,
          timeoutMs: 30 * 60 * 1000,
        });
        if (!result || result.ok === false) fail(result?.error || "导入皮肤失败。");
        return {
          ok: true,
          theme: result.theme,
          message: `已保存皮肤「${result.theme.name}」。`,
        };
      }
      const theme = await resolved.session.importSavedTheme(body);
      return { ok: true, theme, message: `已保存皮肤「${theme.name}」。` };
    },

    async listThemes(signal) {
      const resolved = await backend();
      if (resolved.kind === "tray") {
        const result = await request({
          method: "GET",
          path: "/theme/list",
          signal,
          timeoutMs: QUICK_TIMEOUT_MS,
        });
        return presentThemes(result.themes);
      }
      return presentThemes(await resolved.session.listSavedThemes());
    },

    async useTheme(query, signal) {
      const listed = await this.listThemes(signal);
      const matched = matchSavedTheme(listed.themes, query);
      if (!matched.ok) fail(matched.error);
      const resolved = await backend();
      const result =
        resolved.kind === "tray"
          ? await request({
              method: "POST",
              path: "/theme/use",
              body: { id: matched.theme.id },
              signal,
            })
          : await resolved.session.useSavedTheme(matched.theme.id);
      return {
        ...unwrapApply(
          result,
          matched.theme.type ?? null,
          `已切换到主题「${matched.theme.name}」。`,
        ),
        theme: matched.theme,
      };
    },

    async deleteTheme(id, signal) {
      const themeId = String(id ?? "").trim();
      if (!themeId) fail("必须提供主题。");
      const resolved = await backend();
      if (resolved.kind === "tray") {
        const result = await request({
          method: "POST",
          path: "/theme/delete",
          body: { id: themeId },
          signal,
          timeoutMs: QUICK_TIMEOUT_MS,
        });
        if (!result || result.ok === false) {
          fail(await chineseError(result?.error || "删除主题失败。"));
        }
        return { ok: true, deleted: true, message: "已删除主题。" };
      }
      try {
        const deleted = await resolved.session.deleteSavedTheme(themeId);
        if (!deleted) fail("未找到已保存的主题。");
        return { ok: true, deleted: true, message: "已删除主题。" };
      } catch (error) {
        fail(await chineseError(error));
      }
    },

    async setFish(enabled, signal) {
      const resolved = await backend();
      const want = Boolean(enabled);
      const result =
        resolved.kind === "tray"
          ? await request({
              method: "POST",
              path: "/mode/fish",
              body: { enabled: want },
              signal,
              timeoutMs: QUICK_TIMEOUT_MS,
            })
          : await resolved.session.setFishMode(want);
      if (result.ok === false) fail(result.error || "无法切换摸鱼模式。");
      return {
        ok: true,
        fish: result.fish === true,
        message: result.fish ? "已进入摸鱼模式。" : "已退出摸鱼模式。",
      };
    },

    async setMuted(muted, signal) {
      const resolved = await backend();
      const want = Boolean(muted);
      const result =
        resolved.kind === "tray"
          ? await request({
              method: "POST",
              path: "/mode/muted",
              body: { muted: want },
              signal,
              timeoutMs: QUICK_TIMEOUT_MS,
            })
          : await resolved.session.setMuted(want);
      if (result.ok === false) fail(result.error || "无法切换背景声音。");
      const blocked = result.blocked === true;
      return {
        ok: true,
        muted: result.muted !== false,
        blocked,
        message: blocked
          ? "浏览器阻止了开启声音，视频将继续静音播放。"
          : result.muted
            ? "背景视频已静音。"
            : "背景视频声音已打开。",
      };
    },
  };
}

export async function runBgCommand(dataRootOrOptions, rawInput, signal) {
  const actions = createBeauticodeActions(dataRootOrOptions);
  const value = stripPathQuotes(rawInput);
  if (!value) {
    try {
      const status = await actions.status(signal);
      return `${status.message}\n${BG_USAGE}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${message}\n${BG_USAGE}`;
    }
  }
  const inspected = await inspectLocalMedia(value);
  if (!inspected.ok) fail(inspected.error);
  if (inspected.kind === "video") {
    const result = await actions.applyVideo({ path: inspected.path }, signal);
    return result.message;
  }
  const result = await actions.applyImage(inspected.path, signal);
  return result.message;
}

function registerOne(register, definition) {
  try {
    register(definition);
  } catch {
    /* One bad schema or duplicate name must not drop the rest. */
  }
}

function registerBeauticodeTools(ctx, options) {
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== "function") return;
  const actions = createBeauticodeActions(options);

  registerOne(tools.register.bind(tools), {
    name: "beauticode_apply_video",
    description:
      "把本机 MP4 设为 DeepSeek Harness 网页背景。path 必须是绝对路径。不需要 beautiCode 托盘。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "本机 MP4 的绝对路径。" },
        poster: { type: "string", description: "可选海报图片的绝对路径。" },
        startAt: { type: "number", description: "可选起始播放位置（秒）。" },
      },
      required: ["path"],
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: APPLY_TIMEOUT_MS,
    async execute(args, exec) {
      return actions.applyVideo(
        {
          path: args?.path,
          poster: args?.poster,
          startAt: args?.startAt,
        },
        exec?.signal,
      );
    },
  });

  registerOne(tools.register.bind(tools), {
    name: "beauticode_apply_image",
    description:
      "把本机图片设为 DeepSeek Harness 网页背景。path 必须是绝对路径。不需要 beautiCode 托盘。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "本机图片的绝对路径（jpg / jpeg / png / webp / avif）。" },
      },
      required: ["path"],
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: APPLY_TIMEOUT_MS,
    async execute(args, exec) {
      return actions.applyImage(args?.path, exec?.signal);
    },
  });

  registerOne(tools.register.bind(tools), {
    name: "beauticode_theme_list",
    description: "列出 beautiCode 已保存的背景主题。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: QUICK_TIMEOUT_MS,
    async execute(_args, exec) {
      return actions.listThemes(exec?.signal);
    },
  });

  registerOne(tools.register.bind(tools), {
    name: "beauticode_theme_use",
    description: "按名称或 ID 切换已保存的 beautiCode 背景主题。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "主题名称或 ID。" },
      },
      required: ["name"],
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: APPLY_TIMEOUT_MS,
    async execute(args, exec) {
      return actions.useTheme(args?.name, exec?.signal);
    },
  });

  registerOne(tools.register.bind(tools), {
    name: "beauticode_clear",
    description: "清除 DeepSeek Harness 上的 beautiCode 背景。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: APPLY_TIMEOUT_MS,
    async execute(_args, exec) {
      return actions.clear(exec?.signal);
    },
  });

  registerOne(tools.register.bind(tools), {
    name: "beauticode_status",
    description: "查看当前 beautiCode 背景、摸鱼和声音状态。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: QUICK_TIMEOUT_MS,
    async execute(_args, exec) {
      return actions.status(exec?.signal);
    },
  });

  registerOne(tools.register.bind(tools), {
    name: "beauticode_set_fish",
    description: "打开或关闭摸鱼模式（隐藏 DSH 界面，只留背景）。需要已经有背景。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", description: "true 进入摸鱼，false 退出。" },
      },
      required: ["enabled"],
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: QUICK_TIMEOUT_MS,
    async execute(args, exec) {
      if (typeof args?.enabled !== "boolean") fail("enabled 必须是布尔值。");
      return actions.setFish(args.enabled, exec?.signal);
    },
  });

  registerOne(tools.register.bind(tools), {
    name: "beauticode_set_muted",
    description: "打开或关闭背景视频声音。默认静音。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        muted: { type: "boolean", description: "true 静音，false 尝试开声音。" },
      },
      required: ["muted"],
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => asText(value.message) },
    timeoutMs: QUICK_TIMEOUT_MS,
    async execute(args, exec) {
      if (typeof args?.muted !== "boolean") fail("muted 必须是布尔值。");
      return actions.setMuted(args.muted, exec?.signal);
    },
  });

  try {
    const prompt = typeof ctx.get === "function" ? ctx.get("systemPrompt") : ctx.systemPrompt;
    if (prompt && typeof prompt.section === "function") {
      prompt.section({
        name: "tool:beauticode",
        order: 160,
        text:
          "beautiCode 可以把本机图片或 MP4 设为当前 DeepSeek Harness 页面背景。用户要换背景、导入视频或壁纸、切换已保存主题、摸鱼或开关背景声音时，调用 beauticode_* 工具，不要用 shell 改文件或 curl。路径必须是本机绝对路径。用户也可以直接输入斜杠命令 /bg、/bg-theme、/bg-clear。不需要 beautiCode 托盘。",
      });
    }
  } catch {
    /* Prompt guidance is optional. */
  }
}

function registerBeauticodeCommands(ctx, options) {
  const commands = ctx.commands;
  if (!commands || typeof commands.register !== "function") return;
  const actions = createBeauticodeActions(options);

  registerOne(commands.register.bind(commands), {
    name: "bg",
    description: "把本机图片或 MP4 设为 beautiCode 背景",
    input: { hint: "本机图片或 MP4 的绝对路径" },
    async handler({ rawInput, signal }) {
      try {
        return { kind: "success", text: await runBgCommand(options, rawInput, signal) };
      } catch (error) {
        return commandResultFromError(error);
      }
    },
  });

  registerOne(commands.register.bind(commands), {
    name: "bg-theme",
    description: "切换已保存的 beautiCode 背景主题",
    input: { hint: "主题名称" },
    async handler({ rawInput, signal }) {
      try {
        const name = stripPathQuotes(rawInput);
        if (!name) {
          const listed = await actions.listThemes(signal);
          return { kind: "success", text: `${listed.message} 用法：/bg-theme <名称>` };
        }
        const result = await actions.useTheme(name, signal);
        return { kind: "success", text: result.message };
      } catch (error) {
        return commandResultFromError(error);
      }
    },
  });

  registerOne(commands.register.bind(commands), {
    name: "bg-clear",
    description: "清除 beautiCode 背景",
    async handler({ signal }) {
      try {
        const result = await actions.clear(signal);
        return { kind: "success", text: result.message };
      } catch (error) {
        return commandResultFromError(error);
      }
    },
  });
}

export function registerAgentSurfaces(ctx, options = {}) {
  if (!ctx || typeof ctx.inject !== "function") return;
  const dataRoot = options.dataRoot;
  if (typeof dataRoot !== "string" || !dataRoot) return;
  const actionOptions = {
    dataRoot,
    baseUrl: options.baseUrl,
  };
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      void stopInProcessSession(dataRoot);
    });
  }
  try {
    ctx.inject(["tools"], (inner) => {
      registerBeauticodeTools(inner, actionOptions);
    });
  } catch {
    /* Keep the page bridge alive if this DSH build has no tool registry. */
  }
  try {
    ctx.inject(["commands"], (inner) => {
      registerBeauticodeCommands(inner, actionOptions);
    });
  } catch {
    /* Same: slash commands are optional on a webServer-only composition. */
  }
}

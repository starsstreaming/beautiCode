import crypto from "node:crypto";
import path from "node:path";
import type { BeautiSession } from "./session.js";
import { toChineseErrorMessage } from "@beauticode/core";
import { pickLocalMedia } from "./native-picker.js";
import {
  installSkinFromCenter,
  skinCenterCatalog,
  skinCenterConfig,
} from "./skin-center.js";

const SELECTION_TTL_MS = 5 * 60 * 1000;

type PendingSelection = {
  kind: "image" | "video";
  path: string;
  name: string;
  expiresAt: number;
};

function fail(error: string, code?: string) {
  const message = toChineseErrorMessage(error);
  return code ? { ok: false, error: message, code } : { ok: false, error: message };
}

export function createConsoleHost(session: BeautiSession) {
  const selections = new Map<string, PendingSelection>();
  let pickerBusy = false;

  function publicThemes() {
    return session.listSavedThemes().then((list) =>
      list.map((theme) => ({
        id: theme.id,
        name: theme.name,
        type: theme.type ?? null,
        ...(theme.bundled ? { bundled: true } : {}),
        sourceMode: theme.sourceMode === "local" ? "local" : "managed",
      })),
    );
  }

  async function status() {
    const current = await session.status();
    const background = current.manifest.background;
    return {
      ok: true,
      media: background?.type ?? null,
      muted: current.muted !== false,
      atmosphere: background?.effects?.preset ?? null,
      themeId: current.themeId || null,
      sourceMode: background
        ? background.source?.kind === "local"
          ? "local"
          : "managed"
        : "clear",
      themes: await publicThemes(),
      skinCenter: await skinCenterConfig(),
    };
  }

  async function handle(request: Record<string, unknown>) {
    const route = String(request.path || "");
    const body =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    if (route === "/__beauticode/ui/status") return status();
    if (route === "/__beauticode/ui/gallery/config") return skinCenterConfig();
    if (route.startsWith("/__beauticode/ui/gallery/catalog")) {
      const url = new URL(route, "http://beauticode.local");
      const query: { q?: string; type?: string } = {};
      const q = url.searchParams.get("q");
      const type = url.searchParams.get("type");
      if (q) query.q = q;
      if (type) query.type = type;
      return skinCenterCatalog(query);
    }
    if (route === "/__beauticode/ui/gallery/install") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      return installSkinFromCenter(session, id);
    }
    if (route === "/__beauticode/ui/clear") {
      const result = await session.apply({ type: "clear" });
      return result.ok
        ? { ...result, ok: true, message: "已清除背景。" }
        : fail(result.error);
    }
    if (route === "/__beauticode/ui/mode") {
      const muted = body.muted !== false;
      const result = await session.setMuted(muted);
      return result.ok
        ? { ok: true, muted: result.muted, message: muted ? "背景视频已静音。" : "背景视频声音已打开。" }
        : fail(result.error || "无法切换背景声音。");
    }
    if (route === "/__beauticode/ui/theme/use") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return fail("主题 ID 无效。");
      const result = await session.useSavedTheme(id);
      return result.ok
        ? { ...result, ok: true, message: "已切换背景主题。" }
        : fail(result.error);
    }
    if (route === "/__beauticode/ui/theme/delete") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return fail("主题 ID 无效。");
      const deleted = await session.deleteSavedTheme(id);
      return deleted
        ? { ok: true, message: "已删除主题。" }
        : fail("主题不存在。");
    }
    if (route === "/__beauticode/ui/pick") {
      const kind = body.kind === "video" ? "video" : body.kind === "image" ? "image" : null;
      if (!kind) return fail("kind 必须是 image 或 video。");
      if (pickerBusy) return fail("文件选择器已经打开。");
      pickerBusy = true;
      try {
        const picked = await pickLocalMedia(kind);
        if (picked.cancelled) return { ok: true, cancelled: true };
        const selectionId = crypto.randomUUID();
        selections.set(selectionId, {
          kind,
          path: picked.path,
          name: picked.name,
          expiresAt: Date.now() + SELECTION_TTL_MS,
        });
        return {
          ok: true,
          selectionId,
          name: picked.name,
          suggestedThemeName: path.parse(picked.name).name.slice(0, 80) || "新主题",
        };
      } catch (error) {
        const code = (error as { code?: string }).code;
        return fail(
          error instanceof Error ? error.message : String(error),
          code === "native_picker_unavailable" ? code : undefined,
        );
      } finally {
        pickerBusy = false;
      }
    }
    if (route === "/__beauticode/ui/import-selected") {
      const selectionId =
        typeof body.selectionId === "string" ? body.selectionId.trim() : "";
      const themeName = String(body.themeName || "").trim();
      const selected = selections.get(selectionId);
      selections.delete(selectionId);
      if (!selected || selected.expiresAt < Date.now()) {
        return fail("选择令牌无效。");
      }
      if (!themeName) return fail("请先给该主题取名。");
      const input =
        selected.kind === "video"
          ? { type: "video" as const, videoPath: selected.path, source: "local" as const }
          : { type: "image" as const, imagePath: selected.path, source: "local" as const };
      const result = await session.applyAndSaveTheme(input, themeName);
      if (!result.ok || !("theme" in result) || !result.theme) {
        return fail(result.ok ? "主题保存失败。" : result.error);
      }
      return {
        ok: true,
        message: `已将「${result.theme.name}」设为背景。`,
        theme: result.theme,
        sourceMode: result.sourceMode,
      };
    }
    return fail("未知的背景操作。");
  }

  return { handle };
}

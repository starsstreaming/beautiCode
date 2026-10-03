import fs from "node:fs";
import path from "node:path";
import type { DesktopCdpHostSpec } from "@beauticode/adapter-desktop-cdp";

interface CandidateOptions {
  env?: NodeJS.ProcessEnv;
  readRecord?: () => unknown;
  exists?: (file: string) => boolean;
  realpath?: (file: string) => string;
}

export function doubaoExecutableCandidates(options: CandidateOptions = {}): string[] {
  const env = options.env || process.env;
  const recordPath = path.join(env.LOCALAPPDATA || "", "beauticode", "hosts", "doubao", "executable.json");
  const readRecord = options.readRecord || (() => JSON.parse(fs.readFileSync(recordPath, "utf8")) as unknown);
  const exists = options.exists || fs.existsSync;
  const realpath = options.realpath || fs.realpathSync.native;
  const values = [
    env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, "Doubao", "Doubao.exe")
      : "",
    env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, "Programs", "Doubao", "Doubao.exe")
      : "",
    env.ProgramFiles
      ? path.join(env.ProgramFiles, "Doubao", "Doubao.exe")
      : "",
    "D:\\Doubao\\app\\Doubao.exe",
  ];
  try {
    const record = readRecord() as { schema?: unknown; host?: unknown; path?: unknown };
    const candidate = typeof record?.path === "string" ? record.path : "";
    if (record?.schema === "beauticode.host-executable/v1" && record.host === "doubao" &&
      path.win32.isAbsolute(candidate) && path.win32.basename(candidate).toLowerCase() === "doubao.exe" && exists(candidate)) {
      const canonical = path.win32.normalize(realpath(candidate));
      if (path.win32.basename(canonical).toLowerCase() === "doubao.exe") values.push(canonical);
    }
  } catch { /* Missing or invalid ownership records must not change default discovery. */ }
  const unique = new Map<string, string>();
  for (const value of values.filter(Boolean)) {
    const normalized = path.win32.normalize(value);
    if (!unique.has(normalized.toLowerCase())) unique.set(normalized.toLowerCase(), normalized);
  }
  return [...unique.values()];
}

export const DOUBAO_CDP_SPEC: DesktopCdpHostSpec = Object.freeze({
  kind: "doubao",
  displayName: "豆包",
  processName: "Doubao.exe",
  executableCandidates: Object.freeze(doubaoExecutableCandidates()),
  defaultPort: 9342,
  candidatePorts: Object.freeze([9352, 9362, 9372]),
  popupTopInset: 12,
  repairSuppressionMs: 0,
  restartDelayMs: 1_200,
  targetUrl: "doubao://doubao-chat/chat",
  targetRuntimeUrl: "doubao://doubao-chat/",
  mount: "doubao",
  anchorSelector: '[data-testid="skill-page-item-more"]',
  anchorText: "更多",
  strings: Object.freeze({
    entry: "自定义背景",
    title: "自定义背景",
    dim: "背景阴影",
    blur: "背景磨砂",
    transparency: "面板透明度",
    sound: "声音",
    soundOn: "已开",
    soundOff: "已关",
    importBackground: "导入背景",
    chooseFile: "选择文件",
    savedThemes: "已保存主题",
    choose: "选择",
    skinCenter: "皮肤中心",
    open: "打开",
    clearBackground: "清除背景",
    clear: "清除",
    saveTheme: "保存主题",
    themeNamePlaceholder: "请输入主题名称",
    cancel: "取消",
    saveAndApply: "保存并应用",
    nameRequired: "请输入主题名称。",
    noThemes: "暂无已保存主题。",
    close: "关闭",
    image: "图片",
    video: "视频",
    missingFile: "原始文件已移动或删除。",
    unsupportedFile: "不支持的图片或视频格式。",
    importFailed: "背景加载失败。",
    appliedImage: "图片背景已应用。",
    appliedVideo: "视频背景已应用。",
  }),
  contract: Object.freeze({
    backdropSelectors: Object.freeze([
      "#chat-route-layout",
      "#chat-route-main",
      "#chat-route-main > main",
    ]),
    surfaceSelectors: Object.freeze([
      "#flow_chat_sidebar",
      ".guidance-input-surface",
      '[role="dialog"]',
    ]),
    flattenSelectors: Object.freeze([
      "#flow_chat_sidebar .bg-inherit",
      ".guidance-input-surface > *",
    ]),
    readingSelectors: Object.freeze(['#chat-route-main', '#flow_chat_sidebar']),
    opaqueSelectors: Object.freeze(['.guidance-input-surface']),
  }),
  theme: Object.freeze({
    rootAttribute: "data-theme",
    darkAttributeValues: Object.freeze(["dark"]),
    lightAttributeValues: Object.freeze(["light"]),
    observeAttributes: Object.freeze(["class", "data-theme"]),
  }),
});

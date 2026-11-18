import fs from "node:fs";
import path from "node:path";
import type { DesktopCdpHostSpec } from "@beauticode/adapter-desktop-cdp";

interface CandidateOptions {
  env?: NodeJS.ProcessEnv;
  readRecord?: () => unknown;
  exists?: (file: string) => boolean;
  realpath?: (file: string) => string;
}

// Same record shape as the Doubao adapter. Kept here so a Doubao path change
// cannot widen what counts as Doubao Work.
export function doubaoworkExecutableCandidates(options: CandidateOptions = {}): string[] {
  const env = options.env || process.env;
  const recordPath = path.join(env.LOCALAPPDATA || "", "beauticode", "hosts", "doubaowork", "executable.json");
  const readRecord = options.readRecord || (() => JSON.parse(fs.readFileSync(recordPath, "utf8")) as unknown);
  const exists = options.exists || fs.existsSync;
  const realpath = options.realpath || fs.realpathSync.native;
  const values = [
    env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, "DoubaoWork", "Application", "app", "DoubaoWork.exe")
      : "",
  ];
  try {
    const record = readRecord() as { schema?: unknown; host?: unknown; path?: unknown };
    const candidate = typeof record?.path === "string" ? record.path : "";
    if (record?.schema === "beauticode.host-executable/v1" && record.host === "doubaowork" &&
      /^[a-z]:[\\/]/i.test(candidate) && path.win32.basename(candidate).toLowerCase() === "doubaowork.exe" && exists(candidate)) {
      const canonical = path.win32.normalize(realpath(candidate));
      if (/^[a-z]:[\\/]/i.test(canonical) && path.win32.basename(canonical).toLowerCase() === "doubaowork.exe") values.push(canonical);
    }
  } catch { /* Missing or invalid ownership records must not change default discovery. */ }
  const unique = new Map<string, string>();
  for (const value of values.filter(Boolean)) {
    const normalized = path.win32.normalize(value);
    if (!unique.has(normalized.toLowerCase())) unique.set(normalized.toLowerCase(), normalized);
  }
  return [...unique.values()];
}

// Logged-out shell measured 2026-11-03. /chat/settings exists, but a fresh profile
// redirects to the consumer login page, so there is no settings testid to anchor on.
// The section mounts only when the path includes /settings and #chat-route-layout
// is already present. Hashed class names are intentionally absent.
// Sidebar and the task/plugin panel keep the host plate unless the user turns
// 功能面板不透明 off. Turning it off paints one alpha layer on the outer plate
// and clears the inner layers, so a wallpaper never sits under two translucent cards.
export const DOUBAOWORK_CDP_SPEC: DesktopCdpHostSpec = Object.freeze({
  kind: "doubaowork",
  displayName: "豆包工作",
  processName: "DoubaoWork.exe",
  executableCandidates: Object.freeze(doubaoworkExecutableCandidates()),
  defaultPort: 9346,
  candidatePorts: Object.freeze([9356, 9366, 9376]),
  popupTopInset: 12,
  // The host can replace its original process and strip the CDP flags. Leave
  // process ownership with the user and attach only after explicit launch.
  startupRepair: false,
  targetUrl: "doubaowork://doubaowork-chat/chat",
  targetRuntimeUrl: "doubaowork://doubaowork-chat/",
  // The window the user is looking at can be the launcher host while
  // doubaowork-chat is a collapsed duplicate of the same shell.
  targetHostnames: Object.freeze(["doubaowork-launcher"]),
  mount: "doubaowork",
  anchorSelector: "#chat-route-layout",
  anchorText: "",
  surfaceBaseVariable: "--dbx-bg-base-web",
  // chrome://doubaowork-chat never finishes a <video> load (readyState stays 0
  // for both blob and http). The same file plays in a same-origin srcdoc document.
  videoFrame: true,
  strings: Object.freeze({
    entry: "背景",
    title: "背景",
    dim: "背景阴影",
    blur: "背景磨砂",
    transparency: "面板透明度",
    sound: "声音",
    soundOn: "已开",
    soundOff: "已关",
    importBackground: "导入背景",
    chooseFile: "选择文件",
    savedThemes: "已保存的背景",
    choose: "选择",
    skinCenter: "打开皮肤中心",
    open: "打开",
    clearBackground: "清除背景",
    clear: "清除",
    saveTheme: "给主题取个名字",
    scene: "场景预览",
    wallpaperLibrary: "Wallpaper Engine 本地壁纸库",
    appliedScene: "场景预览已应用。",
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
  settings: Object.freeze({
    // The logged-in settings UI is the modal opened from the sidebar, then the
    // nested page titled 外观设置. A route match would paint the chat column.
    modalSelector: '[data-testid="settings_modal"]',
    // 2.36.15 renders the nested appearance page without a dedicated back
    // control; the "外观设置" title plus the "终端代码字体" marker identify it.
    pageTitle: "外观设置",
    pageMarker: "终端代码字体",
    title: "背景",
    intro: "换一张背景。侧栏、自动任务和插件页默认沿用原来的底色。",
    readability: "功能面板不透明",
  }),
  contract: Object.freeze({
    backdropSelectors: Object.freeze([
      "#chat-route-layout",
      "#chat-route-main",
      // The chat column keeps its own opaque plate on main. The class name is
      // hashed, so the stable child combinator is the one consumer Doubao uses.
      "#chat-route-main > main",
      // The top chrome paints bg-[var(--chat-bg-color)] itself; without this
      // rule an opaque white header survives above the translucent layout.
      '#chat-route-main [class*="h-header-height"]',
      "#flow-chat-guidance-page",
    ]),
    surfaceSelectors: Object.freeze([]),
    flattenSelectors: Object.freeze([
      ".guidance-input-surface > *",
    ]),
    opaqueSelectors: Object.freeze([
      ".guidance-input-surface",
      "#input-engine-container",
    ]),
    readabilitySelectors: Object.freeze([
      "#flow_chat_sidebar",
      '[data-testid="right-panel-container"]',
    ]),
    readabilityFlattenSelectors: Object.freeze([
      '[data-testid="right-panel-workbench-layer"]',
      '[data-testid="team-workspace-sidebar-entry"]',
    ]),
  }),
  theme: Object.freeze({
    rootAttribute: "data-theme",
    darkAttributeValues: Object.freeze(["dark"]),
    lightAttributeValues: Object.freeze(["light"]),
    observeAttributes: Object.freeze(["class", "data-theme"]),
  }),
});

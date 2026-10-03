import fs from "node:fs";
import path from "node:path";
import type { DesktopCdpHostSpec } from "@beauticode/adapter-desktop-cdp";

interface CandidateOptions {
  env?: NodeJS.ProcessEnv;
  readRecord?: () => unknown;
  exists?: (file: string) => boolean;
  realpath?: (file: string) => string;
}

export function cursorExecutableCandidates(options: CandidateOptions = {}): string[] {
  const env = options.env || process.env;
  const recordPath = path.join(env.LOCALAPPDATA || "", "beauticode", "hosts", "cursor", "executable.json");
  const readRecord = options.readRecord || (() => JSON.parse(fs.readFileSync(recordPath, "utf8")) as unknown);
  const exists = options.exists || fs.existsSync;
  const realpath = options.realpath || fs.realpathSync.native;
  const values = [
    env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe")
      : "",
    env.ProgramFiles
      ? path.join(env.ProgramFiles, "Cursor", "Cursor.exe")
      : "",
    env["ProgramFiles(x86)"]
      ? path.join(env["ProgramFiles(x86)"]!, "Cursor", "Cursor.exe")
      : "",
  ];
  try {
    const record = readRecord() as { schema?: unknown; host?: unknown; path?: unknown };
    const candidate = String(record?.path || "");
    if (record?.schema === "beauticode.host-executable/v1" && record.host === "cursor" &&
      path.win32.isAbsolute(candidate) && path.win32.basename(candidate).toLowerCase() === "cursor.exe" && exists(candidate)) {
      const canonical = path.win32.normalize(realpath(candidate));
      if (path.win32.basename(canonical).toLowerCase() === "cursor.exe") values.push(canonical);
    }
  } catch { /* Missing or invalid ownership record is not a process candidate. */ }
  return [...new Set(values.filter(Boolean).map((value) => path.win32.normalize(value)))];
}

export const CURSOR_CDP_SPEC: DesktopCdpHostSpec = Object.freeze({
  kind: "cursor",
  displayName: "Cursor",
  processName: "Cursor.exe",
  executableCandidates: Object.freeze(cursorExecutableCandidates()),
  defaultPort: 9341,
  candidatePorts: Object.freeze([9351, 9361, 9371]),
  popupTopInset: 44,
  // Cursor's vscode-file URL embeds the installation directory. Match its
  // stable renderer contract structurally instead of pinning one machine's
  // drive/path.
  targetUrl: "vscode-file://vscode-app/",
  targetRuntimeUrl: "vscode-file://vscode-app/",
  targetIdentity: Object.freeze({
    protocol: "vscode-file:",
    hostname: "vscode-app",
    pathSuffix: "/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html",
    hostEvidence: Object.freeze({
      path: Object.freeze(["/cursor/"]),
      targetText: Object.freeze(["cursor"]),
      browser: Object.freeze(["cursor"]),
    }),
  }),
  mount: "cursor",
  // Cursor's measured agent sidebar places Customize second in header actions.
  // The exact position and label are both required; an upstream reorder fails closed.
  anchorSelector: '[data-action-id="marketplace"][data-sidebar-primary-action], .agent-sidebar-header-actions > .agent-sidebar-cell:nth-child(2)',
  anchorText: "Customize",
  strings: Object.freeze({
    entry: "background",
    title: "Background",
    dim: "Background shadow",
    blur: "Background blur",
    transparency: "Panel transparency",
    sound: "Sound",
    soundOn: "On",
    soundOff: "Off",
    importBackground: "Import background",
    chooseFile: "Choose file",
    savedThemes: "Saved themes",
    choose: "Choose",
    skinCenter: "Skin center",
    open: "Open",
    clearBackground: "Clear background",
    clear: "Clear",
    saveTheme: "Save theme",
    themeNamePlaceholder: "Theme name",
    cancel: "Cancel",
    saveAndApply: "Save and apply",
    nameRequired: "Enter a theme name.",
    noThemes: "No saved themes.",
    close: "Close",
    image: "Image",
    video: "Video",
    missingFile: "The original file is unavailable.",
    unsupportedFile: "Unsupported image or video format.",
    importFailed: "The background could not be loaded.",
    appliedImage: "Image background applied.",
    appliedVideo: "Video background applied.",
  }),
  contract: Object.freeze({
    backdropSelectors: Object.freeze([
      "body > div:has(.agent-panel)",
      "div:has(> .ui-sidebar)",
      ".monaco-workbench",
      ".part.editor",
      ".editor-group-container",
      ".editor-instance",
      ".monaco-editor",
      ".monaco-editor-background",
      ".monaco-editor .margin",
      ".agent-panel",
      ".terminal-outer-container",
    ]),
    surfaceSelectors: Object.freeze([
      ".ui-sidebar",
      ".ui-prompt-input__container",
      ".part.sidebar",
      ".part.panel",
      '[role="dialog"]',
    ]),
    flattenSelectors: Object.freeze([
      ".ui-prompt-input__container > *",
      ".part.sidebar > .content",
      ".part.panel > .content",
    ]),
    readingSelectors: Object.freeze(['.agent-panel', '.monaco-editor', '.ui-sidebar', '.part.sidebar', '.part.panel', '.agent-sidebar-header-actions']),
    opaqueSelectors: Object.freeze(['.ui-prompt-input__container']),
  }),
  theme: Object.freeze({
    classElementSelector: '.monaco-workbench',
    highContrastLightClassTokens: Object.freeze(['hc-light']),
    highContrastClassTokens: Object.freeze(["cursor-high-contrast", "hc-black"]),
    darkClassTokens: Object.freeze(["cursor-dark", "vs-dark"]),
    lightClassTokens: Object.freeze(["cursor-light", "vs", "vs-light"]),
    observeAttributes: Object.freeze(["class", "data-theme"]),
  }),
});

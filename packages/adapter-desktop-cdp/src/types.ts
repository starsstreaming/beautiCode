import type { HostKind } from "@beauticode/core";

export type DesktopCdpHostKind = Extract<HostKind, "cursor" | "doubao" | "doubaowork">;

export interface DesktopHostStrings {
  entry: string;
  title: string;
  dim: string;
  blur: string;
  transparency: string;
  sound: string;
  soundOn: string;
  soundOff: string;
  importBackground: string;
  chooseFile: string;
  savedThemes: string;
  choose: string;
  skinCenter: string;
  open: string;
  clearBackground: string;
  clear: string;
  saveTheme: string;
  themeNamePlaceholder: string;
  cancel: string;
  saveAndApply: string;
  nameRequired: string;
  noThemes: string;
  close: string;
  image: string;
  video: string;
  scene?: string;
  wallpaperLibrary?: string;
  appliedScene?: string;
  missingFile: string;
  unsupportedFile: string;
  importFailed: string;
  appliedImage: string;
  appliedVideo: string;
}

export interface DesktopBackgroundContract {
  /** Fully transparent wallpaper areas. */
  backdropSelectors: readonly string[];
  /** Outermost readable surfaces. They all receive exactly one alpha layer. */
  surfaceSelectors: readonly string[];
  /** Children of a readable surface that must not stack another alpha layer. */
  flattenSelectors: readonly string[];
  /** Light-theme text regions retain a minimum backing independently of shadow. */
  readingSelectors?: readonly string[];
  /** Sticky input surfaces must hide the transcript behind them. */
  opaqueSelectors?: readonly string[];
  /**
   * Plates that keep the host's own fill until the user turns transparency on.
   * Missing or corrupt preferences stay opaque.
   */
  readabilitySelectors?: readonly string[];
  /** Children of a readability plate. They must not add a second alpha layer. */
  readabilityFlattenSelectors?: readonly string[];
}

/** Mount background controls inside the host settings route instead of a sidebar popup. */
export interface DesktopSettingsContract {
  /** The section mounts only while location.pathname includes this substring. */
  routeIncludes: string;
  /** Chat shell. Injection returns no-anchor when this node is missing. */
  layoutSelector: string;
  /** The section is parked off the chat page until this node exists on the settings route. */
  containerSelector: string;
  /** Wallpaper canvas that becomes one solid plate on the settings route. Empty skips that plate. */
  canvasSelector: string;
  /** Settings dialog. When set, the section mounts in this dialog instead of a route. */
  modalSelector?: string;
  /** Visible only on the nested page that should receive the section. */
  backSelector?: string;
  /** Exact title of that nested page. */
  pageTitle?: string;
  /** Exact row used to find the nested page's own group. */
  pageMarker?: string;
  title: string;
  intro: string;
  readability: string;
  readabilityOn: string;
  readabilityOff: string;
}

/** Exact host markers used to resolve the rendered theme without text matching. */
export interface DesktopThemeContract {
  /** Some VS Code themes attach their marker to the workbench, rather than body. */
  classElementSelector?: string;
  highContrastLightClassTokens?: readonly string[];
  /** Exact class tokens on the host body that mean high contrast. */
  highContrastClassTokens?: readonly string[];
  /** Exact class tokens on the host body that mean dark. */
  darkClassTokens?: readonly string[];
  /** Exact class tokens on the host body that mean light. */
  lightClassTokens?: readonly string[];
  /** Root attribute used by hosts such as Doubao. */
  rootAttribute?: string;
  /** Exact root-attribute values that resolve to high contrast. */
  highContrastAttributeValues?: readonly string[];
  /** Exact root-attribute values that resolve to dark. */
  darkAttributeValues?: readonly string[];
  /** Exact root-attribute values that resolve to light. */
  lightAttributeValues?: readonly string[];
  /** Optional exact CSS variable values used only as a host fallback. */
  cssThemeVariable?: string;
  /** Attributes whose changes can alter the host theme. */
  observeAttributes: readonly string[];
}

export interface DesktopCdpHostSpec {
  kind: DesktopCdpHostKind;
  displayName: string;
  processName: string;
  executableCandidates: readonly string[];
  /** Linux install layout. Absent means the host has no supported Linux build. */
  linux?: Readonly<{
    /** Electron main binaries, e.g. /usr/share/cursor/cursor. */
    executableCandidates: readonly string[];
  }>;
  defaultPort: number;
  candidatePorts: readonly number[];
  /** Suppress a second repair when this host replaces its launcher and drops CDP flags. */
  repairSuppressionMs?: number;
  /**
   * When false, startup must not close or relaunch the host. Doubao Work
   * drops the debug flags and restarts; chasing that restart closes the window.
   */
  startupRepair?: boolean;
  /** Host-specific delay after the old process tree exits and before relaunch. */
  restartDelayMs?: number;
  /** How long a just-started process without a debug port may still be repaired. */
  repairWindowMs?: number;
  /** Maximum time to stop the original process and confirm its tree has exited. */
  repairTransactionTimeoutMs?: number;
  /** Maximum time for a Windows close or termination command. */
  windowsProcessStopTimeoutMs?: number;
  /**
   * When false, a second main process stops the repair. The default still
   * closes port-less replacements before the controlled relaunch.
   */
  chaseReplacements?: boolean;
  /** Minimum distance between the popup and the host window's top chrome. */
  popupTopInset: number;
  targetUrl: string;
  targetRuntimeUrl: string;
  /**
   * Extra hostnames that render the same shell as targetUrl. The path must
   * still match. When several pages match, the visible one is the largest.
   */
  targetHostnames?: readonly string[];
  targetIdentity?: DesktopTargetIdentity;
  mount: "cursor" | "doubao" | "doubaowork";
  anchorSelector: string;
  anchorText: string;
  strings: DesktopHostStrings;
  contract: DesktopBackgroundContract;
  theme: DesktopThemeContract;
  /** Present only for hosts that keep background controls in their own settings page. */
  settings?: DesktopSettingsContract;
  /** Host plate token, for example `--dbx-bg-base-web`. Absent hosts keep the shared fallbacks. */
  surfaceBaseVariable?: string;
  /**
   * Play video in a same-origin document. Set this only when the host page's
   * own HTMLVideoElement never finishes loading.
   */
  videoFrame?: boolean;
}

/** Structured identity for hosts whose renderer URL contains an install path. */
export interface DesktopTargetIdentity {
  protocol: string;
  hostname: string;
  pathSuffix: string;
  /** At least one marker must be present in the target URL path, title, or
   * /json/version Browser value. */
  hostEvidence?: Readonly<{
    path?: readonly string[];
    targetText?: readonly string[];
    browser?: readonly string[];
  }>;
}

export interface DesktopTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

export interface DesktopProcess {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  port: number | null;
  createdAtMs: number | null;
}

export interface DesktopEnsureLog {
  info: (...messages: string[]) => void;
  warn: (...messages: string[]) => void;
}

export interface DesktopCdpEndpoint {
  port: number;
  browserUrl: string;
  browser: string | null;
  target: DesktopTarget;
}

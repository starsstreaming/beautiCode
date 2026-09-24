import type { HostKind } from "@beauticode/core";

export type DesktopCdpHostKind = Extract<HostKind, "cursor" | "doubao">;

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
}

/** Exact host markers used to resolve the rendered theme without text matching. */
export interface DesktopThemeContract {
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
  defaultPort: number;
  candidatePorts: readonly number[];
  /** Suppress a second repair when this host replaces its launcher and drops CDP flags. */
  repairSuppressionMs?: number;
  /** Host-specific delay after the old process tree exits and before relaunch. */
  restartDelayMs?: number;
  /** Minimum distance between the popup and the host window's top chrome. */
  popupTopInset: number;
  targetUrl: string;
  targetRuntimeUrl: string;
  mount: "cursor" | "doubao";
  anchorSelector: string;
  anchorText: string;
  strings: DesktopHostStrings;
  contract: DesktopBackgroundContract;
  theme: DesktopThemeContract;
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

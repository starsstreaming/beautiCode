import type { HostKind } from "@beauticode/core";

export { WORKBUDDY_HOST_DESCRIPTOR } from "./host-descriptor.js";
export {
  WORKBUDDY_RENDERER_PATH_FRAGMENT,
  isWorkBuddyPageUrl,
  pickWorkBuddyTarget,
  safeTargetLabel,
  assertLoopbackDebuggerUrl,
  type WorkBuddyTarget,
} from "./target.js";
export {
  STAGE_ID,
  STYLE_ID,
  SCRIM_VAR,
  SURFACE_ALPHA_VAR,
  SURFACE_ALPHA,
  SURFACE_BASE_VAR,
  SURFACE_BASE_BY_THEME,
  BACKDROP_SELECTORS,
  SURFACE_RULES,
  FLATTEN_SELECTORS,
  SIDEBAR_FLATTEN_SELECTORS,
  SEMANTIC_TINT_SELECTORS,
  MASK_SELECTORS,
  CONTRACT_ANCHORS,
  CONTRACT_ATTRIBUTES,
  SCRIM_BY_THEME,
  readTheme,
  buildContractCss,
  type ContractAnchor,
  type ContractCssOptions,
  type SurfaceRule,
  type WorkBuddyTheme,
} from "./contract.js";

export {
  parseColorAlpha,
  isOpaqueColor,
} from "./color.js";
export {
  BACKGROUND_BAR_INJECTION,
  BACKGROUND_BAR_CLEANUP,
  BACKGROUND_BAR_STYLE_ID,
  BACKGROUND_BAR_VERSION,
} from "./background-bar.js";
export { isInitialPersistState } from "./persist-state.js";
export {
  MAX_CDP_JSON_BYTES,
  WORKBUDDY_CDP_ENV_KEY,
  DEFAULT_WORKBUDDY_CDP_PORT,
  DEFAULT_WORKBUDDY_CDP_PORTS,
  workBuddyCdpPortCandidates,
  selectWorkBuddyCdpPort,
  parseRemoteDebuggingFlags,
  readBoundedJson,
  probeCdpPort,
  probeForeignCdp,
  probeWorkBuddyCdp,
  discoverWorkBuddyCdp,
  type DiscoveredWorkBuddyCdp,
} from "./discovery.js";
export {
  DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS,
  DEFAULT_WORKBUDDY_CDP_POLL_INTERVAL_MS,
  DEFAULT_WORKBUDDY_FAST_RECONNECT_DELAY_MS,
  DEFAULT_WORKBUDDY_IDLE_RECONNECT_DELAY_MS,
  classifyWorkBuddyStartupProcess,
  isWorkBuddyMainProcess,
  parsePsElapsedSeconds,
  workBuddyInstallCandidates,
  findWorkBuddyExecutable,
  isLoopbackPortFree,
  pickAvailableLoopbackPort,
  listWorkBuddyProcesses,
  stopWorkBuddyProcesses,
  launchWorkBuddyWithCdp,
  ensureWorkBuddyCdp,
  waitForWorkBuddyCdp,
  selectWorkBuddyReconnectDelay,
  type WorkBuddyProcess,
  type EnsureWorkBuddyCdpOptions,
  type EnsureWorkBuddyCdpHooks,
  type EnsuredWorkBuddyCdp,
} from "./launch.js";
export {
  TOKEN_INCLUDE_PATTERN,
  TOKEN_EXCLUDE_PATTERN,
  TOKEN_SCAN_EXPRESSION,
  TOKEN_OVERLAY_STYLE_ID,
  TOKEN_IMPORTANT,
  DEFAULT_TOKEN_ALPHA,
  buildTokenOverlayCss,
  HARDCODED_NEUTRAL_MAX_CHROMA,
  HARDCODED_SURFACE_SKIP_SELECTOR,
  HARDCODED_SURFACE_BASE_TOKEN,
  HARDCODED_SURFACE_BASE_FALLBACK,
  HARDCODED_SURFACE_SCAN_EXPRESSION,
  buildHardcodedSurfaceCss,
  buildStyleKeeperExpression,
  type HardcodedSurfaceOptions,
  type TokenOverlayOptions,
  type TokenSurfaceRow,
} from "./token-overlay.js";

/** Re-exported for callers that switch on the host kind. */
export type WorkBuddyHostKind = Extract<HostKind, "workbuddy">;

export {
  MAX_CDP_JSON_BYTES,
  readBoundedJson,
  probeCdp,
  type CdpEndpoint,
} from "./discovery.js";

export {
  CdpError,
  CdpIdentityMismatchError,
  CdpSession,
  validatedDebuggerUrl,
  browserIdFromVersion,
  isCandidatePageTarget,
  listPageTargets,
  fetchCdpVersion,
  fetchCdpTargetList,
  connectPageTarget,
  type CdpTargetInfo,
  type CdpVersionInfo,
  type CdpSessionOptions,
  type PageTargetFilterOptions,
} from "./cdp.js";

export {
  assessReadiness,
  SNAPSHOT_EXPRESSION,
  type ReadinessSnapshot,
} from "./readiness.js";

export {
  buildInjectionExpression,
  loadRendererSource,
} from "./payload.js";

export {
  MemoryHostApplier,
  type MemoryHostOptions,
} from "./memory-host.js";

export {
  CodexHostApplier,
  type CodexHostApplierOptions,
  type ConnectedTarget,
} from "./host-applier.js";

export {
  acquireInjectorLock,
  type InjectorLock,
} from "./injector-lock.js";

export {
  runApplyOnce,
  runWatch,
  type RunApplyOptions,
  type WatchOptions,
} from "./injector.js";

export {
  DEFAULT_CDP_CANDIDATE_PORTS,
  parseRemoteDebuggingFlags,
  scanWindowsDebuggingPorts,
  discoverCdpEndpoints,
  findBestCdpPort,
  getCodexLaunchGuidance,
  type DiscoveredCdpEndpoint,
  type DiscoverCdpOptions,
  type CodexLaunchGuidance,
} from "./host-discover.js";

export {
  BeautiSession,
  type BeautiSessionOptions,
} from "./session.js";

export { toChineseErrorMessage } from "@beauticode/core";

import {
  ApplyTransaction,
  BackgroundStore,
  MediaServerController,
  defaultDataRoot,
  type ApplyInput,
  type ApplyResult,
} from "@beauticode/core";
import { CodexHostApplier } from "./host-applier.js";
import { probeCdp } from "./discovery.js";
import { acquireInjectorLock } from "./injector-lock.js";
import { loadRendererSource } from "./payload.js";
import { BeautiSession } from "./session.js";

export interface RunApplyOptions {
  port: number;
  input: ApplyInput;
  dataRoot?: string;
  verifyDeadlineMs?: number;
  requireAppProtocol?: boolean;
  urlPrefix?: string;
}

export interface WatchOptions {
  port: number;
  dataRoot?: string;
  pollMs?: number;
  requireAppProtocol?: boolean;
  urlPrefix?: string;
  onTick?: (info: { sessions: number }) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

function createHost(opts: {
  port: number;
  requireAppProtocol?: boolean;
  urlPrefix?: string;
  pollMs?: number;
}): CodexHostApplier {
  const options: ConstructorParameters<typeof CodexHostApplier>[0] = {
    port: opts.port,
    requireAppProtocol: opts.requireAppProtocol ?? true,
  };
  if (opts.urlPrefix !== undefined) options.urlPrefix = opts.urlPrefix;
  if (opts.pollMs !== undefined) options.pollMs = opts.pollMs;
  return new CodexHostApplier(options);
}

/** Apply one transaction to a connected Codex renderer. */
export async function runApplyOnce(opts: RunApplyOptions): Promise<ApplyResult> {
  const dataRoot = opts.dataRoot ?? defaultDataRoot();
  const store = new BackgroundStore({ root: dataRoot });
  // Validate/adopt the data root before creating even a transient injector lock.
  await store.init();
  const release = await acquireInjectorLock(dataRoot, opts.port);
  const media = new MediaServerController({ enabled: false });
  const host = createHost(opts);
  try {
    await probeCdp(opts.port);
    await host.connect();
    const { cssText } = await loadRendererSource();
    const tx = new ApplyTransaction({
      store,
      media,
      host,
      cssText,
      verifyDeadlineMs: opts.verifyDeadlineMs ?? 30_000,
      offline: false,
    });
    return await tx.run(opts.input);
  } finally {
    host.close();
    await media.close();
    await release();
  }
}

/**
 * Keep the renderer synchronized until the caller aborts.
 * The same long-lived session implementation powers both CLI watch and tray.
 */
export async function runWatch(opts: WatchOptions): Promise<void> {
  const sessionOptions: ConstructorParameters<typeof BeautiSession>[0] = {
    port: opts.port,
    autoDiscover: false,
    deferHostConnect: false,
  };
  if (opts.dataRoot !== undefined) sessionOptions.dataRoot = opts.dataRoot;
  if (opts.pollMs !== undefined) sessionOptions.pollMs = opts.pollMs;
  if (opts.requireAppProtocol !== undefined) {
    sessionOptions.requireAppProtocol = opts.requireAppProtocol;
  }
  if (opts.urlPrefix !== undefined) sessionOptions.urlPrefix = opts.urlPrefix;
  if (opts.onError !== undefined) sessionOptions.onError = opts.onError;

  const session = new BeautiSession(sessionOptions);
  await session.start();
  try {
    while (!opts.signal?.aborted) {
      opts.onTick?.({ sessions: session.activeSessionCount });
      await waitForAbortOrDelay(opts.signal, opts.pollMs ?? 500);
    }
  } finally {
    await session.stop();
  }
}

async function waitForAbortOrDelay(
  signal: AbortSignal | undefined,
  ms: number,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

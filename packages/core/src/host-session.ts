import type { SavedThemeInfo } from "./background-store.js";
import type {
  ApplyInput,
  ApplyResult,
  BackgroundManifest,
  BackgroundTone,
  HostDescriptor,
} from "./types.js";

export interface HostSessionStatus {
  host: HostDescriptor;
  port: number | null;
  sessions: number;
  manifest: BackgroundManifest;
  mediaServer: string | null;
  fish: boolean;
  muted: boolean;
  tone: BackgroundTone;
}

/**
 * Common control-plane contract. Host adapters may keep richer private APIs,
 * but the tray only depends on this deliberately small surface.
 */
export interface HostSession {
  readonly descriptor: HostDescriptor;
  readonly cdpPort: number | null;
  readonly isBusy: boolean;
  readonly isOpen: boolean;
  readonly isHostReady: boolean;
  start(): Promise<{ port: number | null }>;
  stop(): Promise<void>;
  status(): Promise<HostSessionStatus>;
  apply(input: ApplyInput): Promise<ApplyResult>;
  reapply(): Promise<ApplyResult>;
  saveCurrentTheme(name: string): Promise<SavedThemeInfo>;
  listSavedThemes(): Promise<SavedThemeInfo[]>;
  deleteSavedTheme(themeId: string): Promise<boolean>;
  useSavedTheme(themeId: string): Promise<ApplyResult>;
  setFishMode(enabled: boolean): Promise<{ ok: boolean }>;
  setMuted(muted: boolean): Promise<{ ok: boolean }>;
  setBackgroundTone(
    tone: BackgroundTone,
  ): Promise<{ ok: boolean }>;
}

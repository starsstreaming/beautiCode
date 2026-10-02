import type { HostDescriptor } from "@beauticode/core";

/**
 * WorkBuddy desktop is a closed-source Electron app with an officially supported
 * CDP switch (`WORKBUDDY_REMOTE_DEBUGGING_PORT`). Image/video/clear/reapply
 * and mute/tone are honoured by the injected runtime. Imported media is named
 * and persisted in WorkBuddy's saved-theme picker. Fish mode is not wired yet.
 *
 * See docs/host-adapter-workbuddy.md.
 */
export const WORKBUDDY_HOST_DESCRIPTOR: HostDescriptor = Object.freeze({
  kind: "workbuddy",
  displayName: "WorkBuddy",
  capabilities: Object.freeze({
    image: true,
    clear: true,
    reapply: true,
    savedThemes: true,
    video: true,
    fish: false,
    muted: true,
    tone: true,
  }),
});

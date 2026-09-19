import type { HostDescriptor } from "@beauticode/core";

/**
 * WorkBuddy desktop is a closed-source Electron app with an officially supported
 * CDP switch (`WORKBUDDY_REMOTE_DEBUGGING_PORT`), so every capability that the
 * Codex adapter exposes can be honoured — including live render verify, because
 * the injected runtime reports state back through the page.
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
    fish: true,
    muted: true,
    tone: true,
  }),
});

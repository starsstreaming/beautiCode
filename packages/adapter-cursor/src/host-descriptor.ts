import type { HostDescriptor } from "@beauticode/core";

export const CURSOR_HOST_DESCRIPTOR: HostDescriptor = Object.freeze({
  kind: "cursor",
  displayName: "Cursor",
  capabilities: Object.freeze({
    image: true,
    clear: true,
    reapply: true,
    savedThemes: true,
    video: true,
    fish: false,
    muted: true,
    tone: false,
  }),
});

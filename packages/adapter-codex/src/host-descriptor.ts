import type { HostDescriptor } from "@beauticode/core";

export const CODEX_HOST_DESCRIPTOR: HostDescriptor = Object.freeze({
  kind: "codex",
  displayName: "Codex Desktop",
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

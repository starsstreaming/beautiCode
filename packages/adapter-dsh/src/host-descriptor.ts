import type { HostDescriptor } from "@beauticode/core";

export const DSH_HOST_DESCRIPTOR: HostDescriptor = Object.freeze({
  kind: "dsh",
  displayName: "DeepSeek Harness",
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

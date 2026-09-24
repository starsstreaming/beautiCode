import type { HostDescriptor } from "@beauticode/core";

export const DOUBAO_HOST_DESCRIPTOR: HostDescriptor = Object.freeze({
  kind: "doubao",
  displayName: "豆包",
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

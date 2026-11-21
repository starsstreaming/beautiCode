import type { HostDescriptor } from "@beauticode/core";

export const DOUBAOWORK_HOST_DESCRIPTOR: HostDescriptor = Object.freeze({
  kind: "doubaowork",
  displayName: "豆包工作",
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

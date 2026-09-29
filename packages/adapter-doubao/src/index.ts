import {
  buildDesktopBackgroundCleanup,
  buildDesktopBackgroundInjection,
} from "@beauticode/adapter-desktop-cdp";
import { DOUBAO_CDP_SPEC } from "./spec.js";

export { DOUBAO_HOST_DESCRIPTOR } from "./host-descriptor.js";
export { DOUBAO_CDP_SPEC } from "./spec.js";

export function buildDoubaoBackgroundInjection(galleryUrl = ""): string {
  return buildDesktopBackgroundInjection(DOUBAO_CDP_SPEC, galleryUrl);
}

export function buildDoubaoBackgroundCleanup(): string {
  return buildDesktopBackgroundCleanup("doubao");
}

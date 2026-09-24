import {
  buildDesktopBackgroundCleanup,
  buildDesktopBackgroundInjection,
} from "@beauticode/adapter-desktop-cdp";
import { CURSOR_CDP_SPEC } from "./spec.js";

export { CURSOR_HOST_DESCRIPTOR } from "./host-descriptor.js";
export { CURSOR_CDP_SPEC } from "./spec.js";

export function buildCursorBackgroundInjection(galleryUrl = ""): string {
  return buildDesktopBackgroundInjection(CURSOR_CDP_SPEC, galleryUrl);
}

export function buildCursorBackgroundCleanup(): string {
  return buildDesktopBackgroundCleanup("cursor");
}

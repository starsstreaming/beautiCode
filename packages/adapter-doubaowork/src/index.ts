import {
  buildDesktopBackgroundCleanup,
  buildDesktopBackgroundInjection,
} from "@beauticode/adapter-desktop-cdp";
import { DOUBAOWORK_CDP_SPEC } from "./spec.js";

export { DOUBAOWORK_HOST_DESCRIPTOR } from "./host-descriptor.js";
export { DOUBAOWORK_CDP_SPEC, doubaoworkExecutableCandidates } from "./spec.js";
export {
  catalogWorkshop,
  discoverWorkshopRoots,
  loadWallpaperLibrary,
  mediaForProject,
  readWorkshopItem,
  mergeWallpaperLibrary,
  pathsFromLibraryFolders,
} from "./wallpaper-library.js";

export function buildDoubaoWorkBackgroundInjection(galleryUrl = ""): string {
  return buildDesktopBackgroundInjection(DOUBAOWORK_CDP_SPEC, galleryUrl);
}

export function buildDoubaoWorkBackgroundCleanup(): string {
  return buildDesktopBackgroundCleanup("doubaowork");
}

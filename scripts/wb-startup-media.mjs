/** The user's explicit clear or saved choice always outranks bundled art. */
export function shouldApplyDefaultWallpaper({ cleared, wallpaper, hasMedia }) {
  return !cleared && !wallpaper && !hasMedia;
}

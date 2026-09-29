/**
 * WorkBuddy's renderer creates this state before the runner has had a chance
 * to hydrate it from disk. Those defaults are not a user decision and must
 * not win a race against the saved state on startup.
 */
export function isInitialPersistState(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const state = value as Record<string, unknown>;
  const themes = state.themes;
  return (
    !state.wallpaper &&
    !state.cleared &&
    !state.blob &&
    (!Array.isArray(themes) || themes.length === 0) &&
    !state.activeThemeId &&
    (state.dim == null || state.dim === 49) &&
    (state.blur == null || state.blur === 0) &&
    (state.alpha == null || state.alpha === 100)
  );
}

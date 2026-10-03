import { LIGHT_THEME_ROOT } from './theme-selectors.js';

/**
 * Protect text-bearing regions without changing host foreground tokens.
 *
 * A light host reads its text off the white veil over the media (same call as
 * the Codex adapter), so the reading areas carry no white plate: the panel
 * transparency the user picked is honoured instead of being floored at 82%,
 * which used to stack with the veil and hide the wallpaper. Functional panels
 * (dialogs, menus, the composer) stay opaque, because they hold their own text
 * over live content.
 */
export function buildReadableSurfaceCss(): string {
  const light = `${LIGHT_THEME_ROOT}[data-bc-active="true"]`;
  return `${light} :is(.conversation-shell,.wb-home-route,[data-view-id="sidebar"]){` +
    'background-color:color-mix(in srgb,#fff var(--bc-surface-alpha-pct,0%),transparent) !important;}' +
    'html[data-bc-active="true"] :is([role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],.cr-input-container){' +
    'background-color:var(--bc-surface-base,#fff) !important;}' +
    // 0.48 is the shipped light veil (contract SCRIM_BY_THEME.light); the slider
    // still wins whenever the user has moved it.
    `${light} #beauticode-bg-stage::after{background:rgba(255,255,255,var(--bc-scrim-val,0.48)) !important;}`;
}

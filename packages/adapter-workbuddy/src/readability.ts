import { LIGHT_THEME_ROOT } from './theme-selectors.js';

/** Protect text-bearing regions without changing host foreground tokens. */
export function buildReadableSurfaceCss(): string {
  const light = `${LIGHT_THEME_ROOT}[data-bc-active="true"]`;
  return `${light} :is(.conversation-shell,.wb-home-route,[data-view-id="sidebar"]){` +
    'background-color:color-mix(in srgb,#fff max(82%,var(--bc-surface-alpha-pct,82%)),transparent) !important;}' +
    'html[data-bc-active="true"] :is([role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],.cr-input-container){' +
    'background-color:var(--bc-surface-base,#fff) !important;}' +
    `${light} #beauticode-bg-stage::after{background:rgba(255,255,255,var(--bc-scrim-val,0)) !important;}`;
}

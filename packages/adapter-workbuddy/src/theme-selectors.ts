// All measured VS Code / chat-shell aliases must select the same palette.
// Keep the selectors on html so portals and the stage also inherit the palette.
export const LIGHT_THEME_ROOT = 'html:is(.light,.cb-light,.vscode-light,.vs,.vs-light,[data-theme="light"],:has(> body:is(.light,.cb-light,.vscode-light,.vs,.vs-light,[data-theme="light"])))';
export const DARK_THEME_ROOT = 'html:is(.dark,.cb-dark,.vscode-dark,.vs-dark,[data-theme="dark"],:has(> body:is(.dark,.cb-dark,.vscode-dark,.vs-dark,[data-theme="dark"])))';

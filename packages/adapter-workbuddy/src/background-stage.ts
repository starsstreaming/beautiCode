/** Re-resolve on every use: SPA remounts can detach the previous stage. */
export function ensureBackgroundStage(doc: Document): HTMLElement {
  let stage = doc.getElementById("beauticode-bg-stage");
  if (stage?.isConnected) return stage;
  stage = doc.createElement("div");
  stage.id = "beauticode-bg-stage";
  stage.setAttribute("data-bc-injected", "beauticode-workbuddy-bg");
  stage.style.cssText = "position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background-color:#101114";
  doc.documentElement.insertBefore(stage, doc.body);
  return stage;
}

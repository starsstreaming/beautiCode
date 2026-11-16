import assert from "node:assert/strict";
import test from "node:test";
import {
  DOUBAOWORK_CDP_SPEC,
  DOUBAOWORK_HOST_DESCRIPTOR,
  buildDoubaoWorkBackgroundInjection,
  doubaoworkExecutableCandidates,
} from "../dist/index.js";
import { chooseDesktopTarget, isDesktopTarget, selectDesktopMainProcesses } from "@beauticode/adapter-desktop-cdp";

const customPath = "D:\\豆包工作\\DoubaoWork\\app\\DoubaoWork.exe";
const candidateOptions = {
  env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
  readRecord: () => ({ schema: "beauticode.host-executable/v1", host: "doubaowork", path: customPath }),
  exists: (file) => file === customPath,
  realpath: (file) => file,
};

function injectedConfig(source) {
  const marker = "var CFG=";
  const start = source.indexOf(marker);
  if (start < 0 || source[start + marker.length] !== "{") throw new Error("missing CFG");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start + marker.length; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start + marker.length, i + 1));
    }
  }
  throw new Error("CFG json not closed");
}

test("Doubao Work recognizes a verified custom installation as a main process", () => {
  const executableCandidates = doubaoworkExecutableCandidates(candidateOptions);
  assert.ok(executableCandidates.includes(customPath));
  const rows = [
    { pid: 42, parentPid: 1, name: "DoubaoWork.exe", exe: customPath, cmd: `"${customPath}"`, created: 1000 },
    { pid: 43, parentPid: 42, name: "DoubaoWork.exe", exe: customPath, cmd: `"${customPath}" --type=renderer`, created: 1001 },
  ];
  assert.deepEqual(selectDesktopMainProcesses({ ...DOUBAOWORK_CDP_SPEC, executableCandidates }, rows, "win32").map((row) => row.pid), [42]);
});

test("Doubao Work rejects invalid and foreign executable records without losing the default app path", () => {
  const valid = candidateOptions.readRecord();
  const invalidRecords = [null, {}, { ...valid, schema: "other" }, { ...valid, host: "doubao" },
    { ...valid, path: "relative/DoubaoWork.exe" }, { ...valid, path: "D:\\Other\\Other.exe" }];
  for (const record of invalidRecords) {
    const values = doubaoworkExecutableCandidates({ ...candidateOptions, readRecord: () => record });
    assert.ok(!values.includes(customPath));
    assert.ok(values.includes("C:\\Users\\test\\AppData\\Local\\DoubaoWork\\Application\\app\\DoubaoWork.exe"));
  }
});

test("Doubao Work keeps background controls in settings and plates native until transparency is enabled", () => {
  assert.equal(DOUBAOWORK_HOST_DESCRIPTOR.kind, "doubaowork");
  assert.equal(DOUBAOWORK_HOST_DESCRIPTOR.displayName, "豆包工作");
  assert.equal(DOUBAOWORK_CDP_SPEC.defaultPort, 9346);
  assert.equal(DOUBAOWORK_CDP_SPEC.chaseReplacements, false);
  assert.equal(DOUBAOWORK_CDP_SPEC.repairWindowMs, 30_000);
  assert.equal(DOUBAOWORK_CDP_SPEC.strings.saveTheme, "给主题取个名字");
  assert.equal(DOUBAOWORK_CDP_SPEC.strings.wallpaperLibrary, "Wallpaper Engine 本地壁纸库");
  assert.deepEqual(DOUBAOWORK_CDP_SPEC.candidatePorts, [9356, 9366, 9376]);
  assert.equal(DOUBAOWORK_CDP_SPEC.targetUrl, "doubaowork://doubaowork-chat/chat");
  assert.deepEqual(DOUBAOWORK_CDP_SPEC.targetHostnames, ["doubaowork-launcher"]);
  assert.equal(isDesktopTarget(DOUBAOWORK_CDP_SPEC, {
    id: "launcher", type: "page", url: "doubaowork://doubaowork-launcher/chat?viewId=101",
  }), true);
  assert.equal(isDesktopTarget(DOUBAOWORK_CDP_SPEC, {
    id: "chat", type: "page", url: "doubaowork://doubaowork-chat/chat",
  }), true);
  assert.equal(isDesktopTarget(DOUBAOWORK_CDP_SPEC, {
    id: "background", type: "page", url: "doubaowork://doubaowork-background/",
  }), false);
  const visible = chooseDesktopTarget(
    [
      { id: "chat", type: "page", url: "doubaowork://doubaowork-chat/chat" },
      { id: "launcher", type: "page", url: "doubaowork://doubaowork-launcher/chat?viewId=101" },
    ],
    [66 * 40, 444 * 667],
  );
  assert.equal(visible?.id, "launcher");
  assert.equal(DOUBAOWORK_CDP_SPEC.surfaceBaseVariable, "--dbx-bg-base-web");
  assert.equal(DOUBAOWORK_CDP_SPEC.videoFrame, true);
  assert.equal(DOUBAOWORK_CDP_SPEC.theme.rootAttribute, "data-theme");
  assert.deepEqual(DOUBAOWORK_CDP_SPEC.theme.darkAttributeValues, ["dark"]);
  assert.deepEqual(DOUBAOWORK_CDP_SPEC.theme.lightAttributeValues, ["light"]);
  assert.equal(DOUBAOWORK_CDP_SPEC.settings.modalSelector, '[data-testid="settings_modal"]');
  assert.equal(DOUBAOWORK_CDP_SPEC.settings.backSelector, '');
  assert.equal(DOUBAOWORK_CDP_SPEC.settings.pageTitle, "外观设置");
  assert.equal(DOUBAOWORK_CDP_SPEC.settings.pageMarker, "终端代码字体");
  assert.equal(DOUBAOWORK_CDP_SPEC.settings.canvasSelector, "");
  assert.equal(DOUBAOWORK_CDP_SPEC.settings.readability, "功能面板不透明");
  assert.deepEqual(DOUBAOWORK_CDP_SPEC.contract.surfaceSelectors, []);
  assert.deepEqual(DOUBAOWORK_CDP_SPEC.contract.backdropSelectors, [
    "#chat-route-layout",
    "#chat-route-main",
    "#chat-route-main > main",
    '#chat-route-main [class*="h-header-height"]',
    "#flow-chat-guidance-page",
  ]);
  assert.deepEqual(DOUBAOWORK_CDP_SPEC.contract.opaqueSelectors, [
    ".guidance-input-surface",
    "#input-engine-container",
  ]);
  assert.deepEqual(DOUBAOWORK_CDP_SPEC.contract.readabilitySelectors, [
    "#flow_chat_sidebar",
    '[data-testid="right-panel-container"]',
  ]);
  assert.ok(!DOUBAOWORK_CDP_SPEC.contract.readabilitySelectors.includes("#chat-route-main"));

  const source = buildDoubaoWorkBackgroundInjection();
  const config = injectedConfig(source);
  assert.equal(config.settings.title, "背景");
  assert.equal(config.settings.readabilityOn, "已开");
  assert.equal(config.surfaceBaseVariable, "--dbx-bg-base-web");
  assert.equal(config.videoFrame, true);
  assert.match(source, /mountVideoFrame/);
  assert.match(source, /nameInput\.value=meta\.suggestedName\|\|themeStem\(file\.name\)/);
  assert.match(source, /data-theme-tab/);
  assert.match(source, /Wallpaper Engine 本地壁纸库/);
  assert.equal(config.settings.pageTitle, "外观设置");
  assert.match(source, /appearanceHost/);
  assert.match(source, /if\(CFG\.settings\.backSelector&&!isVisible\(back\)\)return null/);
  assert.match(source, /settingsMode/);
  assert.match(source, /data-bc-readable-surfaces="false"/);
  assert.match(source, /s\.readable!==false/);
  // The transparency slider must be visible; without it the host's native plate
  // cannot be made transparent and the sidebar stays a white sheet.
  assert.doesNotMatch(source, /PERSIST\.alpha=18/);
  assert.match(source, /row\(CFG\.settings\.readability,readability,null,'readability'\),row\(CFG\.strings\.dim,dim,null,'dim'\),alphaRow/);
  assert.match(source, /bc-desktop-glyph/);
  assert.match(source, /data-kind="readability"/);
  assert.match(source, /bc-desktop-settings\[hidden\]\{display:none!important\}/);
  assert.match(source, /background:transparent!important/);
  assert.match(source, /#chat-route-main > main/);
  assert.match(source, /html\[data-bc-active="true"\]\[data-bc-settings="true"\] /);
  assert.match(source, /CFG\.surfaceBaseVariable\+',#fff\)/);
  assert.match(source, /CFG\.surfaceBaseVariable\+',#1f1f1f\)/);
  assert.doesNotMatch(source, /skill-page-item-more/);
});

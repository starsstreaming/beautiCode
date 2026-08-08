import assert from "node:assert/strict";
import test from "node:test";
import { toChineseErrorMessage } from "../dist/error-message.js";

test("user-facing CDP errors are localized", () => {
  assert.equal(
    toChineseErrorMessage("Failed to fetch"),
    "未发现注入CDP的Codex进程",
  );
  assert.equal(
    toChineseErrorMessage(
      "No healthy loopback Codex CDP endpoint found. Open Codex Desktop, then use tray 应用或重新应用.",
    ),
    "未发现健康的本机 Codex CDP 端点，请先打开 Codex Desktop。",
  );
  assert.equal(
    toChineseErrorMessage("Live verify did not pass (fail): video node missing"),
    "实时校验未通过（失败）：未找到视频节点。",
  );
});

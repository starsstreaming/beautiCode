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
    "正在媒体验证中，请等待30s再次导入",
  );
});

test("user-facing DeepSeek Harness errors are localized", () => {
  assert.match(
    toChineseErrorMessage(
      "DeepSeek Harness phase one supports image backgrounds only.",
    ),
    /DeepSeek Harness 第一阶段仅支持图片背景/,
  );
  assert.match(
    toChineseErrorMessage("No DeepSeek Harness browser client is connected."),
    /页面尚未连接/,
  );
  assert.equal(
    toChineseErrorMessage("Built-in theme cannot be deleted."),
    "内置主题不能删除。",
  );
});

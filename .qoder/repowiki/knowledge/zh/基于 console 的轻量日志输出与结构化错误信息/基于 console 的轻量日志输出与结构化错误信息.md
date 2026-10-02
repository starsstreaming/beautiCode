---
kind: logging_system
name: 基于 console 的轻量日志输出与结构化错误信息
category: logging_system
scope:
    - '**'
source_files:
    - scripts/beauticode.mjs
    - apps/tray/session-host.mjs
    - integrations/deepseek-harness/cli.js
    - integrations/deepseek-harness/console.js
    - packages/core/src/media-server.ts
    - packages/core/src/host-session.ts
---

## 1. 使用的系统/方式

仓库没有引入任何第三方日志框架（如 pino、winston、bunyan、consola、debug 等），也没有统一的 logger 模块或日志级别管理。所有 Node.js 进程的输出均直接使用原生 `console.log` / `console.error`，并通过 `process.exitCode` 控制退出码。

- CLI 入口 `scripts/beauticode.mjs`：使用 `console.log` 打印帮助信息，使用 `console.error` 打印参数校验失败、发现 CDP 端口、友好错误提示等。
- 托盘会话主机 `apps/tray/session-host.mjs`：同样通过 `console.error` 输出参数校验错误、会话状态、错误回调消息（带 `[session]` 前缀）。
- 集成插件 `integrations/deepseek-harness/cli.js`：使用 `console.log` 报告安装/迁移结果，`console.error` 报告异常。

浏览器侧注入脚本 `integrations/deepseek-harness/console.js` 不是日志系统，而是“背景清单”UI 控件，用于在目标页面中展示当前背景状态、导入图片/视频、切换主题等，与后端通过 `/__beauticode/ui/*` 接口通信。

## 2. 关键文件

- `scripts/beauticode.mjs` — CLI 主入口，集中了人类可读的帮助输出和错误提示。
- `apps/tray/session-host.mjs` — 托盘长驻进程，负责启动/停止 host session，统一通过 `console.error` 输出诊断信息。
- `integrations/deepseek-harness/cli.js` — DSH 插件 CLI，输出安装/迁移/移除操作的结果。
- `integrations/deepseek-harness/console.js` — 注入到目标页面的 UI 控件脚本（非日志）。它通过 fetch 调用后端 `/__beauticode/ui/status` 等接口获取状态并渲染。
- `packages/core/src/media-server.ts` — 核心媒体服务器，内部无 `console.*` 调用，仅依赖 HTTP 请求生命周期；错误通过抛出 Error 由上层处理。
- `packages/core/src/host-session.ts` — 定义 HostSession 接口，其中 `status()` 返回 `HostSessionStatus`，是结构化状态数据而非日志。

## 3. 架构与约定

- **无中心化日志**：每个进程各自直接写 stdout/stderr，不存在共享的 logger 实例、配置文件或环境变量开关。
- **CLI 输出约定**：
  - 正常输出（帮助、成功摘要）走 `console.log`。
  - 诊断/错误/进度信息走 `console.error`，便于管道重定向时分离。
  - 通过 `finish(code)` 设置 `process.exitCode` 而非 `process.exit()`，以便异步清理后再退出。
- **错误本地化**：业务错误不直接输出原始堆栈，而是先调用 `toChineseErrorMessage(raw)`（从 `@beauticode/core` 导出），将底层英文错误翻译为中文用户可见消息，再输出。
- **结构化字段通过返回值传递**：应用层的状态（如 `HostSessionStatus`、`ApplyResult`、`BackgroundManifest`）以 JSON 对象形式在进程间或 API 响应中传递，而不是作为日志字段记录。
- **浏览器侧无 console 日志**：注入脚本 `console.js` 完全通过 DOM + fetch 与后端交互，未调用 `console.log/error/debug`。

## 4. 约定与约束

- **必须使用 `console.error` 输出诊断信息**：所有参数校验失败、运行时异常、会话状态变更都写入 stderr（见 `session-host.mjs`、`beauticode.mjs`、`cli.js` 中的模式）。
- **禁止向 stdout 输出诊断信息**：stdout 仅保留人类可读的帮助/摘要，避免污染管道下游消费方。
- **错误信息必须经 `toChineseErrorMessage` 转换**：CLI 和 tray 在输出错误前先调用该函数，保证面向用户的消息为中文。
- **无日志级别配置**：仓库未实现 INFO/WARN/ERROR 分级，也未提供环境变量控制输出粒度；所有 `console.error` 调用等价于“错误/诊断”级别。
- **无结构化日志格式**：日志行是纯文本，唯一结构化的标记是通过固定前缀（如 `[session]`、`[discover] using :...`）区分来源，而非 JSON 行。
- **浏览器侧不产生控制台日志**：注入脚本仅通过 UI 控件反馈状态，不向浏览器控制台输出调试信息。

综上，本仓库的“日志系统”本质上是**基于原生 console 的轻量输出约定**，配合 `toChineseErrorMessage` 完成错误本地化，并通过结构化返回值（而非日志字段）在进程/模块间传递状态。
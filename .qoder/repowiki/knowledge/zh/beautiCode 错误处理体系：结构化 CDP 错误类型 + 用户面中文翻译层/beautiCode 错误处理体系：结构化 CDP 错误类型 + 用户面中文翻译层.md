---
kind: error_handling
name: beautiCode 错误处理体系：结构化 CDP 错误类型 + 用户面中文翻译层
category: error_handling
scope:
    - '**'
source_files:
    - packages/core/src/error-message.ts
    - packages/core/src/types.ts
    - packages/core/src/index.ts
    - packages/adapter-codex/src/cdp.ts
    - packages/adapter-codex/src/index.ts
    - packages/adapter-dsh/src/index.ts
    - scripts/beauticode.mjs
    - apps/tray/session-host.mjs
    - integrations/deepseek-harness/agent.mjs
    - integrations/deepseek-harness/host-apply.mjs
---

## 1. 整体方案

本仓库采用「底层抛出结构化错误 + 顶层统一翻译为中文用户提示」的两层设计。
- 核心包 `@beauticode/core` 提供 `toChineseErrorMessage(value)`，把内部英文错误消息（含正则占位）映射为用户可读的简体中文提示，作为所有面向用户的边界（CLI、托盘、插件）的统一出口。
- `adapter-codex` 定义领域级错误类 `CdpError`、`CdpIdentityMismatchError`，在 CDP 发现/连接/命令执行路径上抛出，携带可选 `cdpCode`，便于上层区分网络、协议、超时等故障。
- 应用层通过 `try/catch` 捕获后调用 `friendlyError` / `localizeResult` 将错误转为人类可读文本或带建议的提示块；对返回结构中的 `error` 字段也统一用 `toChineseErrorMessage` 本地化。
- 没有使用 `panic/recover` 或全局 `unhandledRejection` 处理器；Node 进程退出码由 `finish(code)` 显式设置。

## 2. 关键文件与职责

| 文件 | 职责 |
|---|---|
| `packages/core/src/error-message.ts` | 集中维护 150+ 条错误消息的正则→中文映射规则，是用户面文案的唯一来源 |
| `packages/core/src/types.ts` | 定义 `ApplyResult = { ok: true, ... } | { ok: false, error: string, rolledBack, ... }`，强制所有应用操作以结构化结果返回错误，而非抛错 |
| `packages/adapter-codex/src/cdp.ts` | 定义 `CdpError`、`CdpIdentityMismatchError`，封装 CDP WebSocket 会话、目标过滤、版本探测，所有异常都包装为 `CdpError` |
| `packages/adapter-codex/src/index.ts` | 重新导出 `CdpError`、`CdpIdentityMismatchError`、`toChineseErrorMessage`，供上层消费 |
| `packages/adapter-dsh/src/index.ts` | 同样重新导出 `toChineseErrorMessage`，保证 DSH 适配器与 Codex 适配器一致的用户体验 |
| `scripts/beauticode.mjs` | CLI 入口：参数校验抛 `Error`，业务异常经 `friendlyError` 翻译并附加诊断步骤，`watch` 回调中用 `toChineseErrorMessage(err)` 输出 |
| `apps/tray/session-host.mjs` | 托盘会话宿主：所有 UI 可观察的错误对象都通过 `toChineseErrorMessage` 本地化后再返回给前端 |
| `integrations/deepseek-harness/*.mjs` | 插件侧通过 `adapter.toChineseErrorMessage` 调用核心翻译能力，保持跨集成一致的提示 |

## 3. 架构与约定

### 3.1 错误分类
- **CDP 协议错误**：`CdpError`（通用）、`CdpIdentityMismatchError`（浏览器身份变化），用于网络/协议/超时/安全校验失败。
- **主机状态错误**：如 `Session already stopped`、`Host is not connected`、`CodexHostApplier is closed`，由 host session/applier 抛出，被 `toChineseErrorMessage` 匹配为“会话已经停止”“尚未连接到 Codex 主机”等。
- **媒体/主题错误**：图片/视频格式、大小、路径、快照清单、保存限制等，全部通过正则匹配翻译。
- **文件系统/锁错误**：`Could not acquire (.+) lock`、`Another (.+) is running` 等，统一翻译为“无法获取…锁”“另一个…正在运行”。

### 3.2 翻译层规则
`toChineseErrorMessage` 按顺序匹配 150+ 条 `[RegExp, string | (match) => string]` 规则，支持两种形式：
- 固定替换字符串（如 `ECONNREFUSED` → `无法连接到目标服务（连接被拒绝）。`）
- 函数替换，可从正则捕获组中提取数字/名称注入到中文提示（如 `CDP HTTP (\d+) for (.+)` → `CDP 请求失败（HTTP ${match[1]}）：${match[2]}`）
- 空消息兜底为 `未知错误。`
- 递归调用：`reason`、`detail` 字段会再次进入翻译器，形成嵌套错误链的完整本地化。

### 3.3 返回值约定
`ApplyResult` 是核心契约：成功 `{ ok: true, generation, mode, timings? }`，失败 `{ ok: false, error: string, rolledBack, sourceMode?, timings? }`。调用方不依赖 throw/catch 判断成功与否，而是检查 `ok` 字段——这使得错误信息可以在 JSON 响应中序列化传输。

### 3.4 边界处理
- CLI：`parseArgs` 抛出的参数错误直接打印；业务异常经 `friendlyError` 判断特殊模式（CDP 不可用、重复注入器、浏览器身份变化）后追加操作指引。
- `watch`：通过 `onError` 回调接收错误，统一用 `toChineseErrorMessage` 输出。
- 托盘：所有返回给前端的错误对象都先经 `toChineseErrorMessage` 转换。
- 插件：通过 `adapter.toChineseErrorMessage` 间接调用，避免硬编码翻译逻辑。

## 4. 约定与约束

- **内部错误消息必须保持英文**：`error-message.ts` 注释明确说明 “Internal error strings remain English so protocol matching and recovery logic keep their existing semantics”，因此新增错误时应在抛出处写英文，再在规则表中添加对应中文映射。
- **CDP 端点必须白名单校验**：`validatedDebuggerUrl` 强制只接受 loopback 的 `ws://127.0.0.1:<port>/devtools/page/<id>` 形状，任何偏离都会抛 `CdpError("Rejected a CDP WebSocket URL outside the allowed loopback endpoint shape")`。
- **CDP 响应大小限制**：通过 `MAX_CDP_JSON_BYTES` + `readBoundedJson` 限制 JSON 读取大小，超限直接关闭连接，防止恶意响应耗尽内存。
- **页面目标数量上限**：`fetchCdpTargetList` 对 `/json/list` 返回数组长度做 cap（500），超限抛 `CdpError("CDP /json/list exceeded target count safety cap")`。
- **禁止非本机地址**：多处校验 loopback（`LOOPBACK_HOSTS`、`isAllowedPageUrl`、`CDP probe only allows loopback hosts`），生产环境不允许 `http://127.0.0.1` 测试页（需显式 `--allow-http`）。
- **进程互斥**：通过文件锁 + “Another … is running (pid N)” 错误阻止并发注入，失效锁会自动回收。
- **结果优先于异常**：`ApplyResult` 的 `ok` 字段是主分支判断依据，错误信息放在 `error` 字符串中，便于 JSON 序列化。
- **无全局错误处理器**：未使用 `process.on('uncaughtException')` 或 `unhandledRejection`，所有异步错误均通过 `try/catch` 或 Promise `.catch` 处理。
- **无 panic/recover**：代码库为 Node.js/TypeScript，不使用 Rust/Go 风格的 panic/recover 机制。

---
kind: configuration_system
name: beautiCode 配置系统：环境变量 + 进程间 JSON 状态文件 + 内嵌皮肤中心清单
category: configuration_system
scope:
    - '**'
source_files:
    - integrations/deepseek-harness/control-client.mjs
    - integrations/deepseek-harness/gallery-host.mjs
    - integrations/deepseek-harness/index.mjs
    - apps/tray/session-host.mjs
    - packages/core/src/paths.ts
    - packages/core/src/constants.ts
---

## 1. 整体方案

beautiCode 没有引入外部配置库，而是采用**三层组合**的轻量配置体系：

| 层级 | 来源 | 作用域 | 优先级 |
|---|---|---|---|
| 运行时环境变量 | `process.env` | 进程启动时注入 | 最高 |
| 用户数据目录中的 JSON 状态文件 | `dsh-control.json` / `session-host.json` / `tray-claim.json` / `dsh-bridge.token` | 跨进程共享（托盘 ↔ DSH ↔ 插件） | 中 |
| 内嵌/打包资源 | `skin-center.json`、`bridge-manifest.json` | 随包分发，可被环境变量覆盖 | 最低 |

所有持久化状态统一落在一个 **dataRoot** 目录下，该目录通过 `BEAUTICODE_DATA_ROOT` 或平台默认路径（Windows 下为 `%LOCALAPPDATA%\beautiCode`，否则 `~/.beauticode`）决定。

## 2. 关键文件与职责

- `integrations/deepseek-harness/control-client.mjs`：定义三个核心状态文件的 schema、读写原子写入、PID 存活检查、loopback URL 校验；导出 `defaultBeauticodeDataRoot()`、`controlFilePath()`、`sessionHostFilePath()`、`trayClaimFilePath()`。
- `integrations/deepseek-harness/gallery-host.mjs`：皮肤中心配置解析，优先读 `BEAUTICODE_SKIN_CENTER`，回退到同目录 `skin-center.json` 中的 `url`。
- `integrations/deepseek-harness/index.mjs`：桥接插件主入口，读取 `bridge-manifest.json` 声明协议版本，生成并校验 `dsh-bridge.token`，注册 `/__beauticode/*` 路由。
- `apps/tray/session-host.mjs`：托盘侧使用 `BEAUTICODE_CONTROL_TOKEN` 作为一次性控制令牌，启动后从 `process.env` 中删除，避免泄露给子进程。
- `packages/core/src/paths.ts`、`constants.ts`：core 包内的路径与常量（如主题名规范化等）。

## 3. 架构与约定

### 3.1 数据根目录（dataRoot）
```text
BEAUTICODE_DATA_ROOT
├── dsh-control.json          # DSH 控制端点（host: "dsh", pid, url, token）
├── session-host.json         # 会话宿主（host: "dsh" | "codex", pid, url, token）
├── tray-claim.json           # 托盘占用标记（pid, startedAt）
└── dsh-bridge.token          # 64 位十六进制 Bearer token
```
所有写操作通过 `writeAtomicJson(dataRoot, fileName, payload)` 实现：**先写 `.tmp` 再 rename**，权限 `0o600`，保证并发安全。

### 3.2 环境变量约定
| 变量 | 类型 | 说明 | 约束 |
|---|---|---|---|
| `BEAUTICODE_DATA_ROOT` | 绝对路径 | 覆盖默认数据目录 | 直接 `path.resolve` |
| `BEAUTICODE_SKIN_CENTER` | URL | 覆盖内置 `skin-center.json` | 必须 https/http，http 仅限 loopback，不允许用户名/密码/hash |
| `BEAUTICODE_CONTROL_TOKEN` | 字符串 | 托盘与控制端通信的一次性令牌 | 长度 ≥ 24，写入后从 env 删除 |
| `LOCALAPPDATA` | 路径 | Windows 平台默认数据根前缀 | 仅当未设置 `BEAUTICODE_DATA_ROOT` 时使用 |

### 3.3 进程间发现协议
DSH 与托盘通过 JSON 文件“握手”：
- 写入方调用 `writeDshControlFile` / `writeSessionHostFile` / `writeTrayClaim`，强制校验 `schema`、`host`、`pid`、`token`、`url`。
- 读取方调用 `readDshControlFile` / `readSessionHostFile` / `readTrayClaim`，除校验外还通过 `isLiveRecordedPid` 检查 PID 是否存活，若已死则返回 `null`。
- `callDshControl` 基于 `dsh-control.json` 发起 HTTP 请求，强制要求 `origin` 必须是 loopback，且携带 `Authorization: Bearer <token>`。

### 3.4 安全边界
- URL 白名单：所有控制 URL 必须满足 `isLoopbackControlUrl`（`http://127.0.0.1|localhost|[::1]`，无 path/query/hash）。
- Token 校验：`authorized()` 使用 `crypto.timingSafeEqual` 比较 `dsh-bridge.token`，token 必须符合 `/^[a-f0-9]{64}$/`。
- 请求体限制：所有 JSON 请求体上限 `MAX_BODY_BYTES = 64 * 1024`，超限返回 413。
- 同源校验：SSE 和 UI 接口通过 `isSameOrigin(req)` 检查 `origin === http://{host}` 或 `sec-fetch-site === same-origin`。

### 3.5 皮肤中心配置
`resolveConfiguredSkinCenterUrl()` 的解析顺序：
1. `process.env.BEAUTICODE_SKIN_CENTER`（经 `normalizeSkinCenterUrl` 严格校验）
2. 同目录 `skin-center.json` 中的 `url` 字段
3. 两者均不存在时返回 `null`，后续 API 返回 `enabled: false` 或错误

## 4. 约束与规则

- **禁止非 loopback 控制地址**：任何写入 `dsh-control.json` / `session-host.json` 的 URL 必须通过 `isLoopbackControlUrl`，否则抛错。
- **Token 最小长度**：控制 token 必须 ≥ 24 字符；bridge token 必须为 64 位十六进制。
- **JSON 状态文件必须带 schema**：每个状态文件包含 `schema` 字段（如 `beauticode.dsh-control/v1`），读取时校验 schema 不匹配即视为无效。
- **PID 存活检查**：读取状态文件时若 `allowDead` 未显式开启，会验证记录的 PID 仍存活，否则返回 `null`。
- **数据目录权限**：原子写入临时文件时使用 `0o600` 权限。
- **环境变量覆盖内嵌配置**：`BEAUTICODE_SKIN_CENTER` 始终优先于 `skin-center.json`；`BEAUTICODE_DATA_ROOT` 始终优先于平台默认路径。
- **一次性令牌清理**：托盘在读取 `BEAUTICODE_CONTROL_TOKEN` 后立即 `delete process.env.BEAUTICODE_CONTROL_TOKEN`，防止子进程继承。

## 5. 适用性判断

本仓库存在一套完整、自洽的配置系统，涵盖环境变量、进程间 JSON 状态文件、内嵌清单、安全校验与生命周期管理，属于 **high** 置信度的配置系统实现。
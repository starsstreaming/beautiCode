# ADR 0006：DSH 全屏仅由用户主动开启

- 状态：接受
- 日期：2026-10-03
- 关联问题：[#83](https://github.com/starsstreaming/beautiCode/issues/83)

## 背景与证据

媒体客户端加载时通过 `armFullscreenDefault()` 注册捕获阶段的 `pointerdown` 监听器。页面上的首次点击会调用 Fullscreen API；请求被拒绝时，后续点击仍会继续尝试。该行为用于实现默认全屏，但没有禁止自动进入的设置。

Issue #83 报告在 DSH Desktop 的无边框窗口中，进入 HTML 全屏会隐藏原生最小化、最大化及关闭按钮。报告者删除自动入口后，普通点击与原生最大化按钮恢复正常。仓库回归用例也确认首次点击会触发标准及 WebKit 全屏请求。

## 决定与职责

删除媒体客户端中的自动全屏函数和加载时调用。客户端负责背景渲染，启动和普通输入均保持宿主已有的窗口模式。Web 与 Desktop 共用客户端，因此两者同时取消首次点击自动全屏。

全屏操作由背景设置中的「全屏显示」按钮负责，继续在明确的用户点击中调用 Fullscreen API，并通过真实全屏状态更新进入/退出标签。用户可通过该按钮或 `Esc` 退出。不增加自动全屏偏好、宿主识别分支或兼容入口。

## 验证、限制与回滚

独立回归文件 `integrations/deepseek-harness/test/fullscreen.test.mjs` 覆盖标准及 WebKit API 下的客户端加载、按钮点击、空白点击和输入框操作，确认不会请求全屏。现有控制台用例覆盖显式进入、退出、状态变化及不支持 API 时隐藏入口。

手动全屏仍可能隐藏 Desktop 原生窗口按钮；这是明确操作的结果，可通过 `Esc` 或设置按钮退出。自动化用例不替代真实 Electron 窗口验收。

本次没有修改接口、背景数据或持久化偏好，不需要迁移。回滚代码会恢复首次点击自动全屏及其窗口控制风险。

## npm 1.0.28 发布基线

按用户指定，以 registry 的 `beauticode-dsh@1.0.27` 实际 tarball 加上 PR #84 构建并发布 `1.0.28`。基线 SHA-1 为 `4156e31bd0bad2bd167192f4b5788c3197d2043f`，SHA-512 integrity 为 `sha512-igQ8QtKb2IOhp4wa/dAAQYtC3BgWa4LPi7ISsY37klq7xOXfxaQC3RJoexDKiMc1Qcb+wlsiQt3UQF1p3a+XxA==`；下载后均核对一致。

仅修改 `client.js`（删除 PR 对应的自动全屏入口）、`README.zh-CN.md`（加入主动全屏说明）及 `package.json`（版本号）。49 个包内文件中，其余 46 个文件逐字节保持基线内容，文件权限不变；保留 `1.0.27` 的功能面板不透明修复、原控制台、vendor、媒体资源和配置。没有直接从当前完整源码重新打包，因此不会带入基线之外的改动。

对实际候选 tarball 解包后，运行取消自动全屏、手动全屏及面板保护的 9 项回归，全部通过。源包使用 CRLF，README 含混合换行；应用补丁时保留未修改内容的原始字节。精确覆盖补丁及逐文件摘要保存于 `docs/releases/beauticode-dsh-1.0.28/`，发布后以 registry tarball 再次核对。

发布后的 registry tarball SHA-1 为 `a988f843e420c336ef7f365f60419ca714af8c5c`，SHA-512 integrity 为 `sha512-Bq5Lj3d+ShtKFFBlxqfWAdAB9Em4FppTwtSvJBZxkILyjM0Ol4YFKBCkQQh++7/7q25WzmlaKl4gnM22hbxMew==`。重新下载核验这两个摘要、49 个必需文件和精确版本均通过，与候选 tarball 完全一致，`latest` 指向 `1.0.28`。完整发布后证据见该目录的 `registry-verification.json`。

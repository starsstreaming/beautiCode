# PR #98 Linux 安全修复计划

> 使用 systematic-debugging、test-driven-development 和 executing-plans 顺序完成。

**目标：** 修复已审查确认的三项缺陷。
**设计：** [ADR 0010](../../adr/0010-linux-desktop-identity-and-autostart-ownership.md)。
**约束：** Node >=22；不新增依赖；不修改已有工作区；不操作真实客户端进程。

## 任务与验收

- [x] 对原 PR 编写并运行回归测试：独立 CLI、桌面/CLI 混合快照、同名未知程序；
  特殊路径的 Codex 重装/卸载；Cursor 外来文件保护。原实现出现九个预期失败。
- [x] 进程识别收紧为已知桌面安装路径，并按发现、启动、修复、连接编排拆分超过 900 行的模块。
  对应测试 `packages/adapter-codex/test/linux-processes.test.js` 从失败变为通过。
- [x] Codex 与 Cursor 复用 `scripts/xdg-autostart.mjs`，完整匹配经相同规则编码的 Exec，
  冲突预检放在有副作用的步骤之前，回滚也保留外来文件。
- [x] 同步独立 Codex 与桌面聚合包、安装后的稳定运行时的依赖清单。
- [x] 类型检查、全量测试、Linux 分支集成、两种平台包暂存导入与最终独立复查。

## 验证记录（2026-10-30）

- Node 24.18.0：Windows 全量 478 项，453 通过、25 按平台或可选环境跳过、0 失败。
- Ubuntu 22.04 / WSL 的独立临时检出：478 项，440 通过、38 跳过、0 失败。
  Linux 中实际运行了 Cursor install/uninstall 冲突预检测试，未触碰真实客户端。
- 两端类型检查通过。独立复查未发现新增可操作问题；源码与独立暂存包入口实际导入通过。
- Windows 首轮 DSH pack 测试出现一次 Node 测试执行器 IPC 反序列化错误；该文件
  单独六项测试通过，随后完整重跑也通过，未为此修改产品代码。
- 复查范围：未知手工桌面安装路径按 ADR 保守跳过；既有 Windows 身份策略与独立
  `beauticode-codex` 发布 manifest 的历史配置不在本次三个修复范围。聚合分发包继续验证完整运行时。

## 复查重点

CLI 身份不能进入自动终止流程；合法桌面继续被发现；转义后的完整命令可以重复识别；
外来文件在失败与回滚时仍然保留；安装后的代码不依赖源码目录。

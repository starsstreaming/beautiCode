# 动态场景共享基础实施计划

> 实施方式：在现有 `codex/doubaowork-cdp` 工作区逐项执行，先写回归测试再实现；保留另一个 DSH 工作区的未提交内容，不自动提交。

**目标：** 为后续五端接入提供可独立验证的 Scene 项目校验、Wallpaper Engine 库索引和受限资源服务，不改变当前运行中的客户端。

**架构：** 从现有 DSH 原型提取可复用的领域能力，逐项对照当前分支并修正其 Windows 本地路径和来源校验；文件路径只保留在守护侧，页面看到不透明 ID 和短期资源能力。本阶段不启用场景脚本，也不把海报当作动态场景。

**技术：** Node.js 22+、TypeScript、现有 `@beauticode/core`、Node 内置测试与 HTTP 模块。

**设计：** `docs/superpowers/specs/2026-11-06-five-host-background-design.md`。

## 全局约束

- 不覆盖任一工作区已有未提交修改；不修改当前客户端的安装或守护状态。
- 项目 JSON 最多 1 MiB，Scene PKG 最多 512 MiB；拒绝路径穿越、UNC/设备路径和符号链接。
- 资源服务仅监听 `127.0.0.1`，只接受显式授权的精确来源和短期随机令牌；不记录令牌或本机文件路径。
- 宿主能力未完成前不声明 Scene 已可用；不修改现有图片、视频及持久化契约。
- 修改过的文件不超过 500 行；真实动态渲染、首帧事务与用户界面属于后续阶段。

## 审查重点

- 文件在校验后被替换：重新打开并比较身份，拒绝旧能力访问新内容。
- 损坏、超限或越界的 PKG 索引：拒绝，不读取包外资源。
- 壁纸库某一项目损坏：其余项目仍可浏览，错误不泄露路径。
- 未知/空/`null` 来源或无效令牌：拒绝请求；不允许目录枚举与开放代理。
- 中止、关闭或并发请求：限制资源占用并释放文件、连接和句柄。

### Task 1: Scene 项目校验

**文件：** 新增 `packages/core/src/scene-project.ts`、`packages/core/test/scene-project.test.js`；修改 `packages/core/src/index.ts`。

**接口：** `validateSceneProject(projectPath)` 返回已规范化的项目路径、包路径、项目数据、内容身份和可选预览路径；`readWallpaperProject`、`projectResource` 提供库索引所需的受限文件解析。

- [ ] 编写合成 PKG 测试：有效项目、大小限制、损坏索引、重复条目、路径穿越、UNC/设备路径、符号链接和文件身份变化。
- [ ] 构建并运行该测试，确认因校验能力缺失而失败。
- [ ] 参考 DSH 原型实现校验；先校验真实路径与文件类型，再检查 PKG 边界并生成稳定身份。
- [ ] 运行项目校验测试及 core 类型检查，确认全部通过。

### Task 2: 本地壁纸库索引

**文件：** 新增 `packages/core/src/wallpaper-library.ts`、`packages/core/test/wallpaper-library.test.js`；修改 `packages/core/src/index.ts`。

**接口：** `WallpaperLibrary.connect(root)` 校验根目录；`disconnect(root)` 撤销该根的条目 ID；`list({q,type,offset,limit})` 只返回不透明 ID 和展示元数据；`resolve(id)` 在使用时重新校验并返回守护侧资源。发现候选目录与授予扫描权限分开。

- [ ] 编写临时目录测试：视频/Scene 分类、筛选分页、坏项目隔离、ID 不泄露绝对路径、断开后 ID 失效及源文件变化后的重新校验。
- [ ] 运行测试，确认缺失能力失败。
- [ ] 参考 DSH 原型实现有界索引、只读扫描和精确根目录连接；不读写用户实际库配置。
- [ ] 运行库索引测试及 Scene 校验测试，确认通过。

### Task 3: Scene 资源服务

**文件：** 新增 `packages/core/src/scene-server.ts`、`packages/core/test/scene-server.test.js`；修改 `packages/core/src/index.ts`。

**接口：** `new SceneResourceServer({ trustedOrigins })`；`stage(projectPath)` 返回仅限本机的带令牌 URL、项目数据和 `dispose()`；`commit(handle|null)` 切换当前资源；`close()` 终止服务与传输。

- [ ] 编写本机临时 HTTP 测试：正确来源与令牌读取，错误/缺失来源或令牌被拒绝，路径穿越被拒绝；资源替换、释放、中止和服务关闭后失效。
- [ ] 运行测试，确认缺失服务失败。
- [ ] 参考 DSH 原型实现资源服务，显式拒绝空、`null` 和通配来源；读取前重新校验项目与文件身份，并限制连接和并发。
- [ ] 运行服务测试、库索引测试及 core 类型检查，确认通过。

### Task 4: 阶段验证

- [ ] 运行 `npm run build -w @beauticode/core`、`npm run test -w @beauticode/core` 与 `npm run typecheck`。
- [ ] 检查差异和 `git diff --check`，确认当前客户端与其他工作区未被修改。
- [ ] 记录本阶段已验证能力与未完成的渲染、宿主接入和五端实机验收；继续制定下一阶段计划。

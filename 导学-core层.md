# 导学-core层

面向 `packages/core` 的源码阅读路径。core 是 beautiCode 的控制面：它不注入 Codex / DSH，只负责背景状态、磁盘原子提交、媒体校验、回环分发、事务编排和宿主无关接口。宿主差异在 `packages/adapter-codex`、`packages/adapter-dsh`。

建议总时长：5–8 天（每天 2–3 小时）。先把主链路走通，再按失败模式和测试补洞。

## 1. 前置知识（面试高频标注）

| 知识点 | 为何需要 | 在本项目中的位置 | 高频度 |
| --- | --- | --- | --- |
| 目录 rename 原子性 / 崩溃恢复 / WAL 思想 | 换背景时必须整棵树一起出现，不能留下半写入 active | `packages/core/src/background-store.ts` 的提交日志与 `#promoteStagingToActive` | 高 |
| 事务边界：磁盘成功 ≠ 用户可见成功 | 渲染器没确认时，必须回滚上一世代 | `packages/core/src/apply-transaction.ts` | 高 |
| 文件校验：magic bytes、symlink、realpath、identity | 用户可选任意本地文件，导入边界必须 fail-closed | `packages/core/src/media-validation.ts` | 高 |
| HTTP Range / 本机回环服务 / CORS / Private Network Access | 视频要边下边播；Codex CSP 又往往禁止 `http://127.0.0.1` | `packages/core/src/media-server.ts`、`packages/core/src/types.ts` 的宿主载荷 | 高 |
| 跨进程互斥：`O_EXCL`、PID 活性、锁租约 | 托盘、插件、CLI 可能同时写同一数据根 | `packages/core/src/file-lock.ts`、`packages/core/src/process-liveness.ts` | 高 |
| 单调世代号 / 过期回调作废 | 异步媒体事件不能把旧背景刷回来 | `packages/core/src/types.ts` 的 `generation`、`docs/media-contract.md` | 高 |
| TypeScript 判别联合 + 适配器接口 | core 只编排，宿主实现 `apply/verify` | `packages/core/src/types.ts`、`packages/core/src/host-session.ts` | 中 |
| Windows 文件句柄 / `EPERM` / 运行时副本 | Chromium 占着 active 目录时，下一次目录交换会失败 | `packages/core/src/background-store.ts` 的 `prepareRuntimeVideo` | 中 |
| 错误内英外中、协议字符串保持英文 | 匹配/恢复逻辑不能被翻译破坏 | `packages/core/src/error-message.ts` | 中 |

## 2. 重点亮点与学习顺序（先看这个）

| 亮点标题 | 为什么重要 | 通用技术关键词 | 先看哪些文件 | 建议学习顺序 |
| --- | --- | --- | --- | --- |
| 宿主无关控制面 | 先搞清 core 不做什么，才不会把 CDP 注入误读成核心 | 适配器、能力描述、契约 | `packages/core/src/index.ts`、`packages/core/src/types.ts`、`packages/core/src/host-session.ts`、`docs/host-adapter.md` | 1 |
| 状态建模与世代号 | 整条链路都围着一份清单和单调 `generation` 转 | 清单、来源契约、单调时钟 | `packages/core/src/types.ts`、`packages/core/src/media-source.ts`、`docs/media-contract.md` | 2 |
| 原子提交与崩溃恢复 | 这是磁盘真相来源；事务层只是在它上面编排 | 目录交换、提交日志、崩溃恢复 | `packages/core/src/paths.ts`、`packages/core/src/background-store.ts`、`packages/core/test/background-store.test.js` | 3 |
| 事务编排与失败回滚 | 用户看到的成功只发生在渲染器确认之后 | 两阶段提交、校验、回滚、可观测阶段耗时 | `packages/core/src/apply-transaction.ts`、对应 rollback 测试 | 4 |
| 媒体安全校验与零拷贝来源 | 大文件不能默认复制；本地引用又必须防路径逃逸和内容漂移 | 校验、symlink、fast/full identity、managed vs local | `packages/core/src/media-validation.ts`、`packages/core/src/constants.ts` | 5 |
| 回环媒体分发与句柄隔离 | 同一套媒体要同时服务 CSP 限制的宿主和允许 loopback 的宿主 | Range、双令牌、身份漂移、运行时副本 | `packages/core/src/media-server.ts`、`prepareRuntimeVideo` | 6 |

## 3. 必备知识点

- [ ] 能画出一次 `ApplyInput` 从托盘/插件进入 core，再到磁盘、媒体暂存、宿主 apply、verify、finalize 的时序。
- [ ] 能解释 `managed` 与 `local` 两种来源：谁复制、谁只记绝对路径、清单里字段有何不同。
- [ ] 能说明目录交换的三个日志阶段：`prepared` / `old-moved` / `new-active`，以及崩溃后如何选 active。
- [ ] 能说明为什么“磁盘 commit 成功”在配置了宿主时仍不算成功。
- [ ] 能说明视频为什么要脱离 active 目录做运行时副本，以及 local 视频为什么反而直接用原路径。
- [ ] 能说明回环媒体服务的绑定地址、双令牌、Origin 白名单、Range 与身份漂移策略。
- [ ] 能说明 `store.lock` 如何同时防进程内并发和跨进程双写。
- [ ] 能把测试名当成规格：rollback、stale journal、local import、runtime copy、token/range。

## 4. 推荐阅读（结合仓库）

按天数走。每段读完先合上文件，用最后一列自问。

| 主题 | 通用技术点 | 建议阅读位置 | 预计时间 | 读完能回答什么 |
| --- | --- | --- | --- | --- |
| 包边界与导出 | 模块门面、控制面最小表面 | `packages/core/package.json`、`packages/core/src/index.ts` | 20 分钟 | core 对外到底导出了哪些能力？哪些不该出现在 core？ |
| 领域类型 | 判别联合、能力位、世代号 | `packages/core/src/types.ts`、`packages/core/src/constants.ts` | 45 分钟 | 一次 apply 的输入/输出长什么样？为什么 image 载荷同时有 data URL、本地路径和 loopback URL？ |
| 媒体契约文档 | 清单 schema、播放语义 | `docs/media-contract.md`、`docs/host-adapter.md` | 40 分钟 | 海报为何始终存在？`generation` 如何作废过期回调？ |
| 路径与数据根 | 平台数据目录、所有权标记、路径逃逸 | `packages/core/src/paths.ts` | 40 分钟 | 为什么拒绝接管“看起来像数据根、实际是别的目录”？`isPathInsideRoot` 防的是什么？ |
| 来源解析 | 清单兼容、basename 安全 | `packages/core/src/media-source.ts` | 20 分钟 | legacy 无 `source` 字段时图片/视频路径怎么解析？ |
| 文件校验 | magic、symlink、fast/full hash | `packages/core/src/media-validation.ts`、`packages/core/test/media-validation.test.js` | 1.5 小时 | fast 模式的 identity 绑了什么？为什么 local 大文件不能全量哈希？ |
| 存储主对象 | 清单读写、staging、主题配额 | `packages/core/src/background-store.ts`（先 `init` / `commitImport` / `#promoteStagingToActive`） | 2 小时 | 一次 image/video/clear 如何升世代？local 导入为何 active 目录只剩清单？ |
| 崩溃恢复 | 提交标记新鲜度、日志回放 | `background-store.ts` 的 `#recoverInterruptedCommit`、`packages/core/test/background-store.test.js` 中 journal / marker 用例 | 1 小时 | 新鲜标记为何禁止读半写入树？过期日志如何在 next/backup 之间二选一？ |
| 快照与主题 | 快照、保存主题、内置主题 | `snapshot` / `saveCurrentTheme` / `loadSavedTheme` / `bundled-gallery.ts` | 1.5 小时 | 恢复主题为什么走普通 import 而不是直接改 active？内置主题为何不能删？ |
| 运行时视频 | 句柄隔离、预热读 | `prepareRuntimeVideo`、`pruneRuntimeMedia`、`warmVideoFileReads` | 45 分钟 | 为什么 managed 视频要拷到 `runtime-media`，local 视频却直接返回源路径？ |
| 文件锁 | `wx` 创建、nonce、隔离死锁 | `packages/core/src/file-lock.ts` | 40 分钟 | 为什么不能 read-then-overwrite 抢锁？同 pid 如何避免误释放别人的锁？ |
| 进程活性 | PID 复用、启动时间窗口 | `packages/core/src/process-liveness.ts` | 20 分钟 | 只 kill(pid,0) 为什么不够？无法取启动时间时为何乐观放行？ |
| 媒体枢纽 | 回环监听、双令牌、Range、CORS | `packages/core/src/media-server.ts`、`packages/core/test/media-server.test.js` | 2 小时 | `<video src>` 为什么必须带 query token？指纹变了 fast 和 full 各怎么处理？ |
| 事务编排 | 阶段计时、校验、回滚、忙锁 | `packages/core/src/apply-transaction.ts`、rollback / retry 测试 | 2.5 小时 | 校验失败后磁盘和宿主各自恢复到哪？为何首帧/Range 探针失败允许再试一次？ |
| 错误翻译 | 内英外中 | `packages/core/src/error-message.ts`、`packages/core/test/error-message.test.js` | 30 分钟 | 为什么内部错误字符串必须保持英文？ |
| 适配器接线 | core 如何被真正调用 | `packages/adapter-codex/src/session.ts` 中创建事务处、`packages/adapter-dsh/src/session.ts` | 45 分钟 | 两个宿主对 `includeImageDataUrl`、媒体 URL 的需求差在哪？ |
| 用测试当规格 | 回归即文档 | `packages/core/test/*.test.js` | 1.5 小时 | 你能否不看实现，只凭测试名复述失败模式？ |

## 5. 自学提醒

若某文件或原理看不懂，请继续追问 AI；本技能负责给学习路径与题目，不提供逐行讲解。

读卡时优先问这三类问题：

1. 这个机制在防止哪种失败？（崩溃、双写、句柄占用、CSP、路径逃逸）
2. 成功条件是什么？谁有权宣布成功？（磁盘、媒体枢纽、渲染器）
3. 对应哪条测试？没有测试的边界先标成待验证，不要脑补线上数字。

## 6. 项目技术定位

交叉（本地系统 + 媒体管道 + 宿主适配）。依据：core 用 Node 文件系统和本机 HTTP 管理背景状态，通过 `HostApplier` 把“应用到窗口”下沉给适配器，自己保证原子性、校验和回滚。

## 7. 核心原理解析

### 7.1 清单是唯一状态，世代号是作废时钟

- 问题：图片、视频、清除、已保存主题都在改“当前背景”，异步解码回调可能晚到。
- 机制：`BackgroundManifest` 带单调 `generation`；每次 commit 加一。渲染器回调必须核对世代，对不上就忽略。
- 落点：`packages/core/src/types.ts`、`BackgroundStore.commitImport`、宿主载荷里的 `generation`。

### 7.2 先在 staging 建完整树，再用目录交换发布

- 问题：直接往 `active/` 里覆盖文件，中途崩溃会留下坏清单或缺视频。
- 机制：staging 写完并整树校验后，写提交标记和日志，再 `rename(active → backup)`、`rename(staging → active)`。崩溃按日志阶段和哪棵树清单有效来恢复。
- 落点：`#promoteStagingToActive`、`#recoverInterruptedCommit`、`COMMIT_MARKER_NAME`。

### 7.3 用户可见成功绑定在宿主校验上

- 问题：磁盘已换代，但窗口没画出新背景，用户会认为“设上了”。
- 机制：`ApplyTransaction` 在 snapshot → commitImport → stageMedia → host.apply → host.verify 之后才 `media.commit` 并清快照。verify 非 `pass` 则回滚磁盘并尝试把宿主也恢复回去。
- 落点：`packages/core/src/apply-transaction.ts` 的 `#runExclusive` 与 `#rollback`。

### 7.4 两种来源：托管副本 vs 本地引用

- 问题：把 800MiB 视频默认拷进数据目录又慢又占空间；但完全信任用户路径会有逃逸和内容替换风险。
- 机制：`managed` 把文件拷进 staging 并用 basename 入清单；`local` 只记录 `realpath` 后的绝对路径，校验走 fast identity（元数据 + 文件头），服务时发现指纹变了直接拒绝。
- 落点：`commitImport`、`media-source.ts`、`inspectAndHash` 的 `fast`/`full`。

### 7.5 回环分发是能力，不是 Codex 的主路径

- 问题：视频需要 Range；部分宿主 CSP 禁止 loopback `img-src`/`media-src`。
- 机制：媒体枢纽只绑 `127.0.0.1`，路径令牌 + 头/query 令牌双因子，Origin 白名单。Codex 侧载荷优先 data/blob 和本机绝对路径；loopback URL 留给 DSH / 诊断。
- 落点：`LoopbackMediaHub`、`buildHostApplyPayload`、`HostApplyPayload` 注释。

### 7.6 写路径必须跨进程互斥，读路径必须避开新鲜提交

- 问题：托盘和插件可能同时写；提交中途读会看到半树。
- 机制：进程内 promise 链 + `store.lock`（`wx`）；读清单前后都检查新鲜提交标记。锁文件用 nonce 防止同 pid 误释放。
- 落点：`#withWriteLock`、`acquireFileLock`、`#assertNotCommitting`。

## 8. 关键设计决策

| 决策 | 备选 | 取舍 | 风险 | 验证 |
| --- | --- | --- | --- | --- |
| 目录 rename 换代，而不是改文件原地覆盖 | 单文件覆盖 + fsync；数据库 | rename 同卷上接近原子，整树（清单+海报+视频）一起出现 | 跨卷 rename 失败；Windows 上目录被占用会 `EPERM` | journal 恢复测试；runtime copy 测试 |
| 渲染器 verify 才算成功 | 磁盘成功即成功 | 避免“文件在、画面不在” | 宿主重启/超时会被判失败并回滚 | rollback / inconclusive 测试 |
| local 引用零拷贝 | 一律 managed 复制 | 大视频可设背景且不撑爆数据根 | 源文件被改/删会在服务或下次校验失败 | local import 测试；fast staging drift 测试 |
| managed 视频打 runtime 副本 | 直接 serve `active/background.mp4` | 避开 Chromium 占目录导致下次交换失败 | 多占一份磁盘；需要 prune | `live video payload uses a detached runtime copy` |
| 媒体枢纽双令牌 + 仅回环 | 无认证本地 HTTP | `<img src>` 不能自定义头，所以允许 `?t=`；仍要求路径令牌一致 | query token 会进日志/Referer | media-server 的 token/origin 测试 |
| 文件锁用 `wx` + 隔离死锁，而不是覆盖写 | `pidfile` 直接 unlink | 没有 read-then-write 窗口 | 锁文件损坏或权限问题导致反复 quarantine | `store lease blocks a second BackgroundStore instance` |
| 内英外中的错误层 | 内部直接中文 | 协议匹配、测试、恢复逻辑不被翻译打散 | 新错误如果忘了加规则会原样英文冒出 | `error-message.test.js` |

## 9. 量化与验证（含待测，建议）

仓库已有的可重复验证（优先跑这些，不要编线上数字）：

```bash
npm run test -w @beauticode/core
```

建议对照的测试即规格：

| 你想确认的行为 | 建议测试 | 状态 |
| --- | --- | --- |
| 图片/视频/清除升世代，空 active 的视频补合成海报 | `background store atomic image/video/clear + generation` | 可用测试验证 |
| local 导入不复制媒体，只写真路径 | `local image and video imports keep original paths...` | 可用测试验证 |
| 宿主 verify 失败会回滚 | `apply transaction rolls back when host verify fails` | 可用测试验证 |
| 过期提交日志能恢复完整 next 世代 | `stale directory-swap journal recovers a complete next generation` | 可用测试验证 |
| 新鲜提交标记挡住半写入读 | `fresh commit marker blocks reads; stale marker is ignored` | 可用测试验证 |
| 视频走 active 外的 runtime 副本 | `live video payload uses a detached runtime copy outside active` | 可用测试验证 |
| 冷启动首帧失败只重试一次 | `apply transaction retries one cold first-frame verify failure for video` | 可用测试验证 |
| 令牌、Range、Origin、身份漂移 | `loopback media server: token, range, origin, identity drift` | 可用测试验证 |
| 第二把存储锁被挡 | `store lease blocks a second BackgroundStore instance` | 可用测试验证 |

建议自测、仓库未提供线上基线（待测）：

- 真实 500MiB+ 本地视频从点击到首帧的阶段耗时（`ApplyResult.timings` 已按阶段打点，缺的是你自己的机器基线）。
- Windows 上 Chrome 占着文件时，不做 runtime 副本是否稳定复现 `EPERM`。
- Codex CSP 下 loopback URL 被拒、data/blob 成功的对照（属适配器+宿主，core 只准备三种载荷）。
- 崩溃注入：在 `old-moved` 阶段杀进程，重启后 active 是否恢复到可校验清单。

测量计划：用 `ApplyTransaction` 返回的 `timings.phases` 记录 `commitImport` / `hostApply` / `rendererVerify`；对同一文件分别走 `managed` 与 `local`，比较磁盘占用和导入耗时。没有对比日志前，不要把“更快/更稳”写进结论。

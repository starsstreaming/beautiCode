# beautiCode 重构最佳实践（不兼容版）

> 前提：**不要求向后兼容**。旧数据目录、旧启动器、旧桥接协议都可以直接断。
> 目标：beautiCode 从「替代 DSH 的启动器」退化成「插在用户自己 DSH 上的薄插件」。

---

## 1. 诊断：现在哪里不优雅

现状分层：

```
scripts/start-beauticode-dsh.ps1   ← 637 行单片启动器（问题核心）
  ├─ 独占端口 3080 + 探测状态机（down/http/starting/bridge）
  ├─ 互斥量 + 重试 + 等待占位
  ├─ 强推独立 DSH_HOME（%LOCALAPPDATA%\beautiCode-dsh-home）
  ├─ 私有运行时安装（install-dsh-runtime.ps1）
  ├─ 版本钉死（compatibility.json + SHA-512 → 0.1.0-rc.6）
  └─ 内容哈希发布桥接 + 动态生成 patch
integrations/deepseek-harness/     ← Cordis 插件（正确骨架，保留）
packages/core                      ← 媒体事务/令牌/存储（正确骨架，保留）
packages/adapter-codex             ← CDP 注入（历史包袱，待决）
apps/tray                          ← 托盘（保留，但去掉拉起 DSH 的职责）
```

具体病灶：

| 病灶 | 位置 | 不优雅之处 |
|---|---|---|
| 启动器替代 DSH 生命周期 | `scripts/start-beauticode-dsh.ps1` | 用户自己的 `~/.dsh` 历史对 beautiCode 不可见，两个 DSH 并存 |
| 单片状态机 | 同上 383-462 行 | 用 300 行代码补偿「不拥有进程」的问题 |
| 版本钉死 | `integrations/deepseek-harness/compatibility.json` | DSH 升级即断，还锁 npm 最新版本提示 |
| 私有运行时 | `scripts/install-dsh-runtime.ps1` | 重复安装用户已经有的 DSH |
| DOM hack | 插件 `index.mjs` | `pointer-events:none`、藏 `#root` 摸鱼，页面一改就碎 |
| 双宿主 | `packages/adapter-codex` | CDP 注入是另一套机制，维护两套「宿主」 |

---

## 2. 原则

1. **插件只挂载，不接管**。beautiCode 永远不启动、不重启、不搬运用户的 DSH。
2. **DSH 用自己的数据**。绝不设置 `DSH_HOME` / 私有数据目录。桥接文件写进用户 DSH 的补丁路径即可。
3. **一个入口，一个协议**。`integrations/deepseek-harness` 的桥接是唯一接口；一切功能（图片/视频/摸鱼/主题/恢复）都走它。Codex 要么翻译成该协议，要么删掉。
4. **状态机交给宿主工具**。进程拉起/守护交给用户（npm script、PM2、系统服务），代码里不留互斥量、重试、占位等待。
5. **失败要显式**。桥接版本不匹配、页面结构变了，直接报错给用户，不静默降级、不伪装成功。
6. **薄补丁，厚 API**。DOM 改动集中在最小注入面，把行为收敛到稳定的控制接口，页面内部实现变化由 API 层吸收。

---

## 3. 目标架构

```
用户自己跑:  dsh web --patch beauticode.patch.yml --port <用户端口>
                  │
                  ▼
        Cordis 插件 (integrations/deepseek-harness)
                  │ 本地鉴权接口 (/__beauticode/*, 随机令牌)
                  ▼
        core 控制端 (packages/core)
                  │   media-server / apply-transaction / background-store
                  ▼
        tray / CLI (apps/tray, scripts/beauticode.mjs)
```

- beautiCode 不启动任何进程。
- 数据根 = 用户显式传入的单一目录（`BEAUTICODE_DATA_ROOT`），无默认、无隐藏第二份。
- 版本约束：插件声明 `>=0.1.0-rc.6 <0.2.0` 的兼容区间；不匹配时报「升级 beautiCode」而不是自动重启 DSH。

### 3.1 最终形态：DSH 内开启（上游已支持，重构必须瞄准）

DSH 内置三件套，让「在 DSH 里开启插件」不是设想而是目标：

1. **真插件包，非 file:// patch**。`dsh plugin --profile web add @beautiCode/...`（pnpm）安装到 profile，
   加载走 `cordis.patch.yml`/bundles 配置层。废弃 `cordis.patch.example.yml` 的本机路径写法。
2. **浏览器插件面板**（`@deepseek-ai/dsh-client-ui-cordis`）。面板对宿主持有的每个 definition 提供
   load / stop / run 控制 → 用户在 DSH 界面里就能开/关 beautiCode。
3. **设置服务**（`@deepseek-ai/dsh-settings`）。插件注册 `beautiCode` namespace schema → DSH 设置面板
   渲染背景开关、媒体选择、主题、摸鱼快捷键开关。托盘职责被它吸收。

验证标准：
- `dsh plugin --profile web list` 能看到 beautiCode 且可卸载。
- DSH 面板能 load/stop beautiCode，停止后页面无注入残留。
- 设置面板改背景开关，无需重启 DSH 即生效。

---

## 4. 删除清单（不兼容，直接断）

| 删除/停用 | 替代 |
|---|---|
| `scripts/start-beauticode-dsh.ps1` 中所有进程拉起、端口探测、互斥、等待、重试 | 文档写明：`dsh web --patch …` |
| `scripts/install-dsh-runtime.ps1`、`dsh-runtime` 目录逻辑 | 直接用用户的 DSH |
| `integrations/deepseek-harness/compatibility.json` 的 integrity 钉死 | 声明兼容区间 |
| 强制隔离 `DSH_HOME` | 不设置 |
| `packages/adapter-codex` 的 CDP 注入 | 用 DSH 桥接协议翻译，或删除 |
| `%LOCALAPPDATA%\beautiCode` 旧数据兼容代码 | 直接读新数据根，无迁移 |
| `--data-root` 默认值、`LOCALAPPDATA` 猜测 | 显式必填 |

保留（已是好骨架）：
- `integrations/deepseek-harness/index.mjs` / `client.js`
- `packages/core`（apply-transaction、token、media-server、file-lock）
- `apps/tray`（去掉拉起职责后）
- 安全边界文档（loopback-only、令牌、回滚）——这些是标准，不是负担

---

## 5. 重构顺序

Phase 0 — 冻结
- 写 `docs/refactoring.md`（本文件）并锁功能范围。拍板：Codex 去留。

Phase 1 — 插件独立可挂
- 让插件能作为**真 Cordis 插件包**装进用户自己的 profile：`dsh plugin --profile web add`。
- 同时保留 `--patch` 直挂作为过渡，验证：`npm run bc -- probe --port <用户端口>` 能看到桥接。
- 交付物：README 从「运行启动器」改成「`dsh plugin` 安装一行」。

Phase 2 — 删启动器
- 删除 `start-beauticode-dsh.ps1` 的进程层；启动器降级成「拼 patch 路径 + 打印命令」的 20 行脚本，或直接删。
- 删除 `install-dsh-runtime.ps1`、`compatibility.json` integrity。
- 提交前先跑一次 `git grep -l "DSH_HOME\|dsh-runtime\|Local\\beautiCode"` 确认无残留。

Phase 3 — 统一协议
- 把 Codex 适配器翻译成 DSH 桥接协议（若保留），否则删 `packages/adapter-codex` 与 `scripts/codex-launch.ps1`。

Phase 4 — 去 DOM hack 风险
- 把客户端注入改成「探结构 + 报版本」：页面结构不符时返回明确错误，不再靠 CSS 碰运气。
- 摸鱼模式改由桥接 API 控制（如请求宿主隐藏），或标记为实验性。

Phase 5 — 收尾
- 统一数据根，删 `paths.ts` 里的 LOCALAPPDATA 猜测。
- 更新 README / live-smoke.md。

---

## 6. 工程实践（每 Phase 的硬门槛）

- **typecheck 绿**：`npm run typecheck`
- **单测绿**：`npm test`（core/adapter 三包）
- **实机冒烟**：`npm run smoke:live -- --port <用户端口>`，但前提是 DSH 由用户自己启动
- **不留未删文件**：被替代的脚本直接删，不注释保留
- **提交粒度**：一个 Phase 一个提交，Phase 2 允许大删除独立成提交
- **grep 收尾**：每 Phase 结束跑 `git grep` 确认旧符号（`EnsureBridgeOnly`、`Local\beautiCode.Engine`、`dshLaunchMutex`）清零

---

## 7. 验收标准

1. `dsh web --patch` 挂到**用户自己的** DSH，历史/会话完整可见。
2. beautiCode 不存在任何「启动 DSH」「设置 DSH_HOME」「装私有运行时」的代码路径。
3. 重启 DSH 后背景自动恢复；页面结构变化时报错而非静默失效。
4. `git grep -c "DSH_HOME\|LOCALAPPDATA\\\\beautiCode"` 为 0。
5. 删除目标清单中每个文件都真的删了，不是停用。

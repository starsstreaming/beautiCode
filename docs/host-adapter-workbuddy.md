# WorkBuddy 宿主适配设计说明

> 本文是 [`host-adapter.md`](./host-adapter.md)（通用宿主契约）的 WorkBuddy 补篇。
> 通用原则、DOM/CSS 契约骨架、CDP 安全规则均沿用那份文档；本文只写**WorkBuddy 特有的东西**：
> 怎么连上它、认哪个页面、改哪几层、主题切换怎么不被冲掉、verify 怎么判。
>
> 状态：**已落地**（`packages/adapter-workbuddy` + `scripts/wb-cdp-runner.mjs`）。文中仍保留「已实测 / 待实测」标记。

---

## 0. 一句话结论

WorkBuddy 是闭源 Electron 应用，且**官方内建了给外部自动化工具用的 CDP 开关**。
beautiCode 可以走和 Codex 同一条 CDP 注入路线，但比 Codex 更顺：素材能直接用 `file://` 引用，
渲染层还能真实回读状态，所以 **apply → live verify → 回滚** 这套主干可以完整保留，不需要降级。

---

## 1. 已验证到什么程度（实测证据）

全部在 macOS、WorkBuddy 5.5.6（`com.tencent.workbuddy.mac`）、Chromium 138.0.7204.251 上测得。

| # | 结论 | 证据 |
|---|---|---|
| 1 | 官方支持外部 CDP 连接 | 主进程 `applyCliCommandLineSwitches()` 读 `WORKBUDDY_REMOTE_DEBUGGING_PORT`，合法数字端口才 `appendSwitch("remote-debugging-port", …)`，并追加 `--remote-allow-origins`（只放行 `127.0.0.1` / `localhost`）。代码注释原文：「供 super-workbuddy skill 等外部自动化工具连接 默认不开」 |
| 2 | 带上环境变量启动后端口确实开 | `127.0.0.1:9335` OPEN；`/json/version` → `Chrome/138.0.7204.251` |
| 3 | 主窗口只有一个 page target | `/json/list` → 1 个 `page` + 2 个 `about:srcdoc` iframe |
| 4 | 主窗口页面 URL | `file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html?locale=zh-CN&accountSnapshot=…`（**带 query，且 query 内含账号快照**） |
| 5 | WebSocket 握手不需要 `Origin` 头 | 不带 Origin 直接 101；`--remote-allow-origins` 不构成阻塞 → **不需要引入 `ws` 包** |
| 6 | 可以执行任意页面 JS | `Runtime.evaluate` 往返正常（含 `awaitPromise`） |
| 7 | 页面根结构 | `html.class = "dark cb-dark vscode-dark"` / `"light cb-light vscode-light"`；`#root` 存在（`body` 子节点为 `div#root, script, div`）；`data-skin` 为空 |
| 8 | 素材可用 `file://` 直引 | 页面内 `new Image().src = "file:///…/bg-canvas.png"` → onload 成功，**6.2 MB / 2600×1351 直接加载**，绕开 Codex 的 128 KiB inline 上限与 `setFileInputFiles` 搬运 |
| 9 | 注入能落地且不被擦除 | 注入 `#beauticode-bg-stage` 后舞台 1470×919 精确覆盖视口、横向溢出 0 px；3 秒后 stage / style / `data-bc-active` 均仍在 DOM |
| 10 | 大面的颜色全部来自变量 | 见 §5 选择器表（用 `document.styleSheets` 逐条 `el.matches()` 溯源得到） |
| 11 | 让大面透明后壁纸真的露出来 | 注入后「大面积不透明面」清单里 `.teams-container`(100%) / `.conversation-shell`(77%) / `.conversation-list`(18%) 全部消失，只剩内容卡（代码块 12.2%、输入框 7.5%、工具卡 7%、表头 2.9%） |
| 12 | **视频可 `file://` 直引并自动播放** | `<video src="file:///tmp/bc-test-video.mp4" muted loop playsinline>` → `readyState=4`、`videoWidth=1280`、`duration=3`、`mediaError=null`；`play()` **resolved**、`paused=false`、1.2 秒内 `currentTime` 0 → 1.2 正常推进 |
| 13 | 非静音 `play()` 也没被自动播放策略挡 | 非静音元素 `play()` 同样 resolved。**但**该页面 `navigator.userActivation.hasBeenActive=true`（用户已在窗口里交互过），冷启动无交互的场景未覆盖 → 默认静音仍是稳妥选择 |
| 14 | 契约锚点全部命中（自检通过） | `.teams-container` / `.conversation-shell` / `.conversation-list` / `[class*="_gridViewItem_"]`(4 个) / `.cr-input-container` / `#root` / `.cr-message-list` 各命中 ≥1；主题类 `light cb-light vscode-light` 识别成功 |

**尚未实测（M1/M2 必须补上，见 §11）**：页面 reload / 路由切换后的重挂、浅色主题下的观感验收、多窗口。

---

## 2. 与 Codex 适配器的关系

`packages/adapter-codex` 的整体骨架可以直接搬，因为事务、注入、verify 这三块都在 adapter 内部，与宿主无关。

| 模块 | 处理方式 |
|---|---|
| `ApplyTransaction` 事务主干（snapshot/commit/rollback/媒体暂存） | **原样复用**，来自 `@beauticode/core` |
| media-validation / media-source / background-store / file-lock / error-message / paths | **原样复用** |
| CDP 客户端与连接层（`cdp.ts`） | **复用**，只需放宽"必须是 `app://`"的目标判定 |
| 注入运行时（`background-runtime.js` + stage DOM + `data-bc-*` + generation 守卫 + watch/重挂） | **复用结构，重写 CSS 部分** |
| 目标页判定（`urlPrefix = "app://"`、`requireAppProtocol`） | **必须重写**（WorkBuddy 是 `file://…app.asar/renderer/`） |
| CSS 契约（`main.main-surface` / `aside.app-shell-left-panel`） | **必须重写**（WorkBuddy 用另一套类名与变量，见 §5） |
| 摸鱼模式（Codex 隐藏 `#root`） | **可直接用**：实测 WorkBuddy 也有 `#root` |

---

## 3. 启动与连接

### 3.1 宿主启动（唯一的日常体验成本）

环境变量必须在**启动时**存在，所以：

```sh
# macOS：直接跑二进制，环境变量才会被继承（open -a 不传环境变量）
WORKBUDDY_REMOTE_DEBUGGING_PORT=9335 \
  /Applications/WorkBuddy.app/Contents/MacOS/Electron
```

- 从 Finder / Dock 双击启动**不会**带环境变量。
- 备选：`launchctl setenv WORKBUDDY_REMOTE_DEBUGGING_PORT 9335` 后照常 `open -a WorkBuddy`。这是**全局**环境变量，用完要 `launchctl unsetenv`。
- 决定（暂定）：随包提供一个启动脚本（`scripts/start-workbuddy-cdp.command` / `.ps1`），负责"若已在运行则先退出、再带变量拉起"。**不由 beautiCode 去重启用户的 WorkBuddy** —— 让程序拥有"关掉并重启别人应用"的能力，信任成本与安全风险都不划算。
- 缺端口时的行为：**fail closed** —— 报明确错误并提示上面这条命令，不静默、不假装成功（沿用 `host-adapter.md` 第 5 条原则）。

### 3.2 端口与连接

- 端口由用户/脚本指定，默认建议 `9335`（与 Codex 惯例一致）。
- 只连 `127.0.0.1`；沿用 `cdp.ts` 的既有约束：`/json/list`、`/json/version` 响应体封顶、拒绝跳转到 loopback 之外、单注入器锁（`injector.lock`）。
- 连接用 Node 22 内置 `WebSocket` 即可（实测无需 `Origin` 头）。若官方某版本改为强制校验 Origin 并返回 403，回落方案是改用 `ws` 包补 `Origin: http://127.0.0.1:<port>`（仓库 devDeps 已有 `ws`）。

### 3.3 目标页判定

```
必须同时满足：
  1) target.type === "page"
  2) url 以 "file://" 开头
  3) url 路径部分包含 "/Contents/Resources/app.asar/renderer/index.html"
  4) 忽略 query string（实测带 ?locale=…&accountSnapshot=…）
```

**安全与隐私硬规则**：query 里含用户账号快照（uid、昵称）。因此
- 日志、错误信息、UI 提示**一律不得打印完整 target URL**，只允许打印 `origin + pathname`；
- 身份校验失败时只报"目标页面不符合预期"，不回显 URL 内容。

多个 page 同时存在时（未来多窗口），只处理**第一个匹配**并记一条日志；不批量注入。

---

## 4. DOM 契约

沿用 `host-adapter.md` 的 v1 DOM 契约，节点命名与属性完全一致，便于共用运行时：

| 节点 / 属性 | 说明 |
|---|---|
| `#beauticode-bg-stage` | 全视口舞台，`position: fixed; inset: 0; z-index: 0; pointer-events: none`，插入 `body` 的**第一个子节点**（实测该位置能正确落在应用内容之下） |
| `#beauticode-bg-stage > img` | 静帧层，`object-fit: cover` |
| `#beauticode-bg-stage > video` | 视频层，`object-fit: cover`，`muted/loop/playsinline` |
| `#beauticode-bg-stage::after` | 对比度纱层，透明度由 `--bc-scrim` 控制 |
| `html[data-bc-active]` | `true` 表示已应用背景 |
| `html[data-bc-media]` | `image` / `video` / `video-pending` |
| `html[data-bc-video-ready]` | `true` / `false` |
| `html[data-bc-generation]` | 十进制 generation |
| `html[data-bc-fish]` | 摸鱼模式（隐藏 `#root`） |
| `html[data-bc-tone]` | 背景明暗倾向 |

约定：舞台与媒体**永远 `pointer-events: none`**；不重写宿主的组件圆角、边框、阴影；不引入横向溢出。

---

## 5. CSS 契约（本文的核心）

### 5.1 已实测的层结构

覆盖率＝该元素面积 / 视口面积（1470×919）。颜色来源是用 `document.styleSheets` 逐条规则 `el.matches()` 匹配出来的，不是推测。

| 覆盖率 | 选择器 | 颜色来源 | 类型 |
|---|---|---|---|
| 100% | `.teams-container` | `background: var(--wb-home-bg-primary)` | 外壳底，**透明** |
| 77% | `.conversation-shell` | `background: var(--wb-home-bg-secondary, #fafafa)` | 会话主区，**透明** |
| 18% | `.conversation-list` | `background: var(--wb-sidebar-bg)` | 侧栏，**透明** |
| 18% | `[class*="_gridViewItem_"]`（如 `_gridViewItem_1rywu_14`） | `background: var(--wb-home-bg-primary)` | 侧栏视图项，**透明**。**CSS Module 生成类名，只能前缀匹配** |
| 12.2% | `.cr-code-like-box` | `var(--cr-bg-primary)` | 代码块，**半透 82%**（M1） |
| 7.5% | `.cr-input-container` | `var(--cr-bg-elevated)` | 输入区，**半透 70% + 模糊**，见 §5.3 |
| 7.1% | `.cr-tool-exp__content` | `var(--cr-bg-primary-default, #2a2c31)` | 工具卡，**半透 82%**（M1） |
| 6.9% | `.cr-self-bubble` | `var(--cr-user-bubble-bg)` | 用户气泡，**暂保持不透明**（M1 验收时再定） |
| 23.5% | `.cr-widget-card` | `var(--cr-bg-primary)` | 组件卡，**暂保持不透明**（M1 验收时再定） |

注意两点：
1. 存在**两套 token**：`--wb-*`（应用外壳）与 `--cr-*`（对话渲染层）。`--cr-*` 的兜底值偏深色（`#2a2c31`），说明它按"深色优先"设计，覆盖时要分别对待，不能只改一套。
2. 类名是**混搭**的：大部分是可读语义名（`.teams-container`、`.conversation-shell`、`.cr-*`），少部分是 CSS Module 的 hash 类（`_gridViewItem_1rywu_14`）——后者只能用 `[class*="_gridViewItem_"]` 这种前缀匹配，天然脆弱，要按"官方一升级就可能失效"来设计。

### 5.2 风格规则：壁纸区透明 / 浮层统一 α / 每个分组只有一层

**决定（2026-09-18，用户报"风格混乱"后定稿）**：不再逐层拍数，改用一条可验证的规则。

| 层类 | 处理 | 选择器 |
|---|---|---|
| **壁纸区**（外壳、会话主区、中央视图、侧栏列表体） | **透明** | `BACKDROP_SELECTORS`（10 个） |
| **浮层**（侧栏面板、输入区、代码块、工具卡、组件卡、气泡、右侧产出卡片） | **统一半透 α** | `SURFACE_RULES`（7 条，各自带 token） |
| **浮层内部子面**（卡片 header/body/diff 容器、输入区工具栏与模型选项、右侧面板内部） | **透明**（压平） | `FLATTEN_SELECTORS` + `SIDEBAR_FLATTEN_SELECTORS` |
| **语义色**（diff 增删行） | **保持实心** | `SEMANTIC_TINT_SELECTORS`（故意不压平） |

```css
:root { --bc-surface-alpha: 0.82; --bc-scrim: <按主题>; }

/* 1) 壁纸区 */
.teams-container, .conversation-shell, .conversation-list, … { background-color: transparent !important; }

/* 2) 浮层：颜色从各自的官方 token 派生，透明度共用一个变量；显式关掉磨砂 */
.teams-container [data-view-id="sidebar"],
.cr-input-container, .cr-code-like-box, .cr-tool-exp__content,
.cr-widget-card, .cr-self-bubble, .artifact-slot-panel__card {
  background-color: color-mix(in srgb, var(<各自的 token>) calc(var(--bc-surface-alpha) * 100%), transparent) !important;
  backdrop-filter: none !important;
}

/* 3) 浮层内部压平，保证一个分组只有一层 α */
.cr-code-like-box__header, [class*="cr-input-toolbar"], .artifact-slot-panel__grid, … { background-color: transparent !important; }
```

**为什么必须"一层 α"**：α 是叠乘的。父 0.82 + 子 0.82 ⇒ 实际 ≈ 0.97，看上去就是实心 ——
这正是用户看到的那句「输入框是半透明，但输入框里的模型选项完全不透明」的成因。
**容器透、内容不透 = 视觉上等于没透。**

**两个必须踩过的坑**：
1. **token 不能共用**：`.cr-code-like-box` 读 `--cr-bg-primary`，`.cr-tool-exp__content` 读 `--cr-bg-primary-default`（兜底 `#2a2c31`，深色）。共用会串色。
2. **特异性**：官方给侧栏内部小面用的是**复合类选择器**（如 `._card_914ll_1.cb-agent-card` = 两个 class），
   单属性选择器压不住。解法是给压平规则带上侧栏前缀，把特异性抬到 (0,3,0)：
   `.teams-container [data-view-id="sidebar"] [class*="cb-agent-card"]`。

**同时去掉磨砂**：用户明确要求不加磨砂玻璃，所以 `backdrop-filter: none !important` 是**显式**写出的 ——
不是"我们没加"，而是"官方改版也加不回来"。

**可验证的不变量**（已做成脚本）：半透明元素的 α 取值集合必须**只有一个值**，且**任何带 α 的元素不得有同为 α 的祖先**。
实测结果：14 个半透明元素、α 集合 `[0.82]`、叠加违规 **0 处**、壁纸可见度 **100%**。

### 5.3 为什么 α 定在 0.82

- 它原本就是内容卡（代码块/工具卡）能接受的值，推广到全局即可**保住已经验收过的观感**，不需要重新调。
- 低于 ~0.7 时，浅色主题下的代码文字在中间调壁纸上会明显掉对比度。
- 输入区此前是 0.70 + 磨砂；改成 0.82 且无磨砂后**反而更清晰**（磨砂只是把背景糊掉，不能提升对比度）。
- 与前几轮"不做全透"的结论一致：输入区仍留有可读性余量。

### 5.4 对比度纱层（scrim）

舞台自带一层 `::after`，透明度由 `--bc-scrim` 控制，**按当前主题派生**：

| 主题（`html` 的 class） | `--bc-scrim` 建议初值 | 说明 |
|---|---|---|
| `dark` | `0.28` | 深色主题下把壁纸压暗，保证浅色文字可读 |
| `light` | `0.12` | 浅色主题只需极轻的纱 |

初值是起点不是定论，M1 验收时按真实壁纸逐张调。若壁纸本身极亮或极暗，允许按主题再乘一个"壁纸亮度自适应"系数（M3）。

### 5.5 实现细节：`color-mix` 的取值形态会影响 verify

半透明层用 `color-mix(in srgb, var(--token) N%, transparent)` 从官方 token 派生，
好处是官方切主题时自动跟着变。**但它算出来的 `backgroundColor` 不是 `rgba(...)`，而是 `color(srgb 1 1 1 / 0.7)` 形态**（实测）。

后果：verify / 自检里所有"读 alpha 判断是否不透明"的代码，**必须同时支持 `rgb()/rgba()` 与 `color()` 两种函数形态**，
否则会把半透明层误判为"解析不出来"（当前诊断脚本就踩了这个坑，`.cr-code-like-box` 报 `alpha=null`）。

已实测的取值对照（浅色主题）：

| 层 | 计算值 | 期望 |
|---|---|---|
| 大面（`.teams-container` 等） | `rgba(0,0,0,0)` | alpha 0 |
| 输入区 | `color(srgb 1 1 1 / 0.7)` | alpha 0.7 + `blur(10px)` |
| 工具卡 | `color(srgb 0.949 0.949 0.949 / 0.82)` | alpha 0.82 |
| 气泡（M1 未改） | `rgb(242,242,242)` | alpha 1 |

---

### 5.6 装饰性渐隐遮罩（用户报的"刘海"）

官方在消息列表底部放了一个滚动提示遮罩，实测：

| 项 | 实测值 |
|---|---|
| 选择器 | `.cr-message-list__bottom-mask` |
| 尺寸 / 位置 | 832×72，`position: absolute; z-index: 1`，贴在消息列表底边 |
| 实现 | `background-image: linear-gradient(rgba(0,0,0,0), <主题实色>)`；滚动时淡入（`opacity` 0→1） |
| 问题 | 渐变末端是**主题实色**（浅色主题＝白、深色主题＝近黑）。盖在壁纸上就是一条硬色带，与媒体无法融合。它不属于 §5.2 的"透明度"范畴 —— 它本身就是一块实色 |

处理：**有背景时关掉**（与 DSH 侧「会话列表 fade 在有壁纸时关掉，避免叠出一条暗影」的既有决定一致）。

```css
.cr-message-list__bottom-mask,
.cr-message-list__top-mask,
[class*="message-list__"][class*="mask"] {
  display: none !important;
}
```

后两条是**防官方改名的兜底**，但仍限定在 `message-list__` 前缀内，不误伤其他遮罩。

备选方案（想保留"下面还有内容"的提示时用）：把渐变末端换成半透明暗纱，
`linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.30))`（深色主题 `.55`）配 `backdrop-filter: blur(2px)`。
两种方案都实测可切换。

**推广到一类问题**：官方凡是"用主题实色画的装饰层"（渐隐、暗影、压边），在壁纸下都会变成硬色带。
M1 需要一条通用自查：扫描**全宽/全高的不透明装饰层**（渐变或实色、`position: absolute/fixed`、
贴在容器边缘），逐一决定"关掉 / 改成半透明纱"。§5.5 只是第一个样本。

---

### 5.7 token 层统一 —— 全量统一（含所有弹窗）靠的是这一层

逐条覆盖选择器不可行：实测全应用有 **2370 条**规则在写背景，分布在 **4 套 token 家族**里
（`--wb-*` 外壳、`--cb-*` 旧聊天层、`--cr-*` 对话渲染层、`--sk-*` 内嵌子应用）。
所以统一**在 token 层完成**——和官方皮肤机制用的是同一套办法，因此安全：
我们把覆盖挂在与官方相同的主题选择器上，切主题时命中的是**对应主题的那一块**，而不是跟它抢值。

**最终架构：两套机制，职责不重叠**

| 机制 | 负责 | 位置 |
|---|---|---|
| **token 覆盖层** | 所有**宿主 token** 驱动的面（含我们没见过的功能页、弹窗、浮层） | `token-overlay.ts` |
| **钉住的 surface 规则** | 我们**实测过的**那几个面，从**我们自己的不透明基色**派生 | `contract.ts` 的 `SURFACE_RULES` |
| **硬编码中立化** | 宿主用**字面颜色**写死的面（token 层够不到） | `token-overlay.ts` 的 `HARDCODED_SURFACE_*` |
| **压平 / 背板透明 / 遮罩 / 舞台** | token 表达不了的部分 | `contract.ts` |

**关键：两套机制绝不能叠加。** 钉住的规则从 `--bc-surface-base`（我们自己按主题设的不透明基色）派生，
**不引用任何宿主 token** —— 这样即使 token 层也覆盖了同一个面，也不会变成 `0.82 × 0.82 ≈ 0.67`。

**流程**（页面内扫描 + 纯函数生成）：

1. **扫描**：收集宿主声明的全部自定义属性名，逐个取**当前主题下的计算值**。
2. **按主题分桶再解析**：声明按选择器分成 light / dark / neutral 三桶，当前主题优先取本主题桶，
   再回落到 neutral（`:root`/`body`），最后回落到计算值。
   ⚠️ `--cr-*` 是**深色优先**的：它的 `:root` 声明是深色值，浅色主题下只按"选择器里有没有 dark"判断会把深色值用到浅色上（实测把 `--cr-bg-primary` 写成 `color-mix(#1a1b1e …)`）。
3. **必须带 `!important`**：宿主在更内层的作用域重定义了同名 token，
   不带 `!important` 的 `html:root` 覆盖在元素上会被压过 ——
   实测表现为"在 `:root` 读是半透的、在元素上是纯白"，输入框因此一直是实心。
4. **只覆盖本来不透明的值**（α ≥ 0.95）；本来就是半透的（悬停蒙层、5% 洗色）保持原样。
5. **`hover/active/selected` 类 token 也要覆盖**：宿主把 `--wb-bg-hover-light` 当作真实面板的**静止底色**用
   （实测于 `.artifact-slot-panel__card`），排除它会让右侧面板一直是实心。悬停色渲染成半透仍读得出是悬停色。
6. **频率**：只生成**当前主题**的一块；主题切换时重新扫描生成（复用既有的 reapply 路径），
   比同时烘两块更不容易取错基值。
7. **硬编码面按"饱和度"筛**：字面颜色里**近中性**（chroma ≤ 24）的当作面板底色，改写成我们基色的半透版本；
   **高饱和**的（按钮、品牌色、分类色、二维码、终端黑）一律保留 —— 中立化会毁掉它们的含义。
   当前数据：50 个中性面被中立化，6 个饱和面保留。

**四条一定要记住的坑（都是实测踩出来的）**

1. **同一件事必须同时生成浅/深两套值**，并且都用宿主自己的主题选择器键控
   （`html:root` / `html:root.dark,html.cb-dark,body[data-theme="dark"]`）。
   只按"注入时是什么主题"烘一套，会导致**切深色以后背景不变、文字却变白**（白底白字）。
   两套同时存在 = 切主题不需要重新注入。
2. **token 覆盖必须带 `!important`**：宿主在更内层的作用域重定义同名 token，
   不带 `!important` 的 `html:root` 声明在元素上会被压过 —— 现象是"在根上读是半透、在元素上是纯白"。
3. **我们的样式必须始终排在 `<head>` 末尾**：实测 `<head>` 有 **328 个子节点**，
   我们第一次注入的样式排在第 230 位，**后面还压着 97 个节点（含宿主的外部 `<link rel=stylesheet>`）**。
   同权重同 `!important` 时**后者胜**，于是宿主在运行期把层叠权悄悄收了回去 ——
   这是"注入明明在，功能页却还是实心"的真正原因。用 `buildStyleKeeperExpression()` 挂一个
   `MutationObserver` 盯着 `<head>`，只在真有样式表落到我们后面时才把我们的节点搬到最后（因此不会自激循环）。
4. **扫描必须忽略我们自己的样式表**（id 以 `beauticode` 开头）。
   否则第二次应用会把上一轮写的覆盖层当成宿主声明读进来，对 `color-mix` 再混一次 →
   **每次应用结果都不一样**（实测深色块解析数在 814 / 561 之间漂移）。

**实测**（WorkBuddy 5.5.6 / Chromium 138）：

| 指标 | 结果 |
|---|---|
| 扫出的面 token | **861** 个（深色块解析出 827 个） |
| 生成的覆盖层 | **~88 KB**（α = 0.82，浅 + 深两块） |
| 重复应用 | **幂等**（两次扫描结果一致） |
| 半透明元素的 α 取值集合 | **`[0.82]`** |
| 嵌套叠加违规 | **0 处** |
| 壁纸可见度 | **100%** |
| 深色切换 | **已验证**：输入框/气泡/右侧卡片从 `color(srgb 1 1 1 / .82)` 变为 `color(srgb .1216 .1216 .1216 / .82)`；`--wb-bg-primary` → `#1f1f1f`、`--vscode-editor-background` → `#181818`、`--cr-bg-elevated` → `#242629` |

**技术边界（这条要如实说）**：如果某个页面的背景是
① 用**内联 `!important`** 写在元素上、② 由 `<canvas>` / PDF / WebGL 自己绘制、
③ 位于**独立的 webview/iframe**（实测当前只有 1 个主框架，另有一个 0×0 的 `.space-panel-iframe`），
那么 CSS 注入确实改不动它 —— 这三种情况需要单独手段（JS 清内联属性 / 扩展注入到子框架）。
除此之外，凡是由 CSS 画的面都能统一。

---

## 6. 主题切换与重挂（必须做，否则会被官方踩）

用户在官方外观里切浅色 / 深色，会重写 `html` 的 class 与那批变量。一次性注入的覆盖会被冲掉或出现对比度事故。因此：

| 触发源 | 监听方式 | 动作 |
|---|---|---|
| 主题切换 | `MutationObserver` 盯 `document.documentElement` 的 `class` 属性（**去抖 160 ms**） | 重算 `--bc-scrim`，重新断言透明规则 |
| 皮肤切换 | 同一 observer 顺带盯 `data-skin` | 同上 |
| 页面 reload | CDP `Page.loadEventFired` | 重新注入 |
| 宿主重启 | 注入器轮询 + 重连 | 同上 |
| 路由 / 会话切换 | —— | **不做**（实测不需要，见 §6.3） |

### 6.1 主题切换实测（2026-09-18，被动监视）

用户在 16 秒内连切 7 次浅色 ↔ 深色，全程记录：

| 观察 | 数据 | 结论 |
|---|---|---|
| 注入物是否被冲掉 | 每条事件的 `presence` 都是 `{stage: true, styles: 3}`，**一次 `presence.changed` 都没有** | **主题切换不会擦掉注入**，透明规则用 `!important` 单点断言即可存活 |
| 一次切换触发几次 class 变更 | **6 次以上**，且首尾各有一个过渡态 | observer **必须去抖**，否则一次切换会重做 6 次无用功。建议 **160 ms** |
| 过渡态长什么样 | 中间态是 `theme-switching dark cb-dark vscode-dark`（多一个 `theme-switching` 类），终态是 `dark cb-dark vscode-dark` | `readTheme()` 按 token 列表解析，**过渡态也能正确读出 dark/light**，不需要特殊处理；但不要用"class 字符串全等"来判断主题 |
| 一次切换的实际耗时 | 约 4~5 秒后才稳定（21:05:38 起切、21:05:54 才停） | 去抖窗口不要贪大，否则观感滞后又浪费；160ms 足够 |

### 6.2 URL 只能记指纹，不能记原文

`query` 里带账号快照（uid / 昵称），**任何日志、报错、UI 提示都不得出现完整 URL**。
需要判断"URL 变没变"时，记**指纹**：`pathname 尾段 + query 长度 + query 短哈希 + hash`。

实测确实存在会改动 URL 的操作（早期观察到 2 次 `route.changed`，变化发生在 query 内部），
但**切换会话不属于其中之一**（见 §6.3）。所以指纹只作为诊断信息保留，不作为重挂触发条件。

### 6.3 会话切换实测（2026-09-18，被动监视）——结论：**不需要为它做任何事**

用户连点多个会话，15 分钟内记录到 **12 次 `view.changed`**（正文哈希在 `63836213` / `17d15022` / `f2659ae0` / `ab2c0c0e` 之间反复变化，气泡数 3↔4↔7 波动）：

| 观察 | 数据 | 结论 |
|---|---|---|
| 注入物是否被擦掉 | 12 次切换，**每一次 `presence` 都是 `{stage: true, styles: 3}`**，`presence.changed` **零次** | ✅ 切会话完全安全 |
| URL 有没有变 | `route.changed` **零次** | ⚠️ **切会话根本不动 URL** → 靠 `popstate` / `hashchange` / 路由签名触发重挂是**无效设计**，已从方案里删掉 |
| 为什么这么稳 | 舞台是 `body` 的直接子节点、样式在 `head`，**都在 React 的树之外** | 根因：**我们把注入物挂在 React 之外**，所以 SPA 重渲染碰不到它。这是本适配最省事的一条设计属性，必须守住 |

**据此收敛的重挂策略**：

| 触发源 | 监听方式 | 动作 |
|---|---|---|
| 主题 / 皮肤切换 | `MutationObserver` 盯 `documentElement.class` / `data-skin`，**去抖 160 ms** | 重算 `--bc-scrim`，重新断言透明规则 |
| 页面 reload | CDP `Page.loadEventFired` | 重新注入 |
| 宿主重启 / CDP 断开 | 注入器轮询 + 重连 | 重新注入 |
| 节点被意外移除 | 注入器侧 1 s 轻量巡检（读 `data-bc-active` 与舞台是否存在） | 重新注入 |
| ~~路由 / 会话切换~~ | —— | **不做**。实测不需要（且 URL 也不变） |

"当前看哪个会话"的指纹（用于诊断，不用于触发）：`selIdx`（侧栏选中项下标）+
`.cr-document` 数 + 气泡数 + 消息列表正文哈希。注意**侧栏选中态没有 `active/selected` 类名**
（实测 `selIdx` 恒为 -1），选中判定需要另找类名或属性；气泡数会抖动（3↔7），
**只有正文哈希是可靠信号**。

**fail closed**：认不出结构（例如选择器全部落空、`#root` 不存在、`<html>` 上既无 `dark` 也无 `light`）时，
**什么都不做**并回报明确错误，不静默降级、不假装成功。

---

## 7. 媒体传输

| 媒体 | 传输方式 | 备注 |
|---|---|---|
| 图片 | **优先 `file://` 绝对路径直引** | 已实测可行，无体积上限（6.2 MB 走通）。须 URL 编码空格/中文/`#` |
| 图片回落 | `data:` URL 或 `DOM.setFileInputFiles` → blob | 仅当页面 CSP 或后续版本阻止 `file://` 时启用 |
| 视频 | **优先 `file://` 直引** | 待实测（§11）。`mp4` / `mov` |
| 视频回落 | `DOM.setFileInputFiles` → blob（沿用 Codex 路径） | 大文件上限仍按 `payload.ts` 的既有常量 |

**不复制素材**：默认用 `source: "local"`（直接引用用户原文件），与 Codex 路径的 `managed` 策略区分。
需要写进 beautiCode 自己数据根的，只有 manifest / 快照 / 受管素材；**绝不写进 `~/.workbuddy`**。

---

## 8. 生效与校验（verify 判据）

WorkBuddy 有真实回读通道（CDP + 页面内状态），所以**保留 `host-adapter.md` 的 live verify 主干**，不做降级。

| 变更类型 | pass 条件 |
|---|---|
| 图片 | 舞台存在且覆盖视口；`img.complete && naturalWidth > 0`；`documentElement.scrollWidth - innerWidth <= 1`；**可见度抽样 ≥ 60%** |
| 视频 | 上面全部成立，且 `video.readyState >= 2 && !video.paused`、`data-bc-video-ready="true"`、generation 一致 |
| 清空 | 舞台移除、`data-bc-active` 移除、可见度抽样回到基线 |

**可见度抽样**：在视口上打 11×7 网格，每个点取 `document.elementsFromPoint`，判断是否存在不透明遮挡层。
口径坑（已踩过）：`body` 与 `html` 自身的背景画在子元素**之下**（也就画在舞台之下），**必须排除**，否则会误报 100% 被遮挡。

硬失败 → 回滚（磁盘快照 + 重新 apply 旧 generation），与 Codex 路径一致。

---

## 9. 能力位

| 能力 | 值 | 依据 |
|---|---|---|
| `image` | ✅ | 已实测 |
| `video` | ✅（M2） | 结构支持；`file://` + 自动播放待实测 |
| `clear` | ✅ | — |
| `reapply` | ✅ | 与 watch/重挂同一机制 |
| `savedThemes` | ✅ | 复用 core 的 saved store |
| `fish`（摸鱼） | ✅ | 实测 `#root` 存在，隐藏它即可，与 DSH 的做法一致 |
| `muted`（背景视频静音） | ✅ | 我们自己创建的 `<video>` 可控 |
| `tone` | ✅ | 由 `--bc-scrim` 承载 |

---

## 10. 安全边界

沿用 [`security-boundaries.md`](./security-boundaries.md)，WorkBuddy 额外三条：

1. **不碰官方皮肤目录**：`~/.workbuddy/appearance-resources/` 一律只读不写（那是官方托管、会被 LRU 回收的目录）。这也是选路线 B 而不是路线 A 的理由之一。
2. **日志脱敏**：target URL 的 query 含账号快照，只准记录 `origin + pathname`（§3.3）。
3. **可逆与可识别**：注入物一律带 `beauticode-` 前缀 / `data-bc-*` 标记；提供 `clean` 路径一次性还原（移除样式、舞台、全部 `data-bc-*` 属性）。调试端口是"同机任何进程都能完全控制这个窗口"的入口，beautiCode 必须做到"能进也能干净地退"。

---

## 11. 待实测清单（M1/M2 的开工前提）

- [x] **视频**：`file://` 直引 + 自动播放 → 已验（§1 第 12/13 条）。M2 只需补播放进度与重挂恢复。
- [ ] **重挂**：切会话 / 路由切换（安全，界面不重载）后注入是否被擦除、能否自动重挂。
- [ ] **重挂（整页 reload）**：重载 renderer 后自动重挂；此步会让界面重载一次，最后单独做。
- [ ] **主题切换**：浅色 ↔ 深色来回切，透明规则与 scrim 是否被冲掉。
- [x] **多窗口**：当前 `/json/list` 只有 1 个 page target（2 个 iframe 不算）；多窗口留待出现时再处理。
- [x] **结构漂移自检**：自检命令雏形已完成，7 个锚点全部命中（§1 第 14 条）。M1 搬进仓库并接入 fail-closed。
- [ ] **输入区可读性**：70% 下限在浅色壁纸 + 浅色主题下是否够用。
- [ ] **卡片半透**：内容卡（`.cr-widget-card` / `.cr-code-like-box` / `.cr-tool-exp__content` / `.cr-self-bubble`）半透后的对比度验收。

---

## 12. 里程碑

- **M1 · 图片链打通**：启动脚本 → target 判定 → 注入 → 透明契约 + scrim → verify → clean；`docs` 与本文件同步更新。
- **M2 · 视频**：`file://` 直引、自动播放策略、播放进度、重挂后恢复。
- **M3 · 打磨**：卡片/气泡半透、壁纸亮度自适应、自检命令、结构漂移的 fail-closed 报错文案。

---

## 13. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-18 | 初稿。基于当日实测（端口机制、target、`file://` 素材、注入落地、图层与颜色溯源）。决定：规则 B（官方管色 / 我们管透明度与对比度）、大面透明 + 输入区半透（≥70% 地板）、图片与视频同版推进。 |
| 2026-09-18 | 补 A1/A5/A6 实测：视频 `file://` 直引 + 自动播放已验（含非静音情形）、多窗口确认为单 page、契约锚点自检 7/7 通过。§1 增第 12–14 条，§11 改为勾选清单。 |
| 2026-09-18 | 新增 §5.6：装饰性渐隐遮罩（`.cr-message-list__bottom-mask`）实测与处理（有背景时 `display:none`，备选半透明纱），并推广为"主题实色装饰层"这一类问题的自查项。 |
| 2026-09-18 | 卡片半透进 M1（用户决定）：代码块 + 工具卡 82%，各用各自 token；气泡与组件卡留到验收。新增 §5.5 记录 `color-mix` 取值形态（`color(srgb …)`）对 verify 的影响。修复 macOS 软链接守卫（系统前缀别名放行，真软链接仍拒）。 |
| 2026-09-18 | **风格统一（用户报"混乱"后定稿）**：§5.2 改为三层规则（壁纸区透明 / 浮层统一 α=0.82 / 分组只有一层 α），并去磨砂；§5.3 改为 α 取值依据。契约模块重写：`BACKDROP_SELECTORS` / `SURFACE_RULES`(7) / `FLATTEN_SELECTORS` / `SIDEBAR_FLATTEN_SELECTORS` / `SEMANTIC_TINT_SELECTORS`。实测：α 集合 `[0.82]`、叠加违规 0、壁纸可见度 100%、单测 16/16。 |
| 2026-09-18 | **全量统一（含所有弹窗）**：新增 §5.7 与 `src/token-overlay.ts` / `src/color.ts`。改为在 token 层统一（412 个面 token、28 KB 覆盖层），关键点是**别名链回溯**（`--wb-bg-primary: var(--wb-palette-white-100)`）与**特异性抬升**（`html:root`）。设置弹窗从实心（占视口 63%，压得壁纸可见度 18%）变为半透明，可见度回到 100%。排除 `fg`/`foreground` 等前景 token（由单测守住）。单测 22/22。 |
| 2026-09-18 | **修三处架构缺陷，定为最终双机制**：(1) 契约里的 `calc(var(--α) * 100%)` 被 Chromium 判为无效 → 改成字面百分比；(2) token 覆盖缺 `!important`，被宿主内层定义压过（表现为"根上半透、元素上纯白"，输入框一直实心）；(3) `--cr-*` 深色优先，按选择器判色会把深色值用到浅色主题 → 改为**按当前主题分桶（light/dark/neutral）优先取本主题**。同时把 `hover/active` 类 token 纳入覆盖（宿主拿它当面板静止底色用），并新增**硬编码中性面中立化**（按饱和度筛，50 个中立化 / 6 个保留）。面 token 从 412 → **847**，覆盖层 46 KB；半透明元素 12 → **28**，α 集合仍 `[0.82]`，叠加违规 0。单测 22/22。 |
| 2026-09-18 | **修"深色切换白底白字"与"功能页仍实心"**：(1) 主题相关值改为**浅/深两套同时生成**（只烘一套会导致切深色后背景不变、文字变白）；(2) 新增**样式看门狗**把我们的样式钉在 `<head>` 末尾（实测 head 有 328 子节点、97 个在我们之后含外部样式表，同权重后者胜 → 这是功能页仍实心的真因）；(3) 扫描**忽略自己的样式表**，消除重复应用的漂移（深色块解析数曾在 814/561 间跳），现两次应用幂等。面 token 861、覆盖层 ~88 KB、深色切换已实测通过。单测 **25/25**。 |
| 2026-09-18 | **侧栏背景栏功能落地（M1 末尾，demo 级）**：新增 §14 与 `src/background-bar.ts`。在 `.conversation-list-tabs` 末尾追加「自定义背景」条目 + 「背景清单」面板（方向 C 媒体清单），含 4 个动作（导入图片 / 导入视频 / 视频声音 / 透明度 LOCKED）+ 清除/收起。**透明度不是开关**——常开、不可关，理由是关掉它背景就被自己的界面盖住。**选择器是 CDP 探查的实际 DOM（`.conversation-list-tabs` / `.conversation-list-tab-button`），不是 asar 推断的 `cb-sidebar-nav`**——asar 里那个组件当前视图不渲染，用它做选择器会一直 no-nav-found。改用真实类名，跨版本稳定。暴露 `BACKGROUND_BAR_INJECTION` / `BACKGROUND_BAR_CLEANUP` / `BACKGROUND_BAR_STYLE_ID` 三个导出。`tsc --noEmit` 通过；适配器 25/25 单测不变；CDP 实跑注入 `'ok'`、tabsChildren 从 7 增到 8。**不持久化、不接 CDN、不接受管素材策略**（M3 才做）。 |
| 2026-09-18 | **CDP runner 守护版落地**：`scripts/wb-cdp-runner.mjs`（约 230 行），从 `@beauticode/adapter-workbuddy` import 同一份 `BACKGROUND_BAR_INJECTION` 载荷，常驻：注入后挂着、1.5 s 轮询守护（SPA 切路由自动重发）、订阅 `Page.loadEventFired` 整页 reload 立即重发、SIGINT/SIGTERM 触发 `BACKGROUND_BAR_CLEANUP` 后退 0。支持 `--once` / `--clean` / `--port` / `--verbose` / `--help`。import 双路径兜底（workspace 名优先，fallback 到相对 `../packages/adapter-workbuddy/dist/index.js`）。URL 脱敏、错误码齐全、JSON-RPC 标准。**已实跑验证**：tsc 干净、25/25 单测不变、payload / cleanup 用 `new Function()` 解析均合法、在你的 WorkBuddy 5.5.6 上 CDP 实跑注入返回 `'ok'`、tabsChildren 从 7 增到 8、守护跑起来后 SPA 切路由自动重发。 |

## 14. 侧栏背景栏功能（背景清单面板）

> 这是 adapter 暴露的**功能块**之一：拿到 `BACKGROUND_BAR_INJECTION` 这个字符串，
> 通过 `Runtime.evaluate({ expression: payload, awaitPromise: true })` 送进 renderer，
> 即可在最左侧侧栏追加「自定义背景」选项 + 「背景清单」面板。
> 仍是 demo 级，**不持久化**、**不接 CDN**、**不接受管素材策略**；先跑通这条注入链。

### 14.1 入口与面板

按已批准的设计语言（方向 C「媒体清单」，见 `design-demos/dsh-background-bar/direction-c-media-ledger.html`）
渲染「背景清单」面板：

| 编号 | 动作 | 说明 |
|---|---|---|
| 01 | 导入图片 | png/jpg/webp/gif；走 `URL.createObjectURL(blob)`，写到 `#beauticode-bg-stage` 的 `background-image` |
| 02 | 导入视频 | mp4/mov/webm；走 `<video muted loop playsinline>`，**默认静音**绕开自动播放策略 |
| 03 | 背景视频声音 | 开关；控制 `<video>.muted` |
| 04 | 面板透明度 | **常开 · 不可关**（标 LOCKED）。关掉它，背景就被自己的界面盖住，等于没这功能 |
| 清除背景 | 释放 blob + 清 `background-image` + 卸 `<video>` | |
| 收起面板 | 隐藏面板、移除条目的选中态 | |

### 14.2 选用的真实钩子（来自 CDP 探查，**不是 asar 推断**）

asar 里 `cb-sidebar-nav`（§5.7 提到的那个组件，52 条规则全在）**当前视图不挂载**，
写它做选择器会一直 `no-nav-found`。实测：2026-09-18 探查 WorkBuddy 5.5.6 实际 DOM 得到：

- **侧栏根**：`.conversation-sidebar`（264×919）→ `.conversation-list`
- **选项容器**：`.conversation-list-tabs`
- **单个选项**：`<button class="conversation-list-tab-button conversation-list-tab-button-box">`
  （语义类名，跨版本稳定；asar 里那个 `cb-sidebar-nav__item` hash 类不稳）
- **文本节点**：`<span class="conversation-list-tab-button-label">…</span>`
- **#beauticode-bg-stage**：与 §4 DOM 契约一致，固定 `position:fixed; inset:0; z-index:0;
  pointer-events:none`，并 `body.insertBefore(stage, body.firstChild)`（位置错 → 盖全页）。

**再次强调：asar 静态分析 ≠ 运行时 DOM。asar 看代码有 `cb-sidebar-nav`，但运行时按路由/视图挂载
的子树不一样。** 写注入前必须先 CDP 探查真实 DOM。这一条已经踩过一次坑。

### 14.3 暴露的导出（`packages/adapter-workbuddy/src/background-bar.ts`）

| 名称 | 类型 | 用途 |
|---|---|---|
| `BACKGROUND_BAR_STYLE_ID` | `string = 'beauticode-workbuddy-bg'` | 全部注入节点的 `data-bc-injected` 值 |
| `BACKGROUND_BAR_INJECTION` | `string`（≈8.7 KB IIFE） | 送进 `Runtime.evaluate` 的载荷；幂等；fail closed |
| `BACKGROUND_BAR_CLEANUP` | `string` | 一行清理命令（任何 console 都能跑），也可由 runner 触发 |

### 14.4 注入的约束（与 §10 安全边界一致）

- 找不到 `.cb-sidebar-nav` → 返回 `'no-nav-found'`，不注入、不留垃圾
- 所有新增节点带 `data-bc-injected="beauticode-workbuddy-bg"`，可一键 `remove`
- 不写 `~/.workbuddy/`、不调用任何 WorkBuddy 私有协议
- 不接管 app 自身的设置页 / 主题切换
- 视频**默认静音**，遵循 Chromium 自动播放策略

### 14.5 已知限制（与 M2/M3 的边界）

- 切会话 / 路由切换 / 主题切换后**不重挂**（方向 C 的面板是吸附在 nav 上、nav 在 SPA 树内）。
  路由切换会重新渲染 nav，本次注入节点会丢，需要 runner 在 SPA 路由变化后重发。
  WorkBuddy 的会话切换不会改 URL（实测 §6.3），靠正文哈希等指纹判断要不要重发。
- 不做持久化：刷新页面背景就回到默认。**这条要等 M3 再做**（写到 `~/.beauticode/...`，
  与 WorkBuddy 的 `~/.workbuddy/app` 完全分开）。
- 不接入主题列表 / 资源中心 / 受管素材策略。

---

## 15. 故障取证：「适配之后模型不响应」到底是谁的问题（2026-09-20 结案）

用户报告：beautiCode 的 WorkBuddy 适配生效后，「对话大模型不响应」。逐层查完，
结论是**与注入无关**，两件事叠加造成了这个观感：

1. **上游偶发尖峰**：`POST https://copilot.tencent.com/v2/chat/completions` 的
   首字延迟（TTFT）平时 p50 ≈ 2.6s，尖峰可到 **24.2s / 16.5s**。用户等到 ~15s
   按了「停止」，看起来就是「模型不响应」。
2. **取消之后宿主前端状态没恢复**：`.cr-send-button` 持续 `disabled`、
   `.cr-cancelled-indicator`（「用户已取消」）一直挂着 —— 于是「发不出消息」
   比「模型慢」更像故障。

### 15.1 证据链（全部可复跑）

| 观察 | 证据 | 说明 |
|---|---|---|
| 请求确实发出去了 | worker 日志 `[ModelProvider] Sending request: agent=cli, model=…, url=https://copilot.tencent.com/v2/chat/completions` | 16:52:47.515 |
| 上游 15.7s 内一个字没出 | 同一 requestId 之后只有 `Request failed: … error=canceled` | `InterruptionService elapsed=15757ms` |
| 同刻后台请求 TTFT=24.2s | `First raw chunk received … elapsed=24245ms` | 上游当时整体慢 |
| 渲染层没卡死 | `[perf] [loop-lag] macro=0ms micro=0ms` | 主线程空闲；不是 JS 阻塞 |
| 注入的样式不是性能元凶 | 强制重算 5 次：带我们的 4 张样式表 **0.06ms**，移除后 **4.9ms** | 排除「样式太多拖死页面」 |
| 注入没有结构破坏 | `.teams-container/.conversation-shell/.cr-input-container/.cr-message-list` 全部命中，`pointer-events` 正常 | 面板/舞台都是 `pointer-events:none` |
| 卡住的是宿主前端 | 16:53 之后 25 分钟，发送键仍 `disabled`、取消标记仍在 | 后端 `runtime-status: persisted status=completed`，两边不一致 |
| 守护当时确实在跑 | 注入 `window.__bcPickRequest=777`，150ms 内被取件轮询清成 0 | 所以「守护已退出」不成立，不能拿它当借口 |

### 15.2 一条命令复现这份报告

```sh
node scripts/wb-latency-report.mjs --hours 5      # 人读
node scripts/wb-latency-report.mjs --hours 24 --json   # 机器读
```

它只读 `~/.workbuddy/logs/<date>/*.log`，把
`sendPrompt → Sending request → First meaningful token → Stream completed / canceled`
串成时间线并给出 TTFT 分位数；不打 prompt 正文、不碰页面、不改注入。

### 15.3 判读规则（下次直接照抄）

- `send` 与 `first` 的间隔 = 上游出字时间；**`cancelled` 出现在 `first` 之前 = 用户主动放弃**，
  不是模型坏了。
- `loop-lag macro=0ms` + 发送键 `disabled` + 取消标记常驻 = **宿主前端状态机没恢复**
  （beautiCode 不接管输入区，改不动；重启宿主/刷新页面即恢复）。
- 只有在「注入的样式表重算开销出现数量级劣化」或「契约锚点出现 0 命中」时，
  才该怀疑适配层。


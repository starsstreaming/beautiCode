# ADR 0011：DSH 分层材质与页面/面板独立强度

- 状态：接受（冻结；t2/t3/t4 实施；t8 页面背板、t10 alpha-only、t11 复验是历史；t17–t19 现场修复后，**页面模糊默认开启、面板默认 60%、tooltip 不材质化、页内浮层暂停页面模糊**）
- 日期：2026-11-10
- 基线：main `71b641b`
- 关联：[ADR 0002](0002-dsh-functional-surface-readability.md)、[#92 验收记录](../verification/issue-92-plugin-readability.md)、[分层材质验证记录](../verification/2026-11-10-dsh-layered-material.md)、任务 t1/t5/t12/t16/t20
- 范围：`integrations/deepseek-harness/readability.js`、`client.js`、`console.js` 及其测试与文档；不修改 DSH 源码。

## 摘要

把当前「功能面板不透明」的单一百分比，升级为两条互相独立的材质通道：

1. **页面材质**：只在页面模式的 MainPanel 布局列 `[data-global-panel]` 上铺一层 **30% alpha 底色**；页面模糊**默认开启**，由同根 `::before` 背板承担 `blur(2.4px)`，页面根 `position:relative`/`isolation:isolate`，页面根自身不持有 `backdrop-filter`。页面模糊可由用户关闭（关闭后只保留 30% 底色）；页面内出现可见 tooltip/menu/listbox/dialog/alertdialog 时**暂停**页面模糊（移除 position/isolation/::before，保留底色），关闭后恢复。主会话没有这个锚点，因此不铺页面材质。
2. **面板材质**：标准 ARIA 浮层（dialog / alertdialog / menu / listbox）、消息编辑栏和待交互面板卡片，默认强度 **60%**；作为独立覆盖层时只应用一次 `backdrop-filter`，默认半径 3.69px，由平方和模型反推。页面根内的 menu/listbox/dialog/alertdialog 也使用面板材质 60%、不加 blur，不继承 page alpha。
3. **tooltip 不材质化**：`role="tooltip"` 不是材质候选，也不改写 `--dsw-alias-tooltip-bg`；保留宿主背景、文字和定位。页内 tooltip 只作为页面模糊的暂停触发器。

页面模糊暂停消除的是**页内浮层**在 V9/V10 下的现场漂移；默认页面模糊开启且没有页内浮层时，V9 absolute 包含块（探测 250）与 V10 层叠（default-outside）仍然存在。V11 滚动底部失模糊、V13 页面 `::before` 覆盖、V14 后方文字透出仍开放；V16 记录暂停选择器对常驻页内控件的副作用。真实 DSH 现场仍未验证，不能宣称本轮现场通过。

嵌套层（其祖先已经命中材质根）**只按 alpha 步长递增，绝不应用 `backdrop-filter`**。夹具已证明嵌套的 `backdrop-filter` 不会叠加：外层固定 4px 与「4 / 6.93 / 8.94px」逐像素相同，mean abs diff 为 0；跨 root 的页面 4px + 面板 4px 等价于单层 5.66px，页面 4px + 面板 6.93px 等价于单层 8px，平方和模型成立。该平方和模型用于页面背板与面板半径；页面默认应用 2.4px，暂停/关闭/页面 0% 时为 0。

本 ADR 同时取代 ADR 0002 中「插件页必须完全透明」的结论：插件页改为 30% 页面底色 + 默认 2.4px 页面模糊，但保留文字光晕与色阶辅助；旧的全局面板 token 替换式规则被删除，改为材质根作用域的规则。t10 的 alpha-only 是历史阶段，t17 起页面模糊恢复默认开启；取舍 V14 见 §4.1。

## 1. 背景与现状

### 1.1 当前实现

- `client.js` 在 `html[data-bc-active="true"] body` 上把 DSH 的表面 token 改写为半透明（chrome 36%、内容 36%，会话阶段 active/settling 提升到 86%/72%，见 `integrations/deepseek-harness/client.js:51-217`）。壁纸磨砂作用在媒体元素自身的 `filter` 上，不使用 `backdrop-filter`（同文件 `:197-210`）。
- `readability.js` 用一条全局 `:is(...)` 规则把六类 ARIA 面板、`data-composer-card` 和三个待交互面板的内层卡片直接写成不透明底板，并通过 `--bc-readable-strength` 支持 0–100 强度（`integrations/deepseek-harness/readability.js:56-107`）。插件页则被明确排除在不透明名单之外，只保留光晕与色阶提升（同文件 `:102-106`；决策来源见 ADR 0002 的「插件页改回透明底」补充）。
- `console.js` 目前只有「功能面板不透明」「背景阴影」「背景磨砂」三行滑杆，滑杆是唯一事实来源，重置箭头写回默认值（`integrations/deepseek-harness/console.js:132-179`、`:827-866`）。
- 历史测试曾断言插件页所有表面 alpha 为 0、面板 100% 为 alpha 255、40% 约为 102、0% 回到宿主半透明；t17/t18 后默认改为面板 60%、页面模糊默认开，测试基线同步更新（`integrations/deepseek-harness/test/readability.test.mjs`、`test/plugin-readability.browser.test.mjs`、`test/console.test.mjs`）。

### 1.2 为什么必须分层

单一强度无法同时表达三种不同的视觉对象：

- 页面（插件页、技能页、自动化任务等）是一整列背景，需要一层轻材质和轻微模糊，但不能像 #92 早期那样铺成实心色块。
- 浮层面板需要遮住后方正文，默认 60% alpha；但浮层内部还有菜单、列表，不能每个都再叠一次模糊；tooltip 不材质化。
- 主会话不应套页面材质；消息编辑栏和提问/计划审核/授权确认卡片是会话内的面板，不是页面。

此外，`backdrop-filter` 会创建包含块，嵌套应用既不会产生叠加效果，还会带来 fixed 定位偏移；必须用证据约束实现，而不是靠直觉逐层加模糊。

## 2. 证据

### 2.1 宿主锚点（本机官方 Desktop 打包源码）

本机官方 Desktop 包为 `0.2.2-rc.1`（运行时版本文件为 `44.7.0`）；其 `app.asar` 内，DSH 客户端 `AppFrame` 片段（打包源码，不是生成类名）：

```js
// MainPanel
"data-global-panel": panelId !== null || void 0,
children: renderSlot("main", {}, { entryKey: panelId ?? "conversation" })

// overlayLayer
"data-shell-overlay": true,
children: renderSlot("shell.overlay", {})
```

结论：

- `[data-global-panel]` **只在有全局面板（`panelId !== null`）时出现**；主会话的 main slot `entryKey` 是 `"conversation"`，没有该属性。因此「主会话不铺材质」由宿主契约直接保证，不需要用路由、`data-phase` 或尺寸猜测页面模式。
- `[data-global-panel]` 在宿主 CSS 中参与布局（`.mainPanel[data-global-panel]` 的 `padding-top`），本适配只能增加 `data-bc-*`、背景色和 `backdrop-filter`，不得改它的 `padding`、`display`、`position` 或属性值。
- `[data-shell-overlay]` 是 `shell.overlay` 的容器层（`overlayLayer`），是页面主列之外的兄弟节点。它**不是**材质根；否则其中所有浮层都会变成它的嵌套层，失去独立模糊，还会把整个 overlay 层涂上材质。它内部的 dialog/menu 等标准 role 仍作为独立候选处理。
- `data-shell-overlay` 与 `data-global-panel` 都是宿主语义契约，不是构建哈希；宿主改名或移除时按「锚点缺失 → 不铺对应材质」失败关闭，不用 `#root`、body 或高 z-index 兜底。

### 2.2 现有源码事实

- 旧规则的选择器是全局的：所有匹配的 role/卡片都会被写成同一块不透明底板，无法表达「页面 30%、面板 100%、嵌套只加 alpha」的层次（`readability.js:69-92`）。
- ADR 0002 时插件页完全透明，靠光晕和色阶提升可读性（`readability.js:102-106`；ADR 0002 的 2026-10-18 补充）。本轮把页面材质作为新的、可控的中间态：默认 30% 而不是 100%，壁纸仍然透出。
- 面板强度已经是 0–100 的独立偏好，存储键 `beauticode-readable-surfaces` 支持旧布尔值 `"true"`/`"false"`（`readability.js:5-44`、`:111-126`）。本轮保留该键与旧布尔语义，只把它的含义固定为「面板材质强度」。
- `client.js` 的 `--bc-surface-mix` / `--bc-content-mix` 继续负责会话内容与 chrome 的半透明；页面材质只在其上再加一层页面底板，不替代它。

### 2.3 夹具 A：嵌套 `backdrop-filter` 不叠加

本地夹具 `.tmp/backdrop-fixture/index.html`（临时目录，未纳入版本控制）在四个隔离的 760×680 case 中放三层嵌套 `.layer`，用 `mode` 数组控制每层模糊：

- `none`：`[0, 0, 0]`
- `fixed`：`[4, 4, 4]`
- `sqrt`：`[4, 4√3, 4√5]` = `[4, 6.93, 8.94]`
- `outer`：`[12, 0, 0]`

截图 `shot.png` 后用 `compare.py` / `measure.py` 在每格中心取 120×120 灰度，比较 mean abs diff 与 Laplacian 高频能量：

| 对比 | mean abs diff | max abs diff |
|---|---:|---:|
| `fixed` vs `sqrt` | **0.0** | **0.0** |
| `fixed` vs `outer` | 16.60 | — |
| `sqrt` vs `outer` | 16.60 | — |

| 模式 | std | Laplacian | 相对高频保留 |
|---|---:|---:|---:|
| none | 82.94 | 180.00 | 100.0% |
| fixed | 4.98 | 1.14 | 0.6% |
| sqrt | 4.98 | 1.14 | 0.6% |
| outer | 2.18 | 0.41 | 0.2% |

`fixed` 与 `sqrt` 逐像素完全相同，而只改最外层的 `outer` 明显更模糊，说明在一条嵌套链中**只有第一个带 `backdrop-filter` 的层生效，后续嵌套层的 filter 被忽略**。因此：

- 材质根已经带 filter 时，给嵌套层再加 filter 是无效功，还会创建包含块；实现必须禁止。
- 独立层（同一 stacking context 中互不为祖先的 root）才可能参与合成，见夹具 B。

`index2.html` 的补充对照说明了「第一个 filter 生效」的边界：

| 场景 | Laplacian | mean abs diff |
|---|---:|---:|
| A：嵌套只外层 4px | 1.19 | A vs C：2.95 |
| B：嵌套只内层 6.93 / 8.94px | 0.71 | B vs D：8.45 |
| C：兄弟三层各 4px | 0.76 | C vs D：1.32 |
| D：兄弟 4 / 6.93 / 8.94px | 0.42 | — |

B 比 A 更模糊，因为 B 的外层没有 filter，内层 L2 成为这条链的第一个 filter；L3 仍被忽略。C/D 是独立兄弟层，D 比 C 更模糊，说明独立层会合成。这支持「root 拥有唯一 filter」的设计：root 有 filter 时嵌套层没有效果；root 没有 filter（例如用户把最大模糊设为 0）时，更不能让嵌套层偷跑出模糊。

### 2.4 夹具 B：跨 root 平方和

`.tmp/backdrop-fixture/cross-root.html` 模拟「页面 root + body 下的 fixed 面板」：`#page` 在 `#root` 内，`#panel` 是 `position: fixed` 的兄弟节点，两者都可有独立 `backdrop-filter`。通过 query 参数 `?page=…&panel=…` 生成截图，用 `measure-cross.py` 在 120×120 中心区域测 Laplacian：

| 场景 | std | Laplacian |
|---|---:|---:|
| 无模糊 | 93.53 | 56.42 |
| 页面 4px | 41.38 | 2.86 |
| 面板 4px | 41.51 | 2.87 |
| 页面 4px + 面板 4px | 24.78 | 1.82 |
| 单层 5.66px | 24.09 | 1.78 |
| 页面 4px + 面板 6.93px | 11.20 | 1.10 |
| 单层 8px | 11.24 | 1.18 |
| 面板 8px | 11.27 | 1.11 |

- `√(4² + 4²) = 5.66`：页面 4 + 面板 4 的视觉结果与单层 5.66 几乎一致。
- `√(4² + 6.93²) ≈ 8`：页面 4 + 面板 6.93 与单层 8 几乎一致。
- 因此跨 root 的独立模糊按平方和合成，而不是线性相加，也不是只取最大层。

### 2.5 证据边界

- 夹具使用 Chromium/Electron 的 `backdrop-filter` 渲染；真实 DSH（本机包 `0.2.2-rc.1`）仍需现场复核（t4/t9）。
- 夹具没有模拟宿主自己的壁纸 `filter: blur()`、不同透明度底板、滚动容器和 GPU 差异；平方和结论用于确定层的**半径模型**，不宣称所有像素在所有背景上完全相等。
- `.tmp` 被 `.gitignore` 忽略。t2 应把最小复现（嵌套三模式 + cross-root 两模式）内联进浏览器测试或放入 `integrations/deepseek-harness/test/fixtures/`，不能只依赖临时目录。

## 3. 冻结决策

### 3.1 两通道与候选集合

#### 页面通道

- 唯一锚点：`[data-global-panel]`，即页面模式下 MainPanel 的布局列。
- 只在背景活动（`html[data-bc-active="true"]`）、页面强度大于 0 且元素可见时标记。主会话没有该属性，因此不铺页面材质。
- 页面根固定为 level 1、root 内深度 1。
- 页面模糊**默认开启**：`html[data-bc-page-blur="true"]`、页面根 `position:relative`/`isolation:isolate`、`::before` 背板 `blur(2.4px)`；页面根自身不持有 `backdrop-filter`。`getPageBlur()` 默认 true，`getBlur().page=2.4`。
- 页面根内出现可见 tooltip/menu/listbox/dialog/alertdialog 时，页面根加 `data-bc-page-blur-paused`；CSS `:not([paused])` 移除 `position`/`isolation`/`::before`，仅保留 30% alpha，`getBlur().page=0`；关闭浮层后恢复。暂停只消除页内浮层下的 V9/V10 漂移，不是永久解决 V9/V10。
- 页面材质只作用于该列；侧栏、右栏、shell overlay 不铺页面材质。

#### 面板通道

候选元素（只认宿主语义属性/角色，不认构建类名）：

- `[role="dialog"]`
- `[role="alertdialog"]`
- `[role="menu"]`
- `[role="listbox"]`
- `[data-composer-card]`
- `[data-question-key] > section`
- `[data-plan-review-key] > section`
- `[data-approval-key] > div`

判定：

- 从 `element.parentElement` 开始执行 `closest('[data-bc-material-root]')`：
  - 为空：**独立根**，标记为 `data-bc-material-root="panel"`，全局 level 2，root 内深度 1。
  - 非空且最近根是 page：**页内面板根**（`pageInternal`），kind=panel、level 2、depth 1；alpha 用面板强度（默认 60%），`backdrop-filter:none`，不继承 page alpha/档位。
  - 非空且最近根是 panel：**嵌套层**，标记为 `data-bc-material-layer`，全局 level = 最近根 level + 深度 - 1，root 内深度 = 2 + 位于该元素与根之间的候选祖先数。
- 嵌套层可以继续嵌套（菜单里的列表、列表里的子菜单），深度逐级 +1，alpha 逐级递增（越上层越实），但永远不加 `backdrop-filter`。
- 独立面板根默认强度 60%（alpha 0.60）；它的 level 2 只表示层级，不参与 alpha 步长。alpha 步长只作用于**根内嵌套层**。
- `role="tooltip"` 不是候选、不材质化；它只作为页内浮层出现时的页面模糊暂停触发器。`menu` / `listbox` / `dialog` / `alertdialog` 在页面根内按页内面板根处理，alpha 60%、无 blur。

#### 跳过与不处理

- `[data-shell-overlay]`（宿主 `shell.overlay`）容器：**整体跳过，不作为页面/面板通道的锚点，也不是材质根，不铺材质**。这里的「跳过」指跳过容器本身，不是跳过它内部的所有浮层：其中的 dialog/menu 等标准 role 仍照常按上面的规则判定为独立或嵌套。这样同一个 overlay 容器里的多个浮层各自独立，不会因为共同父层退化成嵌套层。
- 无标准 role 的第三方浮层（自定义 div、只靠 z-index 的 popover）：**不标记、不铺材质、不加模糊**。它们可能继承所在材质根的 token，但不会成为独立的材质层。这是明确边界，不用 `position: fixed`、全屏尺寸或高 z-index 扫描兜底。
- `#beauticode-*` 自身 UI：不进入候选集合；控制台页面在设置 dialog 内部，随所在面板根获得材质，但不单独成为材质层。

#### 侧栏与主会话

- **左侧栏**是 DSH chrome，位于 `[data-global-panel]` 之外，不属于页面/面板材质根。它的半透明由 `client.js` 的 `--bc-surface-mix`（默认 36%，会话 active/settling 86%）与 `--dsw-specific-sidebar-fill` 决定，不随页面/面板强度滑杆或页面模糊变化。背景阴影/壁纸磨砂会改变透过侧栏看到的壁纸，但不是侧栏自身材质；不要把它写成页面材质的“可调项”。
- **主会话**没有 `[data-global-panel]`，页面材质与页面模糊都不铺；会话页保持壁纸直出，只有 composer/待交互卡片等面板材质。若未来要“统一页面”，应新增独立可选项并单独验收，不应默认扩到主会话。

### 3.2 分层、默认值与属性契约

#### 默认值

| 项 | 默认值 | 说明 |
|---|---:|---|
| 页面材质强度 | 30% | alpha 0.30；页面模糊默认开启，`getBlur().page=2.4`；暂停/关闭/页面 0% 时 page=0 |
| 面板材质强度 | 60% | alpha 0.60（153/255）；默认页面下 blur 3.69px；已有用户值保留，重置 60 |
| 页面模糊 | 开启 | 默认 true；仅字面 `"false"` 关闭；关闭后页面只保留 30% 底色，`getBlur().page=0` |
| 嵌套 alpha 步长 | 8% | 每深一层 +8 个百分点，固定越上层越实 |
| 嵌套模糊步长 | 2px | 页面根之后，每多一个独立覆盖层，总模糊增加 2px |
| 最大模糊 | 8px | 页面+面板栈的总模糊上限 |

#### 材质层级

- 页面根：level 1。
- 独立面板根：level 2。
- 嵌套层：level = 最近根 level + 根内深度 - 1；根内深度从 2 开始。
- `level` 只用于契约、测试和调试；alpha 用根内深度，模糊用独立层公式。

#### DOM / CSS 契约

元素属性：

| 属性 | 位置 | 值 | 用途 |
|---|---|---|---|
| `data-bc-material-root` | 独立根 | `"page"` / `"panel"` | 区分页面/面板通道；只有面板根应用 `backdrop-filter`，页面根显式 `none` |
| `data-bc-material-layer` | 嵌套层 | `""`（布尔属性） | 嵌套层只铺 alpha 材质，不加 filter |
| `data-bc-material-level` | 根/嵌套层 | `1`、`2`、`3`… | 全局层级 |
| `data-bc-material-depth` | 根/嵌套层 | `1`、`2`、`3`… | 根内深度 |
| `data-bc-material-blur` | 独立根 | `"on"` | 面板根在半径 > 0 时存在；页面根在页面模糊开启且页面强度 > 0 时存在，用于触发 `::before` 背板（暂停/关闭/0% 时移除） |
| `data-bc-page-blur-paused` | 页面根 | `""`（布尔属性） | 页内出现可见 tooltip/menu/listbox/dialog/alertdialog 时存在；移除 position/isolation/::before，保留 30% alpha |

根/嵌套层的内联变量：

| 变量 | 值 | 说明 |
|---|---|---|
| `--bc-material-alpha` | `0`–`1` | 该表面的最终 alpha |
| `--bc-material-blur` | 如 `2.40px` | 面板根与嵌套层规则使用；页面根在页面模糊开启时设为 2.40px，由 `::before` 背板实际应用；暂停/关闭/0% 时移除 |

`html` 上的变量与门控：

| 名称 | 值 | 说明 |
|---|---|---|
| `data-bc-page-material` | `"true"` 或缺失 | 页面强度 > 0 时存在；0 时移除 |
| `data-bc-page-blur` | `"true"` 或缺失 | 页面模糊默认开启；页面强度 > 0 且未关闭时存在；页内浮层暂停时仍存在，但页面根另有 `data-bc-page-blur-paused` |
| `data-bc-page-blur-paused` | `""` 或缺失 | 页内可见浮层时存在；只影响页面根定位/伪元素，不改变存储/开关 |
| `data-bc-readable-surfaces` | `"true"` / `"false"` | 面板强度 > 0 / = 0；保留旧契约 |
| `--bc-page-material-strength` | 0–100 | 页面强度，供调试与测试 |
| `--bc-readable-strength` | 0–100 | 面板强度；保留旧变量名 |
| `--bc-material-alpha-step` | 0–30 | 百分点 |
| `--bc-material-blur-step` | 0–8 | px |
| `--bc-material-max-blur` | 0–16 | px |


CSS 规则形状（实现可等价拆分，语义必须一致）：

```css
html[data-bc-active="true"] body{
  --bc-material-base:var(--dsw-static-neutral-bluish-800,#232833);
}
html[data-bc-active="true"][data-bc-resolved-tone="light"] body{
  --bc-material-base:var(--dsw-static-neutral-bluish-00,#fff);
}
/* CSS 默认值兜底；JS 会按用户强度覆盖 inline 变量。 */
html[data-bc-active="true"] [data-bc-material-root="page"]{--bc-material-alpha:.3;}
html[data-bc-active="true"] [data-bc-material-root="panel"]{--bc-material-alpha:.6;}

/* 页面根和嵌套层都铺材质；页面根不再改写 8 个 surface token，
   让页面内部保留 client.js 的既有表面层次，页面根只提供一层底板。 */
html[data-bc-active="true"] [data-bc-material-root],
html[data-bc-active="true"] [data-bc-material-layer]{
  --bc-material-fill:color-mix(in srgb,var(--bc-material-base,#232833) calc(var(--bc-material-alpha,1) * 100%),transparent);
  background-color:var(--bc-material-fill);
}

/* 面板根和嵌套层改写 7 个 token，保证浮层内部组件共享同一块材质。
   --dsw-alias-tooltip-bg 故意不改写：tooltip 必须保留宿主黑底白字/定位。 */
html[data-bc-active="true"] [data-bc-material-root="panel"],
html[data-bc-active="true"] [data-bc-material-layer]{
  --dsw-alias-bg-base:var(--bc-material-fill);
  --dsw-alias-bg-layer-1:var(--bc-material-fill);
  --dsw-alias-bg-layer-2:var(--bc-material-fill);
  --dsw-alias-bg-layer-3:var(--bc-material-fill);
  --dsw-alias-bg-overlay:var(--bc-material-fill);
  --dsw-specific-input-major:var(--bc-material-fill);
  --dsw-specific-menu:var(--bc-material-fill);
}

/* 面板独立根只应用一次；嵌套层永远不匹配这条规则。 */
html[data-bc-active="true"] [data-bc-material-root="panel"][data-bc-material-blur="on"]{
  -webkit-backdrop-filter:blur(var(--bc-material-blur,0px));
  backdrop-filter:blur(var(--bc-material-blur,0px));
}

/* 页面根自身永远不持有 backdrop-filter；页面模糊只走 ::before 背板。 */
html[data-bc-active="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]{
  -webkit-backdrop-filter:none;
  backdrop-filter:none;
}

/* 页面模糊默认开启：html flag + 页面根 blur 标记同时存在时启用背板。
   页内出现可见 tooltip/menu/listbox/dialog/alertdialog 时，页面根加
   data-bc-page-blur-paused，:not() 移除定位/伪元素，仅保留 30% alpha。 */
html[data-bc-active="true"][data-bc-page-blur="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]:not([data-bc-page-blur-paused]){
  position:relative;
  isolation:isolate;
}
html[data-bc-active="true"][data-bc-page-blur="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]:not([data-bc-page-blur-paused])::before{
  content:"";
  position:absolute;
  inset:0;
  z-index:-1;
  pointer-events:none;
  -webkit-backdrop-filter:blur(var(--bc-material-blur,0px));
  backdrop-filter:blur(var(--bc-material-blur,0px));
}
```

插件页的文字辅助保留，但改由**页面通道**门控（不再是面板强度）：

```css
html[data-bc-active="true"][data-bc-page-material="true"] [data-plugin-panel]{
  --dsw-alias-label-tertiary:var(--dsw-alias-label-secondary);
  --dsw-alias-label-caption:var(--dsw-alias-label-secondary);
  text-shadow:0 1px 2px color-mix(in srgb, var(--bc-text-halo) 45%, transparent);
}
```

要点：

- 旧的全局面板 token 规则和 `--bc-readable-fill` 删除；材质根规则取代它。面板根/嵌套层改写 7 个 token（`--dsw-alias-tooltip-bg` 故意不改写），因为浮层内部组件必须共享同一块材质，同时 tooltip 必须保留宿主黑底白字。
- 页面根不改写 token，只加一层 30% 底色；页面内部的卡片/分组继续使用 `client.js` 发布的半透明 token，避免卡片区域叠成更深的色块。
- `background-color` 不用 `!important`；靠 `html[data-bc-active="true"]` 的特异性覆盖宿主类名。若现场发现宿主内联背景压过该规则，再按同一根作用域加 `!important`，并记录到验证报告。
- 页面模糊默认开启：页面根带 `data-bc-material-blur="on"`/inline `--bc-material-blur:2.4px` 时，`html[data-bc-page-blur="true"]` + `:not([data-bc-page-blur-paused])` 启用 `position:relative`/`isolation:isolate` 与 `::before blur(2.4px)`。页内出现可见 tooltip/menu/listbox/dialog/alertdialog 时加 `data-bc-page-blur-paused`，移除定位/伪元素但保留 30% alpha；关闭浮层后恢复。不设置 `background-image`、尺寸、圆角、边框、间距、滚动或命中区域。
- 0% 时不设置任何材质标记；CSS 规则整体不匹配，页面只保留宿主/`client.js` 的半透明外观；`beauticode-page-blur` 偏好保留，恢复页面强度 > 0 后自动恢复模糊；面板根不残留 filter。清除背景时 `data-bc-active` 移除，材质规则同样不匹配。

#### 层级计算

- 页面根 alpha = 页面强度 / 100。
- 独立面板根 alpha = 面板强度 / 100。
- 嵌套层：

```
alpha = rootAlpha + (depth - 1) * alphaStep / 100
alpha = clamp(alpha, 0, 1)
```

- 方向固定为**越上层越实**，没有「越上层越透」选项。旧存储 `beauticode-material-direction` 不再读取/写入，旧值保留但被忽略；`getMaterial()` 不含 direction，`setMaterial({direction})` 静默忽略。
- 嵌套层 alpha 达到 0 或 1 后夹取，不再变化。

### 3.3 用户配置与存储

#### 两个独立滑杆

| UI 行 | 默认 | 作用 |
|---|---:|---|
| 页面材质 | 30% | 页面通道；插件页、技能页、自动化任务等 |
| 功能面板不透明 | 60% | 面板通道；保留现有标签和语义，内部称「面板材质强度」；已有用户值保留，重置 60 |

两行互不重置；移动一个不改变另一个的存储值或 alpha。页面通道 0% 只关闭页面底色与页面模糊；面板通道 0% 只关闭面板材质。需要说明的是：页面强度同时是面板模糊模型的尺度 `I`，所以改变页面强度会按 §3.4 改变面板的 blur 半径；页面模糊默认应用，但可由用户关闭或页内浮层暂停。

#### 高级设置

独立分组「高级设置」，沿用现有行结构：

| 行 | 范围 | 默认 | 说明 |
|---|---:|---:|---|
| 材质档位间隔（透明度） | 0–30% | 8% | 嵌套层每深一层的 alpha 变化 |
| 材质档位间隔（模糊） | 0–8px | 2px | 每多一个独立面板层，模型总模糊增加量 |
| 最大模糊 | 0–16px | 8px | 面板栈的模型总模糊上限（页面强度只提供尺度 `I`） |
| 页面模糊 | 开 / 关 | 开 | 默认开启；关闭后页面只保留 30% 底色；页面 0% 时开关/重置 disabled 但存储保留 |

高级设置只有三个档位滑杆（alpha-step、blur-step、max-blur）与页面模糊开关；**没有方向行**。嵌套 alpha 固定递增，旧 `beauticode-material-direction` 偏好保留但忽略。页面模糊行描述为「给页面加模糊；关闭后页面只保留底色」，页面 0% 时显示「需要页面材质 >0」提示并禁用按钮/重置。

#### 存储键与迁移

| 键 | 类型 | 默认 | 规则 |
|---|---|---:|---|
| `beauticode-page-material` | 数字 0–100 | 30 | 缺失/无效 → 30；0 写 `"0"` |
| `beauticode-page-blur` | 布尔字符串 | `"true"` | 默认开启；仅字面 `"false"` 关闭；缺失/无效/读取失败 → true |
| `beauticode-readable-surfaces` | 数字 0–100，兼容布尔 | 60 | 缺失/`"true"` → 60；`"false"` → 0；数字原样保留（35 仍 35）；无效 → 60；0 仍写 `"false"` 以兼容旧版回滚 |
| `beauticode-material-alpha-step` | 数字 0–30 | 8 | 缺失/无效 → 8；整数 |
| `beauticode-material-blur-step` | 数字 0–8 | 2 | 缺失/无效 → 2；整数 |
| `beauticode-material-max-blur` | 数字 0–16 | 8 | 缺失/无效 → 8；整数 |

- `beauticode-material-direction` 已移除：不再读取/写入、不在 `storageKeys`、不参与 `storage` 事件；旧值（如 `"down"`）保留在 localStorage 但被忽略。`getMaterial()` 只返回 `{alphaStep,blurStep,maxBlur}`；`setMaterial({direction})` 静默忽略。

- 所有读取失败、存储被拒绝、无效值都回退默认值；写入失败时当前页面仍按内存值生效。
- 页面模糊通过 `BeauticodeReadableSurfaces.getPageBlur()` / `setPageBlur(boolean)` 读写；默认 true，写入 `"true"`/`"false"`。除 `getMaterial()` 不再含 `direction` 外，`get/set/getPage/setPage` 与 `setMaterial` 的既有形状不变；`getMaterial()` 只返回 `{alphaStep,blurStep,maxBlur}`。
- `getBlur()` 返回**实际应用值**：默认 `{page:2.4, panel:3.69}`；页内浮层暂停、页面模糊关闭或页面 0% 时 `page=0`，panel 仍 3.69。页面强度仍是面板半径的模型尺度 `I`。
- 写入后立即更新 `html` 变量、材质标记和 CSS，并派发 `beauticode-material-change`；面板强度变化额外派发旧事件 `beauticode-readability-change`，兼容现有监听者。
- 同源其他窗口通过 `storage` 事件读取同一组键并重算；`beauticode-page-blur` 也在白名单内，忽略无关键。
- 重置箭头写回该行默认值（30 / 60 / 8 / 2 / 8 / 页面模糊 true），不写「未设置」；页面 0% 时页面模糊按钮/重置 disabled、显示「需要页面材质 >0」，存储选项保留，恢复页面强度 >0 后自动恢复模糊。
- 升级迁移：页面材质是新增通道，默认 30%；旧用户升级后会开始看到页面底板，可在「页面材质」行拉到 0% 关闭。面板键沿用旧值（35 等保留），缺失/布尔 true 的新默认 60；不强制覆盖用户值。
- 回滚兼容：旧版只读 `beauticode-readable-surfaces`；页面/高级键对旧版是未知键，会被忽略。旧版读到 `"false"` 仍关闭面板；数字值旧版视为开启（保守方向）。

#### 0% 语义

- 页面 0%：移除页面根标记、页面底色、页面模糊/背板、页面光晕/色阶辅助；保留 `beauticode-page-blur="true"` 存储选项，恢复页面强度 > 0 后自动恢复模糊。页面回到 `client.js` 的半透明宿主外观。面板材质不受影响。
- 面板 0%：移除所有面板根/嵌套层标记、模糊和局部 token；role 面板、编辑栏、待交互卡片回到 `client.js` 的半透明外观；页面材质不受影响。
- 两者都 0%：没有材质标记，等同当前半透明宿主外观。
- 这里的「宿主」按本项目既有叫法，指 **beautiCode 已改写的半透明 DSH 外观**（`client.js` 发布的 token），不是未经 beautiCode 处理的 DSH 原生实色；清除背景或卸载插件才会回到原生外观。

### 3.4 模糊模型

记：

- `I` = 面板模糊模型的页面尺度 = 页面强度 / 100 × 最大模糊（默认 `0.30 × 8 = 2.40px`）。页面模糊默认开启，`I` 送到页面 `::before` 背板；页内浮层暂停/关闭/0% 时页面不应用，但 `I` 仍用于推导面板半径。
- `B` = 模糊步长（默认 2px）。
- `M` = 最大模糊（默认 8px）。
- `T_n` = 第 n 层独立材质的目标总模糊。
- 嵌套层不参与 n，也不加 filter。

#### 页面根

```
T_1 = I                         （面板 sqrt 模型的尺度）
s_1 = I                         （页面模糊默认开启，送到 ::before 背板）
s_1 = 0                         （页面模糊关闭、页面 0%、或页内浮层暂停时）
```

页面模糊默认开启：页面保留 30% 底色，页面根 `position:relative`/`isolation:isolate`，`::before` 背板应用 2.4px；页面根自身不持有 `backdrop-filter`。`getBlur().page` 默认 2.4（实际应用值），页内浮层暂停/关闭/0% 时为 0；panel 默认 3.69。页内出现可见 tooltip/menu/listbox/dialog/alertdialog 时加 `data-bc-page-blur-paused`，移除定位/伪元素但保留 30% alpha。

如果页面强度为 0 或页面锚点不存在：`I = 0`，没有页面根，也没有页面 filter/背板；`beauticode-page-blur` 偏好保留，恢复页面强度 > 0 后自动恢复，`getBlur().page` 在页面 0% 时为 0。

#### 独立覆盖层（level 2）

```
T_2 = min(M, I + B)
s_2 = sqrt(T_2² - I²)
```

- 默认：`I = 2.4`，`B = 2`，所以 `T_2 = 4.4`，`s_2 = sqrt(4.4² - 2.4²) = 3.69px`。
- 如果页面材质不存在/为 0（主会话、或用户关闭页面材质）：`I = 0`，`s_2 = B = 2px`。面板默认 60% alpha；模糊步长是面板的第二层贡献，面板强度本身不缩放模糊。
- 如果 `M = 0` 或 `B = 0` 或 `T_2 = I`：`s_2 = 0`，不设置 `data-bc-material-blur`，不写 `blur(0px)`。
- 页面 100% 时 `I = 8 = M`，`T_2 = 8`，`s_2 = 0`：页面背板 8px，面板不再叠加。

#### 第二个及以上独立覆盖层（一般式）

```
T_n = min(M, I + (n - 1) * B)
s_n = sqrt(T_n² - T_{n-1}²)          (n ≥ 2, T_1 = I)
```

当 `B = I` 时退化为 `s_n = I * sqrt(2n - 1)`，总模糊 `T_n = nI`。夹具 A 的 `sqrt` 模式正是这组独立层半径 `4 / 6.93 / 8.94`；但由于夹具 A 把它们放在嵌套链里，实测只得到外层 4px 的效果（与 `fixed` 完全相同），这恰好证明嵌套层不叠加。独立层的平方和由夹具 B 验证：4 + 4 ≈ 单层 5.66，4 + 6.93 ≈ 单层 8。当前 closest 规则只产生 level 2 的独立面板层；一般式保留给未来明确的独立层，不用于嵌套层。

#### 嵌套层

```
s_nested = 0（不设置 backdrop-filter）
```

原因是材质根拥有唯一 filter：根有 filter 时，夹具 A 已证明嵌套 filter 会被浏览器忽略；根没有 filter（例如 `maxBlur=0`）时，嵌套 filter 会成为这条链的第一个 filter，违背用户关闭模糊的选择。两种情况都要求嵌套层不加 filter；额外的包含块和无效合成只是附带代价。

#### 多独立覆盖层的已知限制

所有独立面板根都按 level 2 计算，同一个 `s_2`。当两个独立面板（例如设置 dialog + body portal 菜单）在视觉上重叠时，浏览器会合成两个 filter，总模糊可能达到 `sqrt(I² + 2*s_2²)`（默认约 5.74px），超过模型里的页面+单个面板 `4.4px`。页面本身没有 filter，实际视觉只叠加面板 filter。这是可接受的已知限制：

- 面板默认 alpha 60%，模糊主要作用于面板后方的壁纸，不影响面板文字；
- 嵌套在 dialog 内的菜单不产生 filter，只有真正 portal 到 root 外的菜单才会计入；
- 若未来需要严格按视觉栈计数，再引入几何重叠排序；本轮不为此增加布局读取和复杂度。

### 3.5 与 ADR 0002 / 旧实现的关系

- **取代**「插件页完全透明」：插件页改为 30% 页面底色，页面模糊默认开启（2.4px 背板）；保留文字光晕和色阶提升。这不是回到 #92 早期的实心底板；默认 alpha 0.30，壁纸仍明显透出。面板 blur（默认 3.69px）不受影响。
- **保留**「功能面板不透明」滑杆和 `beauticode-readable-surfaces` 键，但内部语义固定为面板材质强度；0% 仍是关闭并回到半透明。
- **重写** 全局面板 8 token 规则：不再用一条 `:is(...)` 规则把所有 role 面板写成同一块底板；改为材质根/嵌套层作用域。旧规则删除，避免与新规则双重叠加。
- **保留** `client.js` 的 `--bc-surface-mix` / `--bc-content-mix`、会话阶段、背景阴影、壁纸磨砂、画窗/摸鱼逻辑；新材质只在其上增加页面/面板层。
- **改变** 插件页辅助的门控：从面板强度改为页面强度。页面 0% 时插件页不再有光晕/色阶提升；面板 0% 不影响页面辅助。

## 4. 风险、边界与取舍

### 4.1 页面模糊默认开启：V3 关闭；V9/V10 默认仍存在、页内浮层暂停时消除；V11/V13/V14/V16 开放

`backdrop-filter` 会为 fixed/absolute 后代创建包含块。t4/t7 曾复现：页面根直接带 filter 时，列内 `position:fixed` 元素从视口 `x=60` 偏移到列内 `x=300`；t8 改用同根 `::before` 背板后 fixed 偏移关闭，但背板依赖 `position:relative`（V9 absolute 包含块）、`isolation:isolate`（V10 层叠困住）和 `absolute inset:0`（V11 滚动页面底部失模糊）。t17 起页面模糊恢复为默认开启，接受这些风险，并用**页内浮层暂停**做现场保护。

默认页面模糊开启且**没有页内浮层**时：

- **V3 关闭**：页面内 fixed 开/关均 `(60,60)`，portal `(40,40)`；页面根自身无 `backdrop-filter`，模糊在 `::before`。
- **V9 仍存在**：页面内 absolute 探针为 `(250,12)`（页面列 x=240 + 10），不是 `(10,12)`。
- **V10 仍存在**：页面内 `z-index:9999` 与页面外 `z-index:1` 兄弟重叠时命中 `default-outside`，不是 `high-inside`。
- **V11 开放**：页面列自身滚动时，absolute 背板随内容滚动，底部一段失去模糊（t19 补高内容 `scrollTop=300` 后 delta 1）。暂停不解决 V11。
- **V12 关闭**：`maxBlur=0` 时无背板、无 position/isolation。
- **V13 开放**：页面模糊使用页面根 `::before`；宿主/第三方页面若占用该伪元素仍有覆盖风险。
- **V14 开放**：关闭页面模糊时，30% alpha 只能把高对比后景文字从 21:1 降到 10.68:1，不能消除后方文字透出；开启 2.4px 模糊也不宣称完全解决。
- **V15 已闭合**：默认页面 blur 标记与 `::before` 实际值一致；关闭/0% 后标记移除、`getBlur().page=0`。
- **V16 开放（低-中）**：暂停选择器包含任意可见的页内 `listbox`/`dialog` 等，常驻页内控件可能让页面模糊一直暂停；需真实 DSH/第三方页面复核。

**页内浮层暂停**：页面根内出现可见 tooltip/menu/listbox/dialog/alertdialog 时，页面根加 `data-bc-page-blur-paused`；`:not([data-bc-page-blur-paused])` 规则移除 `position`/`isolation`/`::before`，仅保留 30% alpha，`getBlur().page=0`，面板 blur 3.69 不变。此时 absolute 回到 `(10,12)`、高 z-index 回到 `high-inside`，即 V9/V10 在暂停期间被消除；关闭所有页内浮层后恢复 `relative/isolate` 与 `blur(2.4px)`。暂停只覆盖页内浮层场景，普通页面内容的 absolute/层叠风险仍在。

**tooltip 不材质化**：`role="tooltip"` 不是候选、不套页面 alpha，也不改写 `--dsw-alias-tooltip-bg`；保留宿主黑底白字、背景和定位。页内 tooltip 只触发暂停。页面根内 menu/listbox/dialog/alertdialog 使用面板材质 60%、`backdrop-filter:none`，不继承 page alpha，避免 V9/V10 下的漂移。

**面板默认 60% 的取舍**：从 100% 降到 60% 会让后景更明显透出；设置页/添加插件弹窗在 35% 下已偏透，60% 是新的基线。已有 35 等用户值保留，重置写回 60。面板根包含块变化仍需在 fixture 与现场检查内部 fixed 元素和弹层定位；不得用 `transform`、`contain`、`will-change` 掩盖偏移，也不得接受偏移后宣称通过。

### 4.2 页面级性能

页面模糊默认开启，`::before` 背板覆盖整个 MainPanel 列；视频背景下每帧全列模糊可能增加 GPU 开销。面板、菜单的 filter 面积小，tooltip 不材质化。仍是 Chromium/Edge fixture 结论，真实 DSH 视频帧时间和观感未测。

措施：

- 页面模糊默认开启，但页内浮层出现时暂停（移除定位/伪元素）；用户可关闭页面模糊或把页面材质拉到 0%。
- 面板独立根每层只应用一次 filter，嵌套层不加 filter（夹具 A 也证明无效）。
- 页面强度 0% 关闭页面底色与模糊；面板最大模糊 0 关闭面板 filter。
- 不在根上添加 `will-change`，不创建额外舞台节点。
- t4/t9/t11/t19 已在真实 Chromium（Edge）中验证材质；真实 DSH Web/Desktop 的视频性能仍需现场记录。若出现明显卡顿，先记录数值和场景，再讨论调整默认值。本轮不擅自动态降级或静默关闭。

### 4.3 嵌套层没有独立模糊

接受。嵌套层只能通过 alpha 步长与根区分；如果某个嵌套浮层视觉上需要更强的模糊，正确做法是让它成为独立 root（通常是 portal 到 body），而不是给它再加一层 filter。根已有 filter 时嵌套 filter 会被忽略；根没有 filter 时嵌套 filter 会违背 `maxBlur=0` / 0% 的关闭语义。

### 4.4 `data-global-panel` 语义变化

- 页面模糊默认开启时，在 `html[data-bc-page-blur="true"]` 且未暂停时给页面根加 `position:relative`/`isolation:isolate` 与 `::before` 背板；页内浮层暂停、关闭页面模糊或页面 0% 时完全移除。宿主已有的非 static `position` 会被覆盖，属既定副作用（V9/V10），需现场复核。
- 除页面根定位/伪元素外，只增加 `data-bc-*` 与 `background-color`；不改变属性值、不删除、不改 `padding`/`display`，不设置 `background-image`。
- 若宿主改名或移除该属性：页面材质不生效，失败关闭；不使用 `#root`、body、路由或尺寸兜底。面板材质不受影响。
- 若宿主在会话模式也输出该属性：需要在适配层重新验证；在确认前，页面材质可能误铺到会话。实现不得用猜测掩盖，测试 fixture 必须同时覆盖「有属性=页面」和「无属性=会话」。
- 页面内容若自带不透明背景，可能盖住 30% 底板；自动化 fixture 未覆盖真实页面内容，需现场检查插件页、技能页、自动化任务。若确实被盖住，只调整页面内容根的背景，不改变锚点语义。

### 4.5 页面文字对比度

30% 页面底色不是「任意壁纸都 ≥ 4.5:1」的保证。深色主题的浅色文字在纯白壁纸、浅色主题的深色文字在纯黑壁纸上仍可能低于门槛；页面模糊默认开启可缓解但不能保证，文字光晕和色阶提升仍是主要辅助。

沿用 #92 的诚实取舍：在文档范围内（深色主题偏暗壁纸、浅色主题偏亮壁纸）断言达标；两个越界极值继续显式断言失败，不把门槛空过。V14 是相反方向的取舍：30% alpha 对**后方文字透出**只能把高对比从 21:1 降到 10.68:1，不能消除；页面前景文字可读性与“后方不重叠”不是同一件事。

### 4.6 双重材质/双重模糊

- 旧全局面板规则必须删除，否则同一 role 面板会同时命中旧规则和新材质根，出现双重底色。
- `client.js` 的壁纸磨砂是媒体元素上的普通 `filter`，不是 `backdrop-filter`；页面 `::before` 背板与面板 `backdrop-filter` 会在其之上再模糊一次，这是预期的两层效果，不纳入平方和模型（壁纸模糊是背景内容的一部分）。tooltip 不参与材质，也不改写 `--dsw-alias-tooltip-bg`。
- 页面根不改写 surface token，避免页面内部每个卡片再叠一层 30% 底色；面板根改写 token 是为了浮层内部共享材质。两者不要混用。

### 4.7 回滚与旧版行为

- 旧版只认识 `beauticode-readable-surfaces`；读到 0 写的 `"false"` 会关闭，读到 100/中间值会开启。页面材质和高级键在旧版中不存在，回滚后消失，属于预期。
- 旧版的插件页是全透明；回滚后页面材质消失，插件页恢复透明 + 光晕。若用户已经习惯 30% 页面材质，回滚会看到明显变化，需在发布说明中写明。
- 不需要数据迁移、备份或 DSH 安装文件修改；所有偏好都在应用 localStorage。

## 5. 测试计划

### 5.1 单元测试（`readability.test.mjs`）

覆盖：

- 页面强度默认 30、面板默认 60；0 页面/0 面板独立生效。
- 旧 `beauticode-readable-surfaces`：`"true"`→60、`"false"`→0、数字夹取、无效→60；0 仍写 `"false"`。
- 页面 0 写 `"0"`；高级键默认 8 / 2 / 8，无 `direction`；范围夹取；无效值回退。
- 页面根标记、独立面板根标记、`data-shell-overlay` 不标记、无 role 浮层不标记。
- `closest` 判定：独立面板 level 2；嵌套层 level 递增、depth 递增、无 `data-bc-material-blur`。
- alpha 计算：页面根 30%；面板根 60% → 嵌套 68 → 76（固定递增）；页内 menu/list/dialog 为面板根 60%；alphaStep 12 时 72/84；面板 100 夹取。
- 模糊计算：页面默认 2.4（暂停/关闭/0% 时 0）；面板 3.69；页面 0 时面板 2；`maxBlur=0` 时全无 filter；`blurStep=0` 时面板无 filter；页面 100 时面板无 filter；`blur(0px)` 不出现。
- MutationObserver 重扫：新增/移除 dialog、替换 page root、角色变化后的幂等；不重复写 style，不残留旧标记。
- 跨窗口 `storage` 同步、事件派发、重复加载不重复注入样式。
- 0% 时材质标记、inline 变量、filter 属性全部清除；页面根 alpha 0、无 filter，面板根不残留 blur 属性。

### 5.2 浏览器测试（`plugin-readability.browser.test.mjs`）

fixture 至少包含：

- 页面模式：带非零偏移的 `[data-global-panel]`，内部有插件页/普通页面内容。
- 会话模式：`#root [data-phase="active"]`，无 `[data-global-panel]`，含 `[data-composer-card]` 和三个待交互卡片。
- 页面根内的嵌套 role（直接子级和二级嵌套）。
- 页面根外的独立 dialog、body portal menu、tooltip、listbox。
- `[data-shell-overlay]` 容器及其中 role；无 role 的第三方浮层。
- 页面根外和页面根内的 fixed 下拉各一个。
- 视频背景（canvas captureStream 或已有视频 fixture）。

断言：

- 页面默认：`[data-global-panel]` 有 `data-bc-material-root="page"`，alpha ≈77（30%）；页面根 `backdrop-filter:none`、`position:relative`/`isolation:isolate`、`::before blur(2.4px)`；`getPageBlur()===true`、`getBlur().page=2.4`、panel=3.69；fixed 60/60、portal 40/40。
- 面板默认：dialog/listbox 等面板根 alpha ≈153（60%），`blur(3.69px)`；主会话 composer alpha 153、`blur(2px)`。
- 页面根内 menu/listbox/dialog/alertdialog：root=panel、alpha 153、`backdrop-filter:none`、无 `data-bc-material-blur`；不继承 page alpha。
- tooltip：无 material/layer、无 `data-bc-material-root`，背景/文字保持宿主（黑底白字），`--dsw-alias-tooltip-bg` 未被改写；页内 tooltip 触发页面模糊暂停。
- 页面模糊暂停：页内出现可见 tooltip/menu/listbox/dialog/alertdialog 时，页面根 `data-bc-page-blur-paused`、`position:static`/`isolation:auto`、`::before content:none`、alpha 77、`getBlur().page=0`；关闭后 `relative/isolate`/`blur(2.4)` 恢复。
- 页面模糊关闭/页面 0%/maxBlur 0：无 `::before`/position/isolation，`getBlur().page=0`；页面 alpha 在关闭模糊时仍 30%，页面 0% 时 alpha 0；面板 blur/alpha 不受影响。
- V9/V10：默认页面模糊开启且无页内浮层时，absolute 250、default-outside；暂停时 absolute 10/12、high-inside；关闭/页面 0% 时恢复默认几何。V3 fixed 60/60；V11 滚动底部 delta 1 仍在。
- 页面 100：页面 alpha 1、`::before blur(8px)`；面板无 filter。页面 0：页面 alpha 0、无 filter；dialog `blur(2px)`。
- 嵌套固定递增：面板根 0.60 → 0.68 → 0.76；旧 `direction:"down"`/存储 `"down"` 不改变该序列，也不写旧键。
- `[data-shell-overlay]` 自身无标记、无 filter；其内部 dialog 仍独立带 filter。无 role 浮层无标记、无 filter。
- 插件页：30% 底板 + 页面模糊默认开启；白/黑壁纸截图不同；文字光晕/次级色阶存在；V14 仍不保证后方文字不重叠。
- 0% 与基线（不注入 readability）计算样式一致；面板默认 60、已存 35 保留；关闭模糊/页面 0%/暂停时序均覆盖。

### 5.3 控制台测试（`console.test.mjs`）

覆盖：

- 新增「页面材质」行默认 30；现有「功能面板不透明」默认 60，滑杆/标签/重置均为 60。
- 页面模糊默认开启（「已开」、`aria-pressed=true`），关闭后只保留底色；页面 0% 时按钮/重置 disabled、「需要页面材质 >0」提示可见、存储保留，恢复 30% 后自动生效。
- 已存面板值 35/40 保留、不强制迁移；旧 `"true"`→60、`"false"`→0、无效→60。
- 高级设置默认 8 / 2 / 8 不变（无 `direction`）；范围与标签显示。
- 滑杆 input 写存储、立即生效、标签同步；重置箭头写默认值（30/60/8/2/8/页面模糊 true）；跨窗口 `storage` 重渲染。
- 页面 0 / 面板 0 的独立回退；旧 `"false"` 兼容。
- 旧 `beauticode-material-direction` 被忽略：不读、不渲染、不改写、storage 事件无效；控制台从不向材质 API 发送 direction。
- 现有全屏、导入、主题、阴影、磨砂、声音行不回归；没有新依赖。

### 5.4 命令

```powershell
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js

node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs

# 有 Playwright 运行时才跑；没有则显式 skip，不能记为通过
$env:BEAUTICODE_PLAYWRIGHT_MODULE = "<本机 playwright 模块路径>"
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/plugin-readability-pack.test.mjs
```

`plugin-readability.browser.test.mjs` 在没有 `BEAUTICODE_PLAYWRIGHT_MODULE` 时按现有约定 `test.skip`。t4 的验证报告必须列出跳过项，不能把跳过说成通过。

### 5.5 现场验收（t4）

在真实 DSH Web 与官方 Desktop 上检查：

- 设置 dialog、菜单、列表、tooltip、消息编辑栏、提问/计划审核/授权确认卡片。
- 插件页、技能页、自动化任务页：页面 30% 材质、壁纸仍透出、文字可读。
- 主会话：无页面材质；编辑栏和待交互卡片仍为面板材质。
- 视频背景：页面/面板材质下的滚动、菜单、输入、全屏、摸鱼；记录帧时间/观感。
- 默认页面 30% + 页面模糊开启：页面根 `relative/isolate`、`::before blur(2.4px)`、alpha 77；fixed `(60,60)`、portal `(40,40)`；面板默认 60%（153）、blur 3.69。
- 页内 tooltip：保留宿主黑底白字/定位，不改写 `--dsw-alias-tooltip-bg`；页内 menu/listbox/dialog/alertdialog 用面板 60%、无 blur，并触发页面模糊暂停（页面根 static/auto/no pseudo、alpha 30、`getBlur().page=0`）；关闭浮层后恢复。
- V3 fixed 已关闭；V9/V10 在默认页面模糊开启且无页内浮层时仍存在（absolute 250、default-outside），暂停期间回到 10/12、high-inside；V11 滚动底部失模糊仍开放；V13 页面 `::before` 覆盖开放；V14 关闭模糊时仍开放；V16 暂停选择器可能被常驻页内控件长期触发。
- 0% 页面、0% 面板、两者 0%、页面模糊关闭、旧布尔/35 等已存值、跨窗口同步。
- `[data-global-panel]` / `[data-shell-overlay]` 在当前 DSH 版本的实际 DOM 与打包源码一致；宿主升级后重新检查。
- 本机真实 DSH 当前运行上一版候选；tooltip/暂停/面板 60/页面模糊默认开启均需重新安装/重启候选后现场确认，不得把 Chromium fixture/Edge 自动化结果当作真实现场通过。详见[验证记录](../verification/2026-11-10-dsh-layered-material.md) §19/§20。

### 5.6 验收矩阵（实现完成的硬指标）

| 场景 | 页面根 | 面板根 | 嵌套层 / 页内浮层 |
|---|---|---|---|
| 页面默认 30% + 面板 60% | alpha 0.30；`relative/isolate`；`::before` 2.40px；`getBlur().page=2.4` | alpha 0.60（153），blur 3.69px | 无 filter；面板嵌套按档位 |
| 页内 tooltip/menu/listbox/dialog 可见 | `data-bc-page-blur-paused`；static/auto、无伪元素；alpha 0.30；`getBlur().page=0` | 页内 menu/list/dialog alpha 0.60、backdrop none；tooltip 无材质 | tooltip 保留宿主黑底白字 |
| 页面模糊关闭 | alpha 0.30；static/auto、无伪元素；`getBlur().page=0` | alpha 0.60，blur 3.69px | 无 filter |
| 主会话（无 page） | 无 | 编辑栏/卡片 alpha 0.60，blur 2.00px | 无 filter |
| 页面 0% | 无标记、alpha 0、无 filter；页面模糊偏好保留 | alpha 0.60，blur 2.00px | 无 filter |
| 面板 0% | alpha 0.30；页面模糊照常 | 无标记、无 filter | 无标记 |
| 页面 100% | alpha 1.00；`::before` 8.00px | alpha 0.60，无 filter | 无 filter |
| maxBlur 0 | alpha 0.30、无伪元素/position/isolation | alpha 0.60、无 filter | 无 filter |
| blurStep 0 | alpha 0.30、`::before` 2.40px | alpha 0.60、无 filter | 无 filter |
| 嵌套递增（固定） | 页内面板 alpha 0.60 | 嵌套 0.68 → 0.76；旧 direction 无效 | 无 filter |

（上表为默认 8% alpha step、2px blur step、8px max blur 下的值；页面模糊默认开启，V9/V10 在无页内浮层时仍存在，暂停只消除页内浮层下的漂移。）

## 6. 回滚计划

### 6.1 用户级

- 页面材质异常：把「页面材质」拉到 0%，立即移除页面底色、页面模糊/背板与插件页辅助；`beauticode-page-blur` 偏好保留，恢复页面强度 > 0 后自动恢复。
- 页面模糊异常：关闭「页面模糊」或点重置（默认 true），立即移除 `data-bc-page-blur`/`data-bc-page-blur-paused`、`position`/`isolation` 与 `::before`；`getBlur().page` 回 0，面板保持 60%/3.69。
- 面板材质异常：把「功能面板不透明」拉到 0%，立即回到旧半透明外观；重置写回 60。
- 性能问题：关闭页面模糊、页面 0% 或把「最大模糊」拉到 0；面板 alpha 保留。页面模糊默认开启，全列背板有每帧开销。
- 高级设置异常：逐行重置箭头写回默认值。
- 清除背景：移除 `data-bc-active`，所有材质规则不匹配；偏好保留，下次应用背景时恢复。
- 若控制台不可用，可在应用 localStorage 中把 `beauticode-page-material` 设为 `"0"` 后刷新；这是本机偏好，不涉及数据迁移。

### 6.2 版本级

- 回滚到上一版插件包：旧版忽略 `beauticode-page-material`、`beauticode-page-blur` 与三个 `beauticode-material-*` 键（`alpha-step`、`blur-step`、`max-blur`）；面板键 `beauticode-readable-surfaces` 保持兼容。
- 旧版会恢复全局 8 token 面板规则和插件页透明；页面材质消失，属于预期。发布说明必须写明这一点。
- 回滚不需要 DSH 文件、媒体档案或主题数据迁移；localStorage 中新增键无害，可在后续版本清理或保留。
- 打包/安装流程不变：`npm run plugin:pack` 生成候选包，安装旧包即可；若需要完全干净，卸载插件后清除背景并移除新增 localStorage 键。

### 6.3 发布顺序

1. 先合入 t1（本 ADR）。
2. t2/t3 分别实现核心和控制台，保持存储键/事件/变量名一致。
3. t4 独立验证，记录命令、结果、跳过项、与 ADR 的差异；t8 曾尝试页面同根背板，t9 复验 V3；t10 因 V9/V10/V11 回退页面 alpha-only，t11 独立复验并关闭 V3/V9–V13。
4. t13/t14/t15 曾加入默认关闭的实验页面模糊并独立复验；t17–t19 现场修复将其改为默认开启，并把面板默认改为 60%、tooltip 移出材质、页内浮层暂停页面模糊；t19 报告 §19。
5. t21–t23 移除方向配置并固定越上层越实；t24 更新 `docs/deepseek-harness.md`、`integrations/deepseek-harness/README.zh-CN.md`、本 ADR 与验证记录，补侧栏/主会话边界，并记录最终 git 状态/测试结果；t25 做提交前文档审计，t26 修复四份文档并把最终状态记入验证记录 §24。
6. 发布前至少跑通单元测试、控制台测试、可用的浏览器测试和真实 DSH 现场检查；当前真实 DSH 运行上一版候选，需重新安装/重启后现场确认，未确认前不得宣称本轮现场通过。V14、V11、V13、V16 仍需现场/产品确认。

## 7. 实施落点

| 任务 | 文件 | 必须完成 |
|---|---|---|
| t2 | `readability.js`、`client.js`、`test/readability.test.mjs`、`test/plugin-readability.browser.test.mjs`（fixture 可放 `test/fixtures/`） | 材质根重写、候选/层级、sqrt 模糊、MutationObserver、0% 回退、测试 |
| t3 | `console.js`、`test/console.test.mjs` | 两个独立滑杆、高级设置、存储/事件/跨窗口、旧键兼容 |
| t4 | `docs/verification/` 新文件 | 独立验证与现场记录；不改产品代码 |
| t5 | `docs/deepseek-harness.md`、`integrations/deepseek-harness/README.zh-CN.md` | 同步默认值、锚点、边界、风险、回滚；链接 ADR/验证 |
| t10/t11 | `readability.js` + 测试 + 验证记录 | 页面 alpha-only 回退；关闭 V3/V9–V13；V14/V15 记录 |
| t12 | 两份用户文档 + 本 ADR + 验证记录 | 移除 v1 背板过期描述；记录 alpha-only 测试/git 状态/V14 开放 |
| t13/t14/t15 | `readability.js`、`console.js` + 测试 + 验证记录 | 实验页面模糊历史、API/控制台开关；独立复验（已被 t17–t19 的默认开启取代） |
| t16 | 两份用户文档 + 本 ADR + 验证记录 | 实验项文档历史；已被 t20 取代 |
| t17/t18/t19 | `readability.js`、`console.js`、fixture + 测试 + 验证记录 | 面板默认 60、页面模糊默认开、tooltip 不材质化、页内浮层暂停；独立复验 |
| t20 | 两份用户文档 + 本 ADR + 验证记录 | 删除实验默认关闭旧文案；写入面板 60、页面模糊默认开、tooltip/暂停、V9/V10 默认仍存在、V11/V13/V14/V16；最终测试 |
| t21/t22/t23 | `readability.js`、`console.js`、测试 + 验证记录 | 固定越上层越实；删除方向行/键/API；旧键忽略；独立复验 |
| t24 | 两份用户文档 + 本 ADR + 验证记录 | 删除方向/实验旧文案；补侧栏/主会话边界；链接 §19/§21；最终测试/git |
| t25/t26 | 四份文档 | t25 只读审计；t26 修复方向/默认值/旧话术/交叉引用并重跑测试、链接检查 |

t2 不得改 `console.js` 或文档；t3 不得改 `readability.js`/`client.js`。两边共享的键名、事件名、`data-bc-*` 属性和 CSS 变量名以本 ADR 为准。

## 8. 附录：夹具复现

### 8.1 文件与参数

- `index.html`：四格嵌套 case，`modes = { none:[0,0,0], fixed:[4,4,4], sqrt:[4,4√3,4√5], outer:[12,0,0] }`；每格 760×680，三层 `.layer` 内缩 30px，背景为 8px 棋盘 + 文本。
- `index2.html`：`l1-only:[4,0,0]`、`inner-only:[0,4√3,4√5]`、`sibling-fixed:[4,4,4]`、`sibling-sqrt:[4,4√3,4√5]`；用于证明嵌套内层被忽略、兄弟层会合成。
- `cross-root.html`：`#page` 在 `#root` 内，`#panel` 为 `position:fixed` 的兄弟节点；query `?page=4&panel=4`、`?page=4&panel=6.93`、`?page=5.66`、`?page=8` 等。
- 测量：截图转灰度，取每格/中心 120×120，计算 std 与 Laplacian 高频能量；`compare.py`/`measure2.py` 另外计算 mean abs diff。

### 8.2 复现命令

```powershell
# Python 使用带 Pillow + numpy 的运行时
python .tmp/backdrop-fixture/compare.py
python .tmp/backdrop-fixture/measure.py
python .tmp/backdrop-fixture/measure2.py
python .tmp/backdrop-fixture/measure-cross.py
```

结论值已固化在 §2.3 / §2.4；若重新截图，像素结果允许有抗锯齿/GPU 差异，但 `fixed` 与 `sqrt` 必须仍然逐像素等价，`fixed` 与 `outer` 必须明显不同，跨 root 的 4+4 必须接近单层 5.66、4+6.93 必须接近单层 8。**页面默认应用 2.4px 页面模糊**：该平方和夹具验证页面背板 + 面板半径模型；cross-root 的页面 4px 是模型示例，不是当前默认（默认 2.4px，暂停/关闭/0% 为 0）。

### 8.3 为什么用平方和而不是线性相加

线性相加会得到 8px（4+4）或 10.93px（4+6.93），与实测的单层 5.66/8 不符；取最大值会得到 4px，也不符。只有 `sqrt(s_1² + s_2²)` 同时解释这两组结果。夹具 A 进一步排除了「嵌套层可以各自叠加」的可能。

## 9. 明确不做

- 不为无 role 的第三方浮层做启发式识别。
- 不给嵌套层添加独立模糊。
- 不修改 DSH 源码、构建产物或宿主 CSS。
- 不根据视口尺寸、z-index 或 `position:fixed` 猜测页面/浮层语义。
- 不承诺页面材质在任意壁纸上达到 4.5:1。
- 页面模糊默认开启，但页面根自身不持有 `backdrop-filter`；模糊只走 `::before` 背板。关闭页面模糊、页面 0% 或页内浮层暂停时，页面只保留 30% 底色。不得把暂停机制写成“V9/V10 已解决”：无页内浮层时 V9/V10 仍存在。
- 不引入材质动画、渐变过渡或按页面单独配置页面强度；本轮只有全局页面/面板强度、三个高级档位和页面模糊开关。嵌套固定越上层越实，不提供方向配置。
- 不改变 `client.js` 的背景阴影、壁纸磨砂、会话阶段、画窗/摸鱼逻辑。

## 10. 验证记录、文档与交付状态

- 独立验证记录：[`docs/verification/2026-11-10-dsh-layered-material.md`](../verification/2026-11-10-dsh-layered-material.md)。§12–§18 是历史（t7/t9/t5/t11/t12/t15/t16），§19 是 t19 现场修复复验，§20 是 t20 历史；§21 是 t23 方向移除/越上层越实复验，§22 是 t24 文档同步/最终集成记录，§23 是 t25 提交前审计；**§24 是 t26 文档一致性修复与最终状态**。
- 用户文档：[`docs/deepseek-harness.md`](../deepseek-harness.md) 与 [`integrations/deepseek-harness/README.zh-CN.md`](../../integrations/deepseek-harness/README.zh-CN.md) 已按 **页面 30% + 页面模糊默认开启、面板 60%、tooltip 宿主样式、页内浮层暂停、固定越上层越实**同步；侧栏/主会话不在页面材质内。
- 最终自动化结果（t26 重跑后）：t4（t6 修复后）/t7/t9/t11/t15/t19/t23 浏览器材质用例均为 **15/15 pass，0 skip**；全量 harness **150/150 pass，0 skip**；`readability.test.mjs` **21/21**；`console.test.mjs` **49/49**（合计 70/70）；`node --check` readability/client/console 全部通过；`git diff --check` 无空白错误。以上是 Chromium/Edge fixture 与真实浏览器联动结果，不是真实 DSH 现场验收。
- 最终风险状态：**V3 fixed 关闭**；**V9/V10 默认页面模糊开启且无页内浮层时仍存在**（absolute 250、default-outside），页内浮层暂停时回到 10/12、high-inside，暂停结束恢复；**V11 开放**（滚动底部 delta 1）；**V12 关闭**；**V13 开放**（页面 `::before` 覆盖）；**V14 开放**（关闭页面模糊时 30% alpha 不能消除后方文字透出）；**V15 已闭合**；**V16 开放（低-中）**（暂停选择器可能被常驻页内控件长期触发）。V4–V8 状态不变（多独立浮层共用 s2、纯空白存储值、backdrop-model 未进 CI、真实 DSH 运行旧插件）。
- 方向配置已移除：`beauticode-material-direction` 不读不写，嵌套固定 `root + (depth-1)*step`；旧存储值保留但无影响。侧栏/主会话不随页面/面板材质变化：侧栏由 `client.js` 的 `--bc-surface-mix`/`--dsw-specific-sidebar-fill` 决定，主会话没有 `[data-global-panel]`。
- 真实 DSH 当前运行上一版候选，未验证本轮 tooltip/暂停/面板 60/页面模糊默认开启/方向移除；需重新安装/重启候选后现场确认，不得宣称本轮现场通过。V14/V11/V13/V16 仍需现场/产品确认。
- 三个 fixture 已随上一提交纳入版本控制，当前 `git status` 无未跟踪 fixture；交付时确认提交包含 `integrations/deepseek-harness/test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html`。

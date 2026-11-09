# ADR 0011：DSH 分层材质与页面/面板独立强度

- 状态：接受（冻结；t2/t3/t4 实施；t8 页面背板 → t10 回退 **alpha-only**，t11 复验；t13/t14 增加默认关闭的「页面模糊（实验）」选配，t15 独立复验）
- 日期：2026-11-10
- 基线：main `71b641b`
- 关联：[ADR 0002](0002-dsh-functional-surface-readability.md)、[#92 验收记录](../verification/issue-92-plugin-readability.md)、[分层材质验证记录](../verification/2026-11-10-dsh-layered-material.md)、任务 t1/t5/t12/t16
- 范围：`integrations/deepseek-harness/readability.js`、`client.js`、`console.js` 及其测试与文档；不修改 DSH 源码。

## 摘要

把当前「功能面板不透明」的单一百分比，升级为两条互相独立的材质通道：

1. **页面材质**：只在页面模式的 MainPanel 布局列 `[data-global-panel]` 上铺一层 **30% alpha 底色**；默认实现为 **alpha-only**，页面不应用 `backdrop-filter`、不创建 `position`/`isolation`、不使用 `::before` 背板。页面强度仍作为面板模糊模型尺度 `I`（默认 2.4px）参与面板半径计算，但页面本身没有实际模糊；`getBlur().page` 默认 0。主会话没有这个锚点，因此不铺页面材质。
2. **面板材质**：标准 ARIA 浮层（dialog / alertdialog / menu / listbox / tooltip）、消息编辑栏和待交互面板卡片，默认强度 100%；作为独立覆盖层时只应用一次 `backdrop-filter`，默认半径 3.69px，由平方和模型反推，而不是把 100% 直接乘成 8px。

**可选实验（默认关闭，不推荐）**：「页面模糊（实验）」开关。开启后恢复 v1 同根 `::before` 背板（`data-bc-page-blur="true"`、页面根 `position:relative`/`isolation:isolate`、背板 `blur(2.4px)`），页面 alpha 仍 30%；默认关闭时页面完全 alpha-only。实验开启会重新引入 V9 absolute 包含块、V10 isolation 层叠、V11 滚动底部失模糊；fixed 仍 60/60，不重新引入 V3 fixed 偏移。该选项只用于 DSH 现场实测，不作为推荐默认，也不能宣称解决 V14。

嵌套层（其祖先已经命中材质根）**只按 alpha 步长递增，绝不应用 `backdrop-filter`**。夹具已证明嵌套的 `backdrop-filter` 不会叠加：外层固定 4px 与「4 / 6.93 / 8.94px」逐像素相同，mean abs diff 为 0；跨 root 的页面 4px + 面板 4px 等价于单层 5.66px，页面 4px + 面板 6.93px 等价于单层 8px，平方和模型成立。该平方和模型现在只用于面板半径（页面通道不实际模糊）。

本 ADR 同时取代 ADR 0002 中「插件页必须完全透明」的结论：插件页改为 30% 页面底色，但保留文字光晕与色阶辅助；旧的全局面板 8 token 替换式规则被删除，改为材质根作用域的规则。**页面不再有 2.4px 模糊，是 t10 的用户可见设计变更**；取舍 V14 见 §4.1。

## 1. 背景与现状

### 1.1 当前实现

- `client.js` 在 `html[data-bc-active="true"] body` 上把 DSH 的表面 token 改写为半透明（chrome 36%、内容 36%，会话阶段 active/settling 提升到 86%/72%，见 `integrations/deepseek-harness/client.js:51-217`）。壁纸磨砂作用在媒体元素自身的 `filter` 上，不使用 `backdrop-filter`（同文件 `:197-210`）。
- `readability.js` 用一条全局 `:is(...)` 规则把六类 ARIA 面板、`data-composer-card` 和三个待交互面板的内层卡片直接写成不透明底板，并通过 `--bc-readable-strength` 支持 0–100 强度（`integrations/deepseek-harness/readability.js:56-107`）。插件页则被明确排除在不透明名单之外，只保留光晕与色阶提升（同文件 `:102-106`；决策来源见 ADR 0002 的「插件页改回透明底」补充）。
- `console.js` 目前只有「功能面板不透明」「背景阴影」「背景磨砂」三行滑杆，滑杆是唯一事实来源，重置箭头写回默认值（`integrations/deepseek-harness/console.js:132-179`、`:827-866`）。
- 现有测试断言插件页所有表面 alpha 为 0、面板 100% 为 alpha 255、40% 约为 102、0% 回到宿主半透明（`integrations/deepseek-harness/test/readability.test.mjs`、`test/plugin-readability.browser.test.mjs`、`test/console.test.mjs`）。

### 1.2 为什么必须分层

单一强度无法同时表达三种不同的视觉对象：

- 页面（插件页、技能页、自动化任务等）是一整列背景，需要一层轻材质和轻微模糊，但不能像 #92 早期那样铺成实心色块。
- 浮层面板需要遮住后方正文，默认应接近不透明；但浮层内部还有菜单、列表、tooltip，不能每个都再叠一次模糊。
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
- 页面通道默认是 **alpha-only**：只写 30% 底色，不应用 `backdrop-filter`、不创建 `position`/`isolation`、不使用 `::before` 背板。页面强度只作为面板模糊模型的尺度 `I`，页面本身没有实际模糊，`getBlur().page = 0`。
- 唯一例外是显式开启的「页面模糊（实验）」：`data-bc-page-blur="true"` 时页面根恢复 `position:relative`/`isolation:isolate` 与 `::before` 背板（blur 2.4px），默认关闭。实验风险见 §4.1；不推荐、不作为默认。
- 页面材质只作用于该列；侧栏、右栏、shell overlay 不铺页面材质。

#### 面板通道

候选元素（只认宿主语义属性/角色，不认构建类名）：

- `[role="dialog"]`
- `[role="alertdialog"]`
- `[role="menu"]`
- `[role="listbox"]`
- `[role="tooltip"]`
- `[data-composer-card]`
- `[data-question-key] > section`
- `[data-plan-review-key] > section`
- `[data-approval-key] > div`

判定：

- 从 `element.parentElement` 开始执行 `closest('[data-bc-material-root]')`：
  - 为空：**独立根**，标记为 `data-bc-material-root="panel"`，全局 level 2，root 内深度 1。
  - 非空：**嵌套层**，标记为 `data-bc-material-layer`，全局 level = 最近根 level + 深度 - 1，root 内深度 = 2 + 位于该元素与根之间的候选祖先数。
- 嵌套层可以继续嵌套（菜单里的列表、列表里的 tooltip），深度逐级 +1，alpha 逐级递增/递减，但永远不加 `backdrop-filter`。
- 独立面板根一律默认强度 100%（alpha 1）；它的 level 2 只表示层级，不参与 alpha 步长。alpha 步长只作用于**根内嵌套层**。

#### 跳过与不处理

- `[data-shell-overlay]`（宿主 `shell.overlay`）容器：**整体跳过，不作为页面/面板通道的锚点，也不是材质根，不铺材质**。这里的「跳过」指跳过容器本身，不是跳过它内部的所有浮层：其中的 dialog/menu 等标准 role 仍照常按上面的规则判定为独立或嵌套。这样同一个 overlay 容器里的多个浮层各自独立，不会因为共同父层退化成嵌套层。
- 无标准 role 的第三方浮层（自定义 div、只靠 z-index 的 popover）：**不标记、不铺材质、不加模糊**。它们可能继承所在材质根的 token，但不会成为独立的材质层。这是明确边界，不用 `position: fixed`、全屏尺寸或高 z-index 扫描兜底。
- `#beauticode-*` 自身 UI：不进入候选集合；控制台页面在设置 dialog 内部，随所在面板根获得材质，但不单独成为材质层。

### 3.2 分层、默认值与属性契约

#### 默认值

| 项 | 默认值 | 说明 |
|---|---:|---|
| 页面材质强度 | 30% | alpha 0.30；页面实际模糊 **0**。`0.30 × 8px = 2.4px` 只是面板 sqrt 模型的尺度 `I`；`getBlur().page=0` |
| 面板材质强度 | 100% | alpha 1.00；独立根不透明；默认页面下 blur 3.69px |
| 页面模糊（实验） | 关闭 | 仅字面 `true` 开启；开启后恢复页面 `::before` 背板 blur 2.4px，页面 alpha 仍 0.30 |
| 嵌套 alpha 步长 | 8% | 每深一层 +8 或 -8 个百分点 |
| 嵌套模糊步长 | 2px | 页面根之后，每多一个独立覆盖层，总模糊增加 2px |
| 最大模糊 | 8px | 页面+面板栈的总模糊上限 |
| 自动档位方向 | 越上层越实 | 嵌套层 alpha 递增；可切换为越上层越透 |

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
| `data-bc-material-blur` | 独立根 | `"on"` | 面板根在半径 > 0 时存在；页面根仅在实验开启且页面强度 > 0 时存在，用于触发 `::before` 背板；默认不存在 |

根/嵌套层的内联变量：

| 变量 | 值 | 说明 |
|---|---|---|
| `--bc-material-alpha` | `0`–`1` | 该表面的最终 alpha |
| `--bc-material-blur` | 如 `2.40px` | 面板根与嵌套层规则使用；页面根默认不设置，实验开启时设为 2.40px 并由 `::before` 背板实际应用 |

`html` 上的变量与门控：

| 名称 | 值 | 说明 |
|---|---|---|
| `data-bc-page-material` | `"true"` 或缺失 | 页面强度 > 0 时存在；0 时移除 |
| `data-bc-page-blur` | `"true"` 或缺失 | 仅「页面模糊（实验）」开启且页面强度 > 0 时存在；默认缺失 |
| `data-bc-readable-surfaces` | `"true"` / `"false"` | 面板强度 > 0 / = 0；保留旧契约 |
| `--bc-page-material-strength` | 0–100 | 页面强度，供调试与测试 |
| `--bc-readable-strength` | 0–100 | 面板强度；保留旧变量名 |
| `--bc-material-alpha-step` | 0–30 | 百分点 |
| `--bc-material-blur-step` | 0–8 | px |
| `--bc-material-max-blur` | 0–16 | px |
| `--bc-material-direction` | `"up"` / `"down"` | 越上层越实 / 越上层越透 |

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
html[data-bc-active="true"] [data-bc-material-root="panel"]{--bc-material-alpha:1;}

/* 页面根和嵌套层都铺材质；页面根不再改写 8 个 surface token，
   让页面内部保留 client.js 的既有表面层次，页面根只提供一层底板。 */
html[data-bc-active="true"] [data-bc-material-root],
html[data-bc-active="true"] [data-bc-material-layer]{
  --bc-material-fill:color-mix(in srgb,var(--bc-material-base,#232833) calc(var(--bc-material-alpha,1) * 100%),transparent);
  background-color:var(--bc-material-fill);
}

/* 面板根和嵌套层改写 8 个 token，保证浮层内部组件共享同一块材质。 */
html[data-bc-active="true"] [data-bc-material-root="panel"],
html[data-bc-active="true"] [data-bc-material-layer]{
  --dsw-alias-bg-base:var(--bc-material-fill);
  --dsw-alias-bg-layer-1:var(--bc-material-fill);
  --dsw-alias-bg-layer-2:var(--bc-material-fill);
  --dsw-alias-bg-layer-3:var(--bc-material-fill);
  --dsw-alias-bg-overlay:var(--bc-material-fill);
  --dsw-specific-input-major:var(--bc-material-fill);
  --dsw-specific-menu:var(--bc-material-fill);
  --dsw-alias-tooltip-bg:var(--bc-material-fill);
}

/* 面板独立根只应用一次；嵌套层永远不匹配这条规则。 */
html[data-bc-active="true"] [data-bc-material-root="panel"][data-bc-material-blur="on"]{
  -webkit-backdrop-filter:blur(var(--bc-material-blur,0px));
  backdrop-filter:blur(var(--bc-material-blur,0px));
}

/* 页面通道默认 alpha-only（t10/t11）：通用根规则即使命中 page root，
   也必须显式 none。页面不设置 position/isolation，也没有 ::before 背板。 */
html[data-bc-active="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]{
  -webkit-backdrop-filter:none;
  backdrop-filter:none;
}

/* 可选实验，默认关闭：只有 html[data-bc-page-blur="true"] 且页面根
   [data-bc-material-blur="on"] 时才恢复 v1 背板；实验风险见 §4.1。 */
html[data-bc-active="true"][data-bc-page-blur="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]{
  position:relative;
  isolation:isolate;
}
html[data-bc-active="true"][data-bc-page-blur="true"] [data-bc-material-root="page"][data-bc-material-blur="on"]::before{
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

- 旧的全局面板 8 token 规则和 `--bc-readable-fill` 删除；材质根规则取代它。
- 页面根不改写 8 个 token。页面内部的卡片/分组继续使用 `client.js` 发布的半透明 token，页面根只加一层 30% 底板。否则每个子表面都再用 30% fill，会在卡片区域叠成更深的色块。
- 面板根/嵌套层改写 8 个 token，因为浮层内部组件（菜单、列表、输入区）必须共享同一块材质，不能透出后方正文。
- `background-color` 不用 `!important`；靠 `html[data-bc-active="true"]` 的特异性覆盖宿主类名。若现场发现宿主内联背景压过该规则，再按同一根作用域加 `!important`，并记录到验证报告。
- 页面通道当前默认为 **alpha-only**：只设 `background-color`，不设置 `position`/`isolation`、不创建 `::before` 背板、不应用 filter。默认页面根也**不再带** `data-bc-material-blur="on"`/inline `--bc-material-blur`；只有实验开启时才出现，并由 `html[data-bc-page-blur="true"]` + 页面根 blur 标记启用背板。不设置 `background-image`、尺寸、圆角、边框、间距、滚动或命中区域。
- 0% 时不设置任何材质标记；CSS 规则整体不匹配，页面只保留宿主/`client.js` 的半透明外观；面板根不残留 filter。清除背景时 `data-bc-active` 移除，材质规则同样不匹配。

#### 层级计算

- 页面根 alpha = 页面强度 / 100。
- 独立面板根 alpha = 面板强度 / 100。
- 嵌套层：

```
alpha = rootAlpha + (direction === "up" ? 1 : -1) * (depth - 1) * alphaStep / 100
alpha = clamp(alpha, 0, 1)
```

- 方向默认 `"up"`（越上层越实）；`"down"` 时嵌套层逐级变透。独立根不受方向影响。
- 嵌套层 alpha 达到 0 或 1 后夹取，不再变化。

### 3.3 用户配置与存储

#### 两个独立滑杆

| UI 行 | 默认 | 作用 |
|---|---:|---|
| 页面材质 | 30% | 页面通道；插件页、技能页、自动化任务等 |
| 功能面板不透明 | 100% | 面板通道；保留现有标签和语义，内部称「面板材质强度」 |

两行互不重置；移动一个不改变另一个的存储值或 alpha。页面通道 0% 只关闭页面底色；面板通道 0% 只关闭面板材质。需要说明的是：页面强度同时是面板模糊模型的尺度 `I`，所以改变页面强度会按 §3.4 改变面板的 blur 半径——这是模型耦合，不是配置耦合；页面本身不应用模糊，面板强度本身仍只控制面板 alpha。

#### 高级设置

独立分组「高级设置」，沿用现有行结构：

| 行 | 范围 | 默认 | 说明 |
|---|---:|---:|---|
| 材质档位间隔（透明度） | 0–30% | 8% | 嵌套层每深一层的 alpha 变化 |
| 材质档位间隔（模糊） | 0–8px | 2px | 每多一个独立面板层，模型总模糊增加量 |
| 最大模糊 | 0–16px | 8px | 面板栈的模型总模糊上限（页面强度只提供尺度 `I`） |
| 自动档位方向 | 越上层越实 / 越上层越透 | 越上层越实 | 只影响嵌套层 alpha |
| 页面模糊（实验） | 开 / 关 | 关 | **不推荐**；开启恢复 v1 页面 `::before` 背板，重新引入 V9/V10/V11 实验风险；页面 0% 时开关 disabled 但存储保留 |

方向用与「声音」同类的双态按钮（`aria-pressed`）或等价单选控件，不引入新组件库；标签显示实际状态。页面模糊实验行文案固定为「默认关闭；开启后会启用页面背板，可能影响页面内 fixed/absolute/高层浮层；仅建议现场试验」，页面 0% 时显示「需要页面材质 >0」提示并禁用按钮/重置。

#### 存储键与迁移

| 键 | 类型 | 默认 | 规则 |
|---|---|---:|---|
| `beauticode-page-material` | 数字 0–100 | 30 | 缺失/无效 → 30；0 写 `"0"` |
| `beauticode-page-blur` | 布尔字符串 | `"false"` | 仅字面 `"true"` 开启；缺失/无效/读取失败 → false；实验、默认关闭 |
| `beauticode-readable-surfaces` | 数字 0–100，兼容布尔 | 100 | `"true"` → 100；`"false"` → 0；数字夹取；缺失/无效 → 100；0 仍写 `"false"` 以兼容旧版回滚 |
| `beauticode-material-alpha-step` | 数字 0–30 | 8 | 缺失/无效 → 8；整数 |
| `beauticode-material-blur-step` | 数字 0–8 | 2 | 缺失/无效 → 2；整数 |
| `beauticode-material-max-blur` | 数字 0–16 | 8 | 缺失/无效 → 8；整数 |
| `beauticode-material-direction` | `"up"` / `"down"` | `"up"` | 无效 → `"up"` |

- 所有读取失败、存储被拒绝、无效值都回退默认值；写入失败时当前页面仍按内存值生效。
- 页面模糊实验通过 `BeauticodeReadableSurfaces.getPageBlur()` / `setPageBlur(boolean)` 读写；默认 false，写入 `"true"`/`"false"`。`get/set/getPage/setPage/getMaterial/setMaterial` 的既有形状不变。
- `getBlur()` 返回**实际应用值**：默认 `{page:0, panel:3.69}`；实验开启且页面强度 > 0 时 `{page:2.4, panel:3.69}`。页面强度仍作为面板半径的模型尺度 `I`，但 `page` 不再报告模型值 2.4（默认）。
- 写入后立即更新 `html` 变量、材质标记和 CSS，并派发 `beauticode-material-change`；面板强度变化额外派发旧事件 `beauticode-readability-change`，兼容现有监听者。
- 同源其他窗口通过 `storage` 事件读取同一组键并重算；`beauticode-page-blur` 也在白名单内，忽略无关键。
- 重置箭头写回该行默认值（30 / 100 / 8 / 2 / 8 / `"up"` / 页面模糊 false），不写「未设置」；页面 0% 时页面模糊按钮/重置 disabled、显示「需要页面材质 >0」，存储选项保留，恢复页面强度 >0 后背板自动恢复。
- 升级迁移：页面材质是新增通道，默认 30%；旧用户升级后会开始看到页面底板，可在「页面材质」行拉到 0% 关闭。面板键沿用旧值，不需要迁移。
- 回滚兼容：旧版只读 `beauticode-readable-surfaces`；页面/高级键对旧版是未知键，会被忽略。旧版读到 `"false"` 仍关闭面板；读到 `"100"` 仍视为开启；中间值旧版视为开启（保守方向）。

#### 0% 语义

- 页面 0%：移除页面根标记、页面底色、页面光晕/色阶辅助；若实验开启，同时移除 `data-bc-page-blur`/页面根/背板，但保留 `beauticode-page-blur="true"` 存储选项；恢复页面强度 > 0 后背板自动恢复。页面回到 `client.js` 的半透明宿主外观。面板材质不受影响。
- 面板 0%：移除所有面板根/嵌套层标记、模糊和局部 token；role 面板、编辑栏、待交互卡片回到 `client.js` 的半透明外观；页面材质不受影响。
- 两者都 0%：没有材质标记，等同当前半透明宿主外观。
- 这里的「宿主」按本项目既有叫法，指 **beautiCode 已改写的半透明 DSH 外观**（`client.js` 发布的 token），不是未经 beautiCode 处理的 DSH 原生实色；清除背景或卸载插件才会回到原生外观。

### 3.4 模糊模型

记：

- `I` = 面板模糊模型的页面尺度 = 页面强度 / 100 × 最大模糊（默认 `0.30 × 8 = 2.40px`）。默认页面本身不应用这个模糊，它只用于推导面板半径；只有实验开启时才把 `I` 送到 `::before` 背板。
- `B` = 模糊步长（默认 2px）。
- `M` = 最大模糊（默认 8px）。
- `T_n` = 第 n 层独立材质的目标总模糊。
- 嵌套层不参与 n，也不加 filter。

#### 页面根

```
T_1 = I                         （面板 sqrt 模型的尺度）
s_1 = 0                         （默认 alpha-only，页面不应用模糊）
s_1 = I                         （仅「页面模糊（实验）」开启时，送到 ::before 背板）
```

页面通道默认是 **alpha-only**（t10/t11）：页面只保留 30% 底色，不持有 `backdrop-filter`，也没有 `::before` 背板、`position`/`isolation`。`I` 仍作为面板 sqrt 模型的尺度，但 `getBlur().page` 默认返回 **0**（实际应用值）；实验开启且页面强度 > 0 时才返回 2.4，并由背板实际应用。默认路径没有页面 blur 标记/变量。

如果页面强度为 0 或页面锚点不存在：`I = 0`，没有页面根，也没有页面 filter/背板；即使实验存储为 `"true"`，`data-bc-page-blur` 也会被移除，`getBlur().page = 0`。

#### 独立覆盖层（level 2）

```
T_2 = min(M, I + B)
s_2 = sqrt(T_2² - I²)
```

- 默认：`I = 2.4`，`B = 2`，所以 `T_2 = 4.4`，`s_2 = sqrt(4.4² - 2.4²) = 3.69px`。
- 如果页面材质不存在/为 0（主会话、或用户关闭页面材质）：`I = 0`，`s_2 = B = 2px`。面板默认仍为 100% alpha；模糊步长是面板的第二层贡献，面板强度本身不缩放模糊。
- 如果 `M = 0` 或 `B = 0` 或 `T_2 = I`：`s_2 = 0`，不设置 `data-bc-material-blur`，不写 `blur(0px)`。
- 页面 100% 时 `I = 8 = M`，`T_2 = 8`，`s_2 = 0`：模型尺度达到上限，面板不再叠加（页面本身仍无模糊）。

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

- 面板默认 alpha 100%，模糊主要作用于面板后方的壁纸，不影响面板文字；
- 嵌套在 dialog 内的菜单不产生 filter，只有真正 portal 到 root 外的菜单才会计入；
- 若未来需要严格按视觉栈计数，再引入几何重叠排序；本轮不为此增加布局读取和复杂度。

### 3.5 与 ADR 0002 / 旧实现的关系

- **取代**「插件页完全透明」：插件页改为 30% 页面底色，默认**不添加页面模糊**（除非用户显式开启「页面模糊（实验）」）；保留文字光晕和色阶提升。这不是回到 #92 早期的实心底板；默认 alpha 0.30，壁纸仍明显透出。面板 blur（默认 3.69px）不受影响。
- **保留**「功能面板不透明」滑杆和 `beauticode-readable-surfaces` 键，但内部语义固定为面板材质强度；0% 仍是关闭并回到半透明。
- **重写** 全局面板 8 token 规则：不再用一条 `:is(...)` 规则把所有 role 面板写成同一块底板；改为材质根/嵌套层作用域。旧规则删除，避免与新规则双重叠加。
- **保留** `client.js` 的 `--bc-surface-mix` / `--bc-content-mix`、会话阶段、背景阴影、壁纸磨砂、画窗/摸鱼逻辑；新材质只在其上增加页面/面板层。
- **改变** 插件页辅助的门控：从面板强度改为页面强度。页面 0% 时插件页不再有光晕/色阶提升；面板 0% 不影响页面辅助。

## 4. 风险、边界与取舍

### 4.1 页面 alpha-only（默认）：V3/V9–V13 关闭，V14 开放，V15 默认消失；实验项 opt-in

`backdrop-filter` 会为 fixed/absolute 后代创建包含块。t4/t7 曾复现：页面根直接带 filter 时，列内 `position:fixed` 元素从视口 `x=60` 偏移到列内 `x=300`（pageX 240 + 60），portal 到 body 的 fixed 仍为 `(40,40)`。t8 用同根 `::before` 背板修掉 fixed 偏移，但背板必须依赖 `position:relative`（V9 absolute 包含块）、`isolation:isolate`（V10 层叠困住）或 `absolute inset:0`（V11 滚动页面底部失模糊）；固定/JS 同步子层又只能看到壁纸，看不到页面后方的 in-flow 会话（合成会话时 blur 开关 max channel delta 0，隐藏会话后壁纸 delta 89）。

**t10 最终回退为页面 alpha-only**（t11 独立复验）：页面只保留 30% 底色，`backdrop-filter:none`、`filter:none`、`position:static`、`isolation:auto`，没有 `::before`/背板。结果：

- **V3 关闭**：页面内 fixed 开/关均 `(60,60)`，portal fixed 开/关均 `(40,40)`。
- **V9 关闭**：页面内 absolute 探针开/关均 `(10,12)`（相对 `#root`）。
- **V10 关闭**：页面内 `z-index:9999` 与页面外 `z-index:1` 兄弟重叠时，开/关均命中 `high-inside`。
- **V11 关闭**：fixture `scrollHeight 836 / clientHeight 800 / overflow:auto`，`scrollTop=36` 后底部 strip 开/关 fill max channel delta **67**，页面 fill 仍覆盖滚动视口；无背板可丢。
- **V12/V13 关闭**：不再设置 `position`/`isolation`，也不再使用页面 `::before`。
- **V14（开放，产品取舍）**：30% alpha 只能减弱、不能消除后方文字透出。高对比示例中，后景文字对比度从 **21:1 降到 10.68:1**，仍清晰可见；如果最初问题是会话/背景文字在页面后明显重叠，30% 不足，需要 Lead/产品确认。**页面不再有 2.4px 模糊，这是用户可见的设计变更**。
- **V15（默认消失；实验开启时是实际 blur）**：t13 后默认页面根不再带 blur 标记/变量，`getBlur().page = 0`；只有实验开启时才带标记/变量并实际应用 2.4px。不得再把默认的 page 2.4 当模型值读取。

**「页面模糊（实验）」opt-in**：默认关闭，开启后由 `html[data-bc-page-blur="true"]` + 页面根 `[data-bc-material-blur="on"]` 恢复 v1 背板。t15 实测：页面 alpha 77/255，`position:relative`/`isolation:isolate`，`::before` blur 2.4px；fixed 仍 `(60,60)`、portal `(40,40)`（**不重新引入 V3 fixed 偏移**），但 absolute 探针变为 `(250,12)`（V9）、页面内 z9999 被外部 z1 兄弟压过（`high-outside`，V10）、`scrollTop=36` 后底部 36px 模糊 delta 1（V11）。这些是 opt-in 的已知实验风险，不作为默认回归；开启后必须重新现场验收 V9–V13，且不能宣称实验项解决 V14。关闭或页面 0% 会移除 flag/背板/position/isolation，`getBlur().page` 回到 0，absolute/fixed/stacking 恢复。

面板根（dialog/menu）仍是独立浮层，直接持有 filter；其包含块变化通常可接受，但仍需在 fixture 与现场检查内部 fixed 元素和弹层定位。不得用 `transform`、`contain`、`will-change` 掩盖偏移，也不得接受偏移后宣称通过。

### 4.2 页面级性能

默认页面通道不再有 `backdrop-filter`，因此没有整列页面模糊的每帧 GPU 开销；面板、菜单、tooltip 的 filter 面积小。若显式开启「页面模糊（实验）」，会恢复页面 `::before` 背板的全列模糊开销，属于 opt-in 的实验成本，需现场测量。仍是 Chromium/Edge fixture 结论，真实 DSH 视频帧时间和观感未测。

措施：

- 页面 alpha-only；面板独立根每层只应用一次 filter，嵌套层不加 filter（夹具 A 也证明无效）。
- 页面强度 0% 关闭页面底色；面板最大模糊 0 关闭面板 filter。
- 不在根上添加 `will-change`，不创建额外舞台节点。
- t4/t9/t11 已在真实 Chromium（Edge）中验证材质/alpha-only；真实 DSH Web/Desktop 的视频性能仍需现场记录。若出现明显卡顿，先记录数值和场景，再讨论调整默认值。本轮不擅自动态降级或静默关闭。

### 4.3 嵌套层没有独立模糊

接受。嵌套层只能通过 alpha 步长与根区分；如果某个嵌套浮层视觉上需要更强的模糊，正确做法是让它成为独立 root（通常是 portal 到 body），而不是给它再加一层 filter。根已有 filter 时嵌套 filter 会被忽略；根没有 filter 时嵌套 filter 会违背 `maxBlur=0` / 0% 的关闭语义。

### 4.4 `data-global-panel` 语义变化

- 默认只增加 `data-bc-*` 与 `background-color`；不改变属性值、不删除、不改 `padding`/`display`/`position`，不设置 `isolation`，也不使用 `::before`。页面根只获得 30% 底色（alpha-only），布局/层叠与“页面材质关闭”一致。
- 仅当用户显式开启「页面模糊（实验）」时，才在 `html[data-bc-page-blur="true"]` 下给页面根加 `position:relative`/`isolation:isolate` 与 `::before` 背板；这是 opt-in 的实验副作用（V9/V10/V11），默认不出现，页面 0%/关闭开关时完全移除。
- 若宿主改名或移除该属性：页面材质不生效，失败关闭；不使用 `#root`、body、路由或尺寸兜底。面板材质不受影响。
- 若宿主在会话模式也输出该属性：需要在适配层重新验证；在确认前，页面材质可能误铺到会话。实现不得用猜测掩盖，测试 fixture 必须同时覆盖「有属性=页面」和「无属性=会话」。
- 页面内容若自带不透明背景，可能盖住 30% 底板；自动化 fixture 未覆盖真实页面内容，需现场检查插件页、技能页、自动化任务。若确实被盖住，只调整页面内容根的背景，不改变锚点语义。

### 4.5 页面文字对比度

30% 页面底色不是「任意壁纸都 ≥ 4.5:1」的保证。深色主题的浅色文字在纯白壁纸、浅色主题的深色文字在纯黑壁纸上仍可能低于门槛；页面通道没有模糊，只能依赖文字光晕和色阶提升缓解。

沿用 #92 的诚实取舍：在文档范围内（深色主题偏暗壁纸、浅色主题偏亮壁纸）断言达标；两个越界极值继续显式断言失败，不把门槛空过。V14 是相反方向的取舍：30% alpha 对**后方文字透出**只能把高对比从 21:1 降到 10.68:1，不能消除；页面前景文字可读性与“后方不重叠”不是同一件事。

### 4.6 双重材质/双重模糊

- 旧全局面板规则必须删除，否则同一 role 面板会同时命中旧规则和新材质根，出现双重底色。
- `client.js` 的壁纸磨砂是媒体元素上的普通 `filter`，不是 `backdrop-filter`；面板的 `backdrop-filter` 会在其之上再模糊一次，这是预期的两层效果，不纳入平方和模型（壁纸模糊是背景内容的一部分）。页面通道没有 `backdrop-filter`。
- 页面根不改写 8 个 token，避免页面内部每个卡片再叠一层 30% 底色；面板根改写 token 是为了浮层内部共享材质。两者不要混用。

### 4.7 回滚与旧版行为

- 旧版只认识 `beauticode-readable-surfaces`；读到 0 写的 `"false"` 会关闭，读到 100/中间值会开启。页面材质和高级键在旧版中不存在，回滚后消失，属于预期。
- 旧版的插件页是全透明；回滚后页面材质消失，插件页恢复透明 + 光晕。若用户已经习惯 30% 页面材质，回滚会看到明显变化，需在发布说明中写明。
- 不需要数据迁移、备份或 DSH 安装文件修改；所有偏好都在应用 localStorage。

## 5. 测试计划

### 5.1 单元测试（`readability.test.mjs`）

覆盖：

- 页面强度默认 30、面板默认 100；0 页面/0 面板独立生效。
- 旧 `beauticode-readable-surfaces`：`"true"`→100、`"false"`→0、数字夹取、无效→100；0 仍写 `"false"`。
- 页面 0 写 `"0"`；高级键默认 8 / 2 / 8 / `"up"`；范围夹取；无效值回退。
- 页面根标记、独立面板根标记、`data-shell-overlay` 不标记、无 role 浮层不标记。
- `closest` 判定：独立面板 level 2；嵌套层 level 递增、depth 递增、无 `data-bc-material-blur`。
- alpha 计算：页面 30 → 嵌套 38 → 46；方向 down → 22 → 14；面板 100 夹取；低面板强度下 down 递减。
- 模糊计算：模型页面尺度 2.4（页面实际 blur 0）；面板 3.69；页面 0 时面板 2；`maxBlur=0` 时全无 filter；`blurStep=0` 时面板无 filter；页面 100 时面板无 filter；`blur(0px)` 不出现。
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

- 页面默认：`[data-global-panel]` 有 `data-bc-material-root="page"`，computed background alpha ≈77（30%）；页面根 `backdrop-filter: none`、`filter: none`、`position: static`、`isolation: auto`，无 `::before` 背板；侧栏无页面标记。
- 会话：无页面标记；编辑栏/待交互卡片有 `data-bc-material-root="panel"`，alpha 255，`backdrop-filter: blur(2px)`（I=0）。
- 默认页面 + 独立 dialog：dialog alpha 255，`blur(3.69px)`；dialog 内 listbox 无 `backdrop-filter`，alpha 255；页面根内直接嵌套 role alpha 0.38、无 filter。
- 页面 100：页面 alpha 1、无 filter；dialog 无 filter（模型达到 maxBlur）。页面 0：页面 alpha 0、无 filter；dialog `blur(2px)`。
- 方向 down：页面嵌套 0.22、面板嵌套 0.92。
- 页面 0：无页面根、插件页光晕/色阶关闭；页面 0 后面板仍按 2px。
- 面板 0：无面板标记，role 表面回到 `client.js` 半透明；页面 30% 仍在。
- `[data-shell-overlay]` 自身无标记、无 filter；其内部 dialog 仍独立带 filter。
- 无 role 浮层无标记、无 filter、背景不变。
- fixed/absolute/层叠/滚动：portal fixed 与页面根内 fixed 均与关闭材质一致（`(40,40)` / `(60,60)`）；页面内 absolute 探针保持 `(10,12)`；高 z-index 探针保持 `high-inside`；页面列滚动后 fill 仍覆盖底部。页面通道不再创建包含块或层叠上下文。
- 插件页：30% 底板下白/黑壁纸截图必须不同（壁纸透出）；文字光晕和次级色阶存在；深/浅主题对比度按 30% 底板重新基线，越界极值仍失败。V14 断言只验证前景可读与底色存在，不宣称后方文字不重叠。
- V15：**默认**页面根无 blur 标记/变量，`getBlur().page = 0`、panel 3.69；只有实验开启时才允许出现 blur 标记/变量与 2.4px 实际值。
- 页面模糊实验：默认 `getPageBlur() === false`，无 `data-bc-page-blur`、无 `::before`、static/auto，absolute/fixed/stacking 与默认一致。开启后 `getPageBlur() === true`、flag/存储 `"true"`、根 `position:relative`/`isolation:isolate`、`::before blur(2.4px)`、alpha 77；fixed 60/60、portal 40/40，V9 absolute 250、V10 high-outside、V11 滚动底部 delta 1（实验已知项）；面板 blur 3.69 不变。关闭/页面 0% 后 flag/背板/定位全部移除，存储选项保留，页面 0% 时控制台按钮/重置 disabled、提示可见，恢复 30% 后背板自动恢复。
- 0% 与基线（不注入 readability）计算样式一致；100% 面板 alpha 255；40% 面板 alpha ≈102；旧行为不回归。

### 5.3 控制台测试（`console.test.mjs`）

覆盖：

- 新增「页面材质」行默认 30；现有「功能面板不透明」默认 100。
- 高级设置默认 8 / 2 / 8 / `"up"`；范围与标签显示。
- 滑杆 input 写存储、立即生效、标签同步；重置箭头写默认值；跨窗口 `storage` 重渲染。
- 页面 0 / 面板 0 的独立回退；旧 `"false"` 兼容。
- 方向切换的 `aria-pressed` 与存储值。
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
- 页面 alpha-only：只有 30% 底色，无页面 filter/背板/`position`/`isolation`；fixed `(60,60)`、portal `(40,40)`、absolute `(10,12)`、层叠 `high-inside`、滚动底部 fill 覆盖。V3/V9/V10/V11/V12/V13 均应由移除关闭。
- 页面后方文字透出（V14）：确认 30% 只能减弱、不能消除；需要产品/Lead 判断是否足够。不得把“前景可读”写成“后方不重叠”。
- V15：默认页面根无 blur 标记/inline 变量，`getBlur().page=0`、panel 3.69；只有实验开启时才出现 blur 标记/变量与 2.4px 实际值。
- 0% 页面、0% 面板、两者 0%、旧布尔迁移、跨窗口同步。
- `[data-global-panel]` / `[data-shell-overlay]` 在当前 DSH 版本的实际 DOM 与打包源码一致；宿主升级后重新检查。
- 本机真实 DSH 仍运行旧插件且无法访问渲染器 DOM；现场项未验证，不得把 Chromium fixture/Edge 自动化结果当作真实现场通过。详见[验证记录](../verification/2026-11-10-dsh-layered-material.md) §15/§16。

### 5.6 验收矩阵（实现完成的硬指标）

| 场景 | 页面根 | 面板根 | 嵌套层 |
|---|---|---|---|
| 页面默认 30% + 面板 100%（实验关闭） | alpha 0.30；无 filter/背板/position/isolation；`getBlur().page=0` | alpha 1.00，blur 3.69px | 无 filter；页面内 0.38，面板内 1.00 |
| 页面默认 + 页面模糊实验开启 | alpha 0.30；`relative/isolate`；`::before` 2.40px；fixed 60/60、portal 40/40；实验 V9/V10/V11 | alpha 1.00，blur 3.69px | 无 filter |
| 主会话（无 page） | 无 | 编辑栏/卡片 alpha 1.00，blur 2.00px | 无 filter |
| 页面 0% | 无标记、alpha 0、无 filter | alpha 1.00，blur 2.00px | 无 filter |
| 面板 0% | alpha 0.30；无 filter | 无标记、无 filter | 无标记 |
| 页面 100% | alpha 1.00；无 filter | alpha 1.00，无 filter | 无 filter |
| maxBlur 0 | alpha 0.30、无 filter | alpha 1.00、无 filter | 无 filter |
| blurStep 0 | alpha 0.30、无 filter | alpha 1.00、无 filter | 无 filter |
| direction down | 嵌套 0.22 | 嵌套 0.92 | 无 filter |

（上表为默认 8% alpha step、2px blur step、8px max blur 下的值；页面通道默认 alpha-only，页面根无 filter；实验开启是唯一例外，且只用于现场试验。面板 blur 不变。）

## 6. 回滚计划

### 6.1 用户级

- 页面材质异常：把「页面材质」拉到 0%，立即移除页面底色与插件页辅助；若实验开启，背板/定位也随页面根移除，但存储选项保留。
- 页面模糊实验异常：把「页面模糊（实验）」设为关闭（或重置箭头回 false），立即移除 `data-bc-page-blur`、`position`/`isolation` 与 `::before`；`getBlur().page` 回 0。默认无需任何操作。
- 面板材质异常：把「功能面板不透明」拉到 0%，立即回到旧半透明外观。
- 性能问题：页面 0% 或把「最大模糊」拉到 0；面板 alpha 保留。默认页面无 filter；实验开启时页面背板会恢复全列模糊开销，优先关闭实验。
- 高级设置异常：逐行重置箭头写回默认值。
- 清除背景：移除 `data-bc-active`，所有材质规则不匹配；偏好保留，下次应用背景时恢复。
- 若控制台不可用，可在应用 localStorage 中把 `beauticode-page-material` 设为 `"0"` 后刷新；这是本机偏好，不涉及数据迁移。

### 6.2 版本级

- 回滚到上一版插件包：旧版忽略 `beauticode-page-material` 与四个 `beauticode-material-*` 键；面板键 `beauticode-readable-surfaces` 保持兼容。
- 旧版会恢复全局 8 token 面板规则和插件页透明；页面材质消失，属于预期。发布说明必须写明这一点。
- 回滚不需要 DSH 文件、媒体档案或主题数据迁移；localStorage 中新增键无害，可在后续版本清理或保留。
- 打包/安装流程不变：`npm run plugin:pack` 生成候选包，安装旧包即可；若需要完全干净，卸载插件后清除背景并移除新增 localStorage 键。

### 6.3 发布顺序

1. 先合入 t1（本 ADR）。
2. t2/t3 分别实现核心和控制台，保持存储键/事件/变量名一致。
3. t4 独立验证，记录命令、结果、跳过项、与 ADR 的差异；t8 曾尝试页面同根背板，t9 复验 V3；t10 因 V9/V10/V11 回退页面 alpha-only，t11 独立复验并关闭 V3/V9–V13。
4. t13/t14 增加默认关闭的「页面模糊（实验）」与 API/控制台开关；t15 独立复验默认关闭与开启边界，报告 §17。
5. t5/t12/t16 更新 `docs/deepseek-harness.md`、`integrations/deepseek-harness/README.zh-CN.md`、本 ADR 与验证记录，确保默认形态是页面 alpha-only、实验项默认关闭且不推荐，并记录最终 git 状态/测试结果。
6. 发布前至少跑通单元测试、控制台测试、可用的浏览器测试和真实 DSH 现场检查；没有现场检查时不得宣称页面/面板材质或实验项在真实宿主通过。V14（30% alpha 不能消除后方文字透出）仍需产品/Lead 确认是否足够；实验项需现场实测后再决定是否保留。

## 7. 实施落点

| 任务 | 文件 | 必须完成 |
|---|---|---|
| t2 | `readability.js`、`client.js`、`test/readability.test.mjs`、`test/plugin-readability.browser.test.mjs`（fixture 可放 `test/fixtures/`） | 材质根重写、候选/层级、sqrt 模糊、MutationObserver、0% 回退、测试 |
| t3 | `console.js`、`test/console.test.mjs` | 两个独立滑杆、高级设置、存储/事件/跨窗口、旧键兼容 |
| t4 | `docs/verification/` 新文件 | 独立验证与现场记录；不改产品代码 |
| t5 | `docs/deepseek-harness.md`、`integrations/deepseek-harness/README.zh-CN.md` | 同步默认值、锚点、边界、风险、回滚；链接 ADR/验证 |
| t10/t11 | `readability.js` + 测试 + 验证记录 | 页面 alpha-only 回退；关闭 V3/V9–V13；V14/V15 记录 |
| t12 | 两份用户文档 + 本 ADR + 验证记录 | 移除 v1 背板过期描述；记录 alpha-only 测试/git 状态/V14 开放 |
| t13/t14/t15 | `readability.js`、`console.js` + 测试 + 验证记录 | 默认关闭的实验页面模糊、API/控制台开关；独立复验默认/开启边界 |
| t16 | 两份用户文档 + 本 ADR + 验证记录 | 补充实验项文档、getBlur 语义、V9–V13 实验风险；链接 §15/§16/§17；最终测试 |

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

结论值已固化在 §2.3 / §2.4；若重新截图，像素结果允许有抗锯齿/GPU 差异，但 `fixed` 与 `sqrt` 必须仍然逐像素等价，`fixed` 与 `outer` 必须明显不同，跨 root 的 4+4 必须接近单层 5.66、4+6.93 必须接近单层 8。**最终页面通道不应用模糊**：该平方和夹具验证的是面板半径模型；页面只保留 30% alpha，不要把 cross-root 的页面 4px 当作当前实际行为。

### 8.3 为什么用平方和而不是线性相加

线性相加会得到 8px（4+4）或 10.93px（4+6.93），与实测的单层 5.66/8 不符；取最大值会得到 4px，也不符。只有 `sqrt(s_1² + s_2²)` 同时解释这两组结果。夹具 A 进一步排除了「嵌套层可以各自叠加」的可能。

## 9. 明确不做

- 不为无 role 的第三方浮层做启发式识别。
- 不给嵌套层添加独立模糊。
- 不修改 DSH 源码、构建产物或宿主 CSS。
- 不根据视口尺寸、z-index 或 `position:fixed` 猜测页面/浮层语义。
- 不承诺页面材质在任意壁纸上达到 4.5:1。
- 当前默认形态不恢复页面级 `backdrop-filter`、`position`/`isolation` 或 `::before` 背板；页面通道为 alpha-only（V14 取舍见 §4.1）。唯一例外是用户显式开启、默认关闭且不推荐的「页面模糊（实验）」；不得把它写成推荐默认。
- 不引入材质动画、渐变过渡或按页面单独配置页面强度；本轮只有全局页面/面板强度和四个高级档位。
- 不改变 `client.js` 的背景阴影、壁纸磨砂、会话阶段、画窗/摸鱼逻辑。

## 10. 验证记录、文档与交付状态

- 独立验证记录：[`docs/verification/2026-11-10-dsh-layered-material.md`](../verification/2026-11-10-dsh-layered-material.md)。§12 是 t7 修复后复跑，§13 是 t9 背板复验（历史），§14 是 t5 文档同步（历史），§15 是 t11 alpha-only 复验，§16 是 t12 alpha-only 文档/集成记录（历史），**§17 是 t15 实验页面模糊最终复验，§18 是 t16 文档同步/最终集成记录**。
- 用户文档：[`docs/deepseek-harness.md`](../deepseek-harness.md) 与 [`integrations/deepseek-harness/README.zh-CN.md`](../../integrations/deepseek-harness/README.zh-CN.md) 已按 **默认页面 alpha-only、可选实验页面模糊默认关闭、面板 blur 不变**同步。
- 最终自动化结果（t15/t16 后）：t4（t6 修复后）/t7/t9/t11/t15 浏览器材质用例均为 **15/15 pass，0 skip**；全量 harness **149/149 pass，0 skip**；`readability.test.mjs` **21/21**；`console.test.mjs` **48/48**（t14 新增 9）；`node --check` readability/client/console 全部通过；`git diff --check` 干净。以上是 Chromium/Edge fixture 与真实浏览器联动结果，不是真实 DSH 现场验收。
- 最终风险状态：**默认形态下 V3/V9/V10/V11/V12/V13 全部关闭**；**V14 开放**（30% alpha 不能消除后方文字透出）；**V15 默认消失**（默认页面无 blur 标记/变量，`getBlur().page=0`，panel=3.69）。**实验开启时** V9 absolute 250、V10 high-outside、V11 滚动底部 delta 1 会重新出现，fixed 仍 60/60；这些是 opt-in 的已知实验风险，不推荐默认，开启后必须重新现场验收 V9–V13。V4–V8 状态不变（多独立浮层共用 s2、纯空白存储值、backdrop-model 未进 CI、fixtures 未跟踪、真实 DSH 运行旧插件）。
- 真实 DSH（本机包 `0.2.2-rc.1`）未现场验证：运行中的插件仍是旧版，且无渲染器 DOM 访问；不得宣称设置页/插件页/技能页/审批卡片/菜单/视频性能已在真实宿主通过。V14 是否满足最初“后方文字不重叠”的产品目标、以及实验项是否值得保留，需 Lead/用户现场确认。
- 交付时必须纳入未跟踪的 `integrations/deepseek-harness/test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html`（V7）；否则干净检出中的浏览器用例会失败。

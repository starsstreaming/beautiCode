# DSH 分层材质独立验证（t4）

- 日期：2026-11-10
- 角色：verifier（t4，attempt `17116485-da2b-4004-815e-0ef1ee6d75b9`）
- 基线：`main` `71b641b` + 本轮未提交变更（`readability.js`、`console.js`、三份测试、`docs/adr/0011-dsh-layered-material.md`、`test/fixtures/`）
- 范围：ADR 0011 的两通道材质、材质档位、readability 材质根重写、console 联动、夹具与真实 DSH 现场条件；本记录不修改产品代码。
- 结论（t4 当时）：**除 V3（页面根内 fixed 包含块偏移）外，可自动化的产品行为通过**。语法、单元、控制台、真实 Edge 浏览器与全量 harness 均通过（最终 140/140，0 skip）；console 滑杆 → 真实 `readability.js` → DOM 的同窗口立即联动已在真实 Edge 中直接验证。
- t4 后历史：t8 曾用页面同根 `::before` 背板关闭 V3（fixed 60/60、portal 40/40），但背板依赖 `position:relative`/`isolation`/absolute 层，暴露 V9/V10/V11；t9 复验的是该历史形态。
- **当前默认形态（t17–t23）**：页面 30% 底色 + **页面模糊默认开启**（页面根 `relative/isolate`、`::before blur(2.4px)`、`getPageBlur=true`、`getBlur={page:2.4,panel:3.69}`）；面板默认 **60%**（dialog alpha 153）、blur 3.69。页内 tooltip 不材质化、保留宿主黑底白字；页内 menu/listbox/dialog/alertdialog 用面板 60%、无 blur；页内浮层出现时页面模糊暂停（static/auto/no pseudo、alpha 30、`getBlur().page=0`），关闭后恢复。
- **风险状态**：V3 fixed 60/60 关闭；V9/V10 在默认页面模糊开启且无页内浮层时仍存在（absolute 250、default-outside），暂停期间回到 10/12、high-inside；V11 滚动底部失模糊、V13 页面 `::before` 覆盖、V14 关闭模糊时后方文字透出、V16 暂停可能被常驻页内控件长期触发，均开放；V12/V15 关闭。真实 DSH 当前运行上一版候选，未现场验证；需重新安装/重启候选后确认，不得宣称本轮现场通过。详见 §19；§20 为 t20 历史记录，§21 为方向移除复验，§22 为 t24 文档同步，§23 为 t25 提交前检查；t26 修复后的最终状态见 §24。
- **真实 DSH 的现场视觉/性能未验证**：本机正在运行的插件是旧版（与 `HEAD` 一致），且无法访问 Electron 渲染器 DOM；因此本报告不宣称新材质在真实 DSH 页面通过。

## 1. 命令与结果

环境：Windows、Node `v22.13.1`、Microsoft Edge `157.0.4341.42`、官方 Desktop 包 `0.2.2-rc.1`（见 §7）。`playwright-core` 来自 Lead 临时安装的 `.tmp/pw-runtime`，不是产品依赖。

```powershell
# 语法
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js

# 单元
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs

# 全量（无浏览器模块时，浏览器用例显式 skip）
node --test "integrations/deepseek-harness/test/*.test.mjs"

# 全量（Lead 提供的 Playwright 运行时 + Edge）
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/background-rendering.browser.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 套件 | 结果 | 说明 |
|---|---:|---|
| `node --check` ×3 | 通过（exit 0） | `readability.js` / `client.js` / `console.js` |
| `readability.test.mjs` | **21/21 通过** | 0 fail / 0 skip |
| `console.test.mjs` | **39/39 通过** | 含 14 项材质/档位/API/回退用例；既有 25 项零回归 |
| 全量 harness（无浏览器模块） | **140 项：122 通过 / 18 显式跳过 / 0 失败** | 18 skip = 15 readability 浏览器 + 3 background 浏览器；跳过不是通过 |
| 单文件隔离重跑 | 非浏览器文件全部通过；浏览器文件显式 skip | 见 §4；`ui-host` 13/13、`plugin` 19/19 等 |
| `ui-host.test.mjs` + `plugin.test.mjs` 并发 | **32/32 通过** | t3 报告的 ack/atmosphere 端口竞争失败未复现 |
| 浏览器测试（t6 前初跑） | **15 项：13 通过 / 2 失败 / 0 跳过** | 两处均为测试期望错误，见 §8；不是产品行为失败 |
| 浏览器测试（t6 修复后复跑） | **15/15 通过** | 0 fail / 0 skip |
| `background-rendering.browser.test.mjs` | **3/3 通过** | 与材质无关的既有浏览器回归 |
| 全量 harness（带浏览器模块，t6 后） | **140/140 通过，0 skip / 0 fail** | 包含 15 项材质浏览器用例与 3 项背景浏览器用例 |

补充的独立检查（临时脚本在 `.tmp/`，非产品代码，未提交）：

| 检查 | 结果 |
|---|---|
| `.tmp/t4-api-check.mjs`：真实 `readability.js` 在 fake DOM 中按 console 调用方式驱动 | 全部断言通过 |
| `.tmp/t4-browser-check.mjs`：真实 Edge + CDP + 提交的 fixture，读取 computed style/几何 | 全部断言通过 |
| `.tmp/t4-console-integration.mjs`：真实 Edge 中同时加载 **真实 `console.js` + 真实 `readability.js`**，拖动真实滑杆 | 全部断言通过（见 §3） |

## 2. 行为矩阵（ADR §5.6）

证据类型：`U` = `readability.test.mjs` / `console.test.mjs`；`B` = 真实 Edge Playwright 浏览器用例；`C` = 独立 Edge CDP 检查；`I` = console+readability 真实浏览器联动。

| 场景 | 期望（ADR） | 实测 | 证据 |
|---|---|---|---|
| 页面默认 30% | page root、alpha .30、页面模糊默认开启、`::before` 2.4px | alpha **77/255**；`position:relative`/`isolation:isolate`/`::before blur(2.4px)`；`getPageBlur=true`、`getBlur={page:2.4,panel:3.69}` | B、C、§19.1 |
| 主会话无页面 | 无 page root；composer/面板 60%、blur 2px | 页面 root 数 0；composer/卡片 alpha **153/255（60%）**、`blur(2px)` | B、§19.1 |
| 独立面板默认 | panel root、alpha .60、blur 3.69px | dialog alpha **153/255**、`blur(3.69px)`、level 2/depth 1 | B、C、§19.1 |
| 页面根内 menu/listbox/dialog | 面板 60%、无 blur、不继承 page alpha | root=panel、alpha 153、`backdrop-filter:none`、无 blur 属性 | B、C、§19.2 |
| page-root tooltip | 不材质化、宿主黑底白字、不改写 token | 无 material/layer；背景/文字与 host tooltip 相同；`--dsw-alias-tooltip-bg` 未改写；rect `(40,40)`/`(70,70)` | B、C、§19.2 |
| 页内浮层暂停 | page root static/auto/no pseudo、alpha 30、getBlur.page0 | `data-bc-page-blur-paused`；`::before content:none`；菜单 alpha153；关闭后 relative/isolate/2.4 恢复 | B、C、§19.2 |
| 页面 100% | 页面 alpha 1、`::before` 8px；面板无 filter | page alpha 1、`::before blur(8px)`；dialog root 存在但无 filter | B、C、§19.3 |
| `maxBlur=0` | 页面无背板/position/isolation；面板无 filter | page alpha .30、无伪元素；dialog 无 filter；getBlur.page=0 | B、C、§19.4 |
| `blurStep=0` | 页面 `::before` 2.4px；面板无 filter | page 2.4px；dialog 无 filter | B、C、§19.4 |
| 页面 0% | 页面无根/无模糊；面板 60% | page root 0、无 flag/背板；dialog alpha153、blur3.69；存储选项保留 | B、C、§19.4 |
| 面板 0% | 页面 30% + 页面模糊；面板回退宿主 | page root/backplate 保留；dialog 无标记、宿主半透明；composer 同样回退 | B、C、§19.4 |
| `[data-shell-overlay]` | 容器不标记；内部 role 仍独立 | 容器 0 alpha、无标记/无 filter；内部 dialog root=panel、blur3.69 | B、C |
| 页面根外 fixed | portal 坐标不变 | 开/关均 `(40,40)` | B、C |
| 页面根内 fixed | 默认页面模糊开启仍稳定 | 开/关均 `(60,60)`；V3 关闭 | B、C、§19.3 |
| V9/V10（默认无浮层） | 仍存在，不得写成已解决 | absolute **250**、高 z-index **default-outside** | C、§19.3 |
| V9/V10（页内浮层暂停） | 暂停期间消除 | absolute **10/12**、**high-inside** | C、§19.2 |
| V11 滚动 | 仍开放 | 补高内容 `scrollTop=300` 后底部 strip delta **1** | C、§19.3 |
| V16 暂停选择器 | 低-中；常驻控件可能一直暂停 | 选择器覆盖任意可见页内 listbox/dialog 等；需现场复核 | C、§19.3 |
| 页面模糊关闭 | static/auto/no pseudo、getBlur.page0 | 面板仍 60%/3.69；重新开启恢复 backplate | B、§19.4 |
| V14 后景文字透出 | 关闭模糊时 30% alpha 只能减弱 | 21:1 → **10.68:1**，仍可见；不能消除 | C、§15.3 |
| 旧面板偏好 | 缺失/`"true"`→60、`"false"`→0、数字保留、无效→60 | 单元测试覆盖；35 保持 35、40 保持 40 | U、B、§19.4 |
| 页面/档位存储 | 默认 30 / 页面模糊 true / 8 / 2 / 8；无 direction；无效回落；夹取 | 单元与控制台测试通过；控制台滑杆实际写入见 §3 | U、I、§19.4 |

## 3. t3 依赖的 API 与同窗口立即联动

> 历史记录：本节联动数值是 t3 当时默认（面板 100%）。t17/t18 后默认面板 60%、页面模糊默认开；t21/t22 已移除 direction（`getMaterial` 不再含该字段、旧键忽略）。当前 API 见 §21/§22 与 §24。

`readability.js` 保留并冻结以下公开面（名称、形状、语义均与 console 的消费一致）：

| 成员 | 形状 / 语义 | 验证 |
|---|---|---|
| `BeauticodeReadableSurfaces.get()` | 面板强度 0–100（数字） | U、I |
| `set(number \| boolean)` | 返回面板强度；0 写 `"false"` 以兼容旧版 | U、I |
| `getPage()` / `setPage(number)` | 页面强度 0–100；0 写新键 `"0"`；缺失键回落 30 | U、I |
| `getMaterial()` | `{alphaStep, blurStep, maxBlur}`（t21 后无 direction；见 §21） | U、I |
| `setMaterial(patch)` | 部分更新、夹取/归一化、立即 apply；`direction` 静默忽略 | U、I |
| `defaults` / `storageKeys` / `getBlur()` / `refresh()` | 只读辅助 / 半径快照 / 同步重扫 | U、B |

**真实浏览器联动证据**（`.tmp/t4-console-integration.mjs`）：同一页面先加载真实 `readability.js`，再加载真实 `console.js`；`console` 自动挂载“背景”页，测试直接设置滑杆 value 并派发 `input`，在同一个 `Runtime.evaluate` 调用内读取 DOM（没有等待 storage 事件，也没有跨窗口）：

| 操作 | 同一次求值内观察到的结果 |
|---|---|
| 页面材质 30 → 60 | page alpha **153/255（.60）**，`blur(4.8px)`；dialog 半径同步为 **4.82px**；label `60%`；localStorage `beauticode-page-material="60"` |
| 面板滑杆 100 → 40 | dialog alpha **102/255（.40）**；页面 alpha 仍 .60，未被面板滑杆重置；label `40%`；旧键 `"40"` |
| 材质档位（透明度）8 → 20 | 页面嵌套层 alpha **204/255（.80）**，无 filter；label `20%`；存储 `"20"` |
| ~~方向切换~~（历史） | t21/t22 后无方向行/字段；旧 `beauticode-material-direction="down"` 保留但忽略，嵌套固定递增 |
| 页面材质重置 | page 回到 alpha .30 / `blur(2.4px)`；dialog 半径回到 **3.69px**；label `30%`；存储 `"30"` |

这同时验证了 t3 的关键要求：**同窗口拖动滑杆后材质立即变化，不依赖 `storage` 事件**。面板通道仍通过 `get/set`，页面与高级档位通过 `getPage/setPage/getMaterial/setMaterial`；`console.test.mjs` 还覆盖了 API 缺失/异常时的独立写键与变量回退、跨窗口 `storage` 事件、旧布尔值和 0% 独立回退。

## 4. 测试隔离与 t3 端口竞争

t3 报告称 `ui-host`/`plugin` 并行时曾出现 2 例 ack/atmosphere 端口竞争失败、单独重跑通过。本次验证：

- 全量 harness 单进程（Node 默认并发）无浏览器模块：140 项 **0 fail**；
- 带 Playwright 模块：140 项 **0 fail / 0 skip**；
- `ui-host.test.mjs` + `plugin.test.mjs` 显式并发：**32/32 通过**；
- 各文件单独重跑：均通过（浏览器文件在无模块时显式 skip）。

结论：本次**未复现**该端口竞争失败；记录为既有测试噪声，不计入本轮回归，也不据此认定产品回归。

## 5. 代码审查（与 ADR 0011 的一致性）

### 5.1 通过项

- **锚点/候选集合**：页面只认 `[data-global-panel]`；面板只认 dialog/alertdialog/menu/listbox、`[data-composer-card]` 和三类待交互卡片内层；不使用构建类名；`[data-shell-overlay]` 容器跳过、内部 role 仍处理；无 role 浮层不处理；`#beauticode-*` 自身 UI 跳过。tooltip 不是候选、不材质化、不改写 `--dsw-alias-tooltip-bg`，只作为页内浮层的暂停触发器。与 ADR §3.1 一致。
- **分层与属性**：page root level 1/depth 1；独立 panel root level 2/depth 1；嵌套层 level/depth +1；只有 root 写 `data-bc-material-blur="on"`，嵌套层只写 alpha；嵌套层无 `backdrop-filter`。与 ADR §3.2 一致。
- **默认值与模糊模型（当前 t17–t23）**：page 30、panel 60、alpha step 8、blur step 2、max blur 8，无 direction；`I = page/100×maxBlur`，`T2 = min(M, I+B)`，`s2 = sqrt(T2²−I²)`；页面模糊默认开启，页面根 `relative/isolate` + `::before blur(2.4px)`，面板独立根 `blur(3.69px)`；页面 0/主会话面板 2px，页面 100 面板 0，`maxBlur=0`/`blurStep=0` 无多余 filter。与 ADR §3.4/§5.6 一致。
- **存储与迁移**：`beauticode-page-material`、`beauticode-page-blur`、`beauticode-readable-surfaces`、三个 `beauticode-material-*` 键名（alpha-step/blur-step/max-blur）、默认值、夹取、四舍五入、无效回落；旧 `"true"`/`"false"` 兼容；面板 0 仍写 `"false"`；页面 0 写 `"0"`。与 ADR §3.3 一致。
- **0% 回退**：页面 0 只移除页面通道；面板 0 只移除面板通道；两者 0 无标记/内联变量/filter；实际 computed 与未注入 readability 的宿主 baseline 一致（Console+Edge 均验证）。与 ADR §3.3 一致。
- **查询/重扫**：MutationObserver 以 rAF/setTimeout 节流，忽略自身 `data-bc-material-*`/`style` 写入；先清 stale 再重算；角色变化、节点移除、页面根替换均幂等；重复加载不重复注入样式。与 ADR §5.1 一致。
- **CSS 形状**：旧全局 `:is([role=...])` 规则已删除；页面根只加 fill，不改写 surface token；panel root 与嵌套层改写 7 个 token（故意不改写 `--dsw-alias-tooltip-bg`）；页面根显式 `backdrop-filter:none`，页面模糊默认由 `html[data-bc-page-blur="true"]` + 页面根 blur 标记 + `:not([data-bc-page-blur-paused])` 的 `::before` 背板承担；暂停/关闭/0% 时无 position/isolation/伪元素。tooltip 不在候选；页内 menu/list/dialog 是 panel root 60%、无 blur。与 ADR §3.2/§4.1/§3.5 一致，未发现与 `client.js` 的双重叠加（`client.js` 未改，body token/壁纸/磨砂作为下层宿主）。
- **公开 API**：除 `getMaterial()` 不再含 `direction` 外，`get/set/getPage/setPage/getMaterial/setMaterial` 的命名、返回值和语义保持；`getMaterial()` 只返回 `{alphaStep,blurStep,maxBlur}`，`setMaterial({direction})` 静默忽略；另有 `defaults/storageKeys/getBlur/refresh`。console 消费路径见 §3。
- **夹具**：`test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html` 已放入 `test/fixtures/`（未再依赖 `.tmp`）；嵌套、shell.overlay、无 role、fixed 下拉、会话模式均有 fixture。`backdrop-model.html` 是可手工打开的静态复现（见 §6/§8 V6）。

### 5.2 差异与低风险观察

| 观察 | 说明 | 严重度 |
|---|---|---|
| 纯空白存储值 | `readability.js` 的 `readNumber`/`readPanelStrength` 对 `" "` 会 `Number(" ") → 0`，即页面/面板/档位被当作 0；console 的 `readStoredNumber` 会 trim 后回落默认。ADR 说“无效值回退默认”，两者不一致。仅手工破坏 localStorage 时可见。建议读取时先 `String(raw).trim()`，并补 `" "` 用例。 | 低 |
| 0% 时 `--bc-page-material-strength` | 真实 API 路径保留变量值 `"0"`（供调试）；console 独立回退路径移除该变量。CSS 不依赖它，无用户可见差异，但两条路径行为不完全一致。 | 信息 |
| 主会话的 `data-bc-page-material` | 默认 page=30 时，即使没有 `[data-global-panel]`，`html` 仍带 `data-bc-page-material="true"`；没有页面锚点所以不产生页面材质，插件页辅助也不在主会话匹配。与 ADR 的“页面强度 > 0 时存在”一致，但读属性的人容易误解。 | 信息 |
| `isVisuallyCovering` | 只有宽高**同时**为 0 才判定不可见；单维为 0 仍会标记。真实页面列不会出现单维 0，未构成失败。 | 低 |
| 版本号 | t5 已把 ADR 改为「本机官方 Desktop 包 `0.2.2-rc.1`（运行时版本文件 `44.7.0`）」；`data-global-panel`/`data-shell-overlay` 源码片段在本机包内逐字存在，锚点契约一致，但仍**不能声称与 ADR 是同一构建**。 | 信息（已同步） |
| 夹具交付状态 | V7 已关闭：`test/fixtures/*.mjs`、`backdrop-model.html` 现已被 git 跟踪，当前无未跟踪 fixture；交付提交仍应确认包含它们。 | 信息（已解决） |

## 6. 夹具与真实 Chromium 补充验证

- `test/fixtures/layered-material.mjs`：页面模式的 `[data-global-panel]`、插件页、嵌套 listbox/menu、body portal dialog/listbox/menu/tooltip、`data-shell-overlay` 及其中 dialog、无 role 浮层、composer、三张待交互卡片、页面根内外 fixed 下拉。
- `test/fixtures/fake-dom.mjs`：单元测试用的最小 DOM，含 `MutationObserver` 过滤、`dataset`、内联 style、`querySelectorAll` 子集；没有布局，`getBoundingClientRect` 默认 100×100。
- `test/fixtures/backdrop-model.html`：ADR §2.3/§2.4 的静态复现（嵌套 fixed/sqrt/outer 与 `?page=&panel=` 跨 root）。**它不被自动测试加载**，仅用于手工截图测量；本轮未重新做像素测量，跨 root 平方和仍以 ADR 固化的夹具数据 + 单元数学 + computed blur 半径为准。
- 独立 Edge CDP 检查（`t4-browser-check.mjs`）在真实 Chromium 157 中复现了 computed alpha/filter、嵌套无 filter、shell.overlay、无 role、0% baseline；并确认：
  - portal fixed `(40,40)` 开关材质不变；
  - t4 时页面根内 fixed `x` 从 60 → 300（pageX 240 + 60），包含块风险真实存在；该风险在 t10 alpha-only 后消失，t11 复验页面内 fixed 开/关均 `(60,60)`（见 §15）。

## 7. 真实 DSH（环境允许性）

### 7.1 已确认

- 本机官方 Desktop 包为 `@deepseek-ai/dsh-desktop` **0.2.2-rc.1**；`app.asar` 内 `AppFrame` 片段与 ADR §2.1 对齐：
  - `"data-global-panel": panelId !== null || void 0,`
  - `"data-shell-overlay": true,`（`overlayLayer`）
  - `.mainPanel[data-global-panel]` 参与 `padding-top`，确认它是布局契约。
- 当前 Web GUI `http://127.0.0.1:59035` 上 `/__beauticode/version` 返回 `{"ok":true,"protocol":4,"revision":"source"}`；`beauticode_status` 显示“背景：图片 · 页面：已连接（1）”，说明插件运行时/注入链路是活的。

### 7.2 未能验证（关键限制）

- 本机**正在运行的插件是旧版**：安装目录 `C:\Users\zfor\.dsh\profiles\desktop\node_modules\beauticode-dsh` 为 `1.0.28`，其 `readability.js` 与 `git show HEAD:...readability.js` **逐字节一致**；服务端 `/__beauticode/client.js` 以 HEAD 旧 readability 开头，含旧 `--bc-readable-fill` 规则，**不含** `data-bc-material-root`/`beauticode-page-material`。因此当前 GUI 不能代表本轮改动。
- 无法访问 Electron 渲染器 DOM：桌面进程没有开 `--remote-debugging-port`；HTTP 端点无 DOM/eval 能力；普通请求 401，补同源 `Origin` 后只能读 `/__beauticode/ui/status` 等业务 JSON；VMark 浏览器工具仅 macOS 可用。未通过安装候选包来“制造”现场（会改动用户当前应用状态）。
- 因此以下项**未在真实 DSH 验证**，不能算通过：
  - 设置 dialog、菜单、listbox、tooltip、composer、提问/计划审核/授权确认卡片的真实视觉；
  - 插件页、技能页、自动化任务页的 30% 页面材质与文字可读性；
  - 视频背景下的页面/面板滚动、菜单、输入、全屏、摸鱼的帧时间与观感（当前背景是图片）；
  - 默认页面模糊开启后：V9 absolute 250、V10 default-outside、V11 滚动底部失模糊；页内 tooltip/menu/listbox/dialog 可见时暂停是否消除漂移；fixed 预期仍 60/60；
  - tooltip 是否保持宿主黑底白字/定位；页内 menu/listbox/dialog 是否为面板 60%、无 blur；面板默认 60% 是否可接受；
  - V16：常驻页内 listbox/dialog 是否让页面模糊一直暂停；V13 页面 `::before` 是否被宿主占用；
  - 真实壁纸下的 30% 对比度基线、0%/跨窗口/旧偏好迁移的现场表现。
- 建议：在隔离测试 profile 安装本轮候选包后，按 ADR §5.5 重做现场检查；本报告不能替代现场验收。

## 8. 发现清单

| ID | 严重度 | 状态 | 问题 / 证据 / 处理 |
|---|---|---|---|
| V1 | 低（测试） | **已由 t6 修复** | 初跑 `plugin-readability.browser.test.mjs:218` 断言嵌套 `dialogList.materialBlur === ""`，实际 computed 值为继承父级的 `3.69px`。产品行为正确：嵌套层 `backdrop-filter: none`、无 `data-bc-material-blur`、无内联变量。t6 改为断言 inline 变量为空并保留继承契约；修复后 15/15。 |
| V2 | 低（测试） | **已由 t6 修复** | 初跑同文件 `:536` 在 `pageStrength:0, panelStrength:0` 的用例中期望新挂载 late dialog alpha 255，实际 82（宿主半透明）。t6 在挂载前调用 `set(100)` 恢复面板通道；修复后 15/15。 |
| V3 | 关闭（t10/t11 最终） | 关闭 | t4 时页面根 `backdrop-filter` 为 fixed 后代创建包含块：真实 Chromium 实测页面根内 fixed 从 `x=60` 变为 `x=300`，portal 保持 `(40,40)`。t8 曾用同根 `::before` 背板修复（历史，t9 复验）；t10 因 V9/V10/V11 回退页面 alpha-only，移除页面 filter/背板/`position`/`isolation`。t11 复验页面内 fixed 开/关均 `(60,60)`、portal `(40,40)`，页面 alpha 77/255、无 filter。 |
| V4 | 低（已知） | 开放 | 多个同时存在的独立浮层都按 level 2 共用 `s2`；视觉重叠时总模糊可能超过 `sqrt(I²+s2²)`。ADR §3.4 已明确接受，本轮未改模型；浏览器 fixture 同时存在 portal dialog 与 shell dialog，但未做叠加像素测量。 |
| V5 | 低 | 开放 | 纯空白 localStorage 值在 `readability.js` 中解析为 0，而 console 回退路径回落默认（见 §5.2）。正常应用不会写出空白值；建议 `trim()` + 测试。 |
| V6 | 低 | 开放 | `backdrop-model.html` 是手工夹具，不进入自动测试；跨 root 的像素平方和等价性没有 CI 保护。ADR §2.5 要求“内联或放入 test/fixtures”，文件已放入，但自动覆盖仍只有 computed 半径/单元数学。 |
| V7 | 交付 | 关闭 | `test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html` 已纳入版本控制；当前无未跟踪 fixture（交付时仍确认提交包含）。 |
| V8 | 信息 | 开放 | 本机真实 DSH 运行旧插件（`1.0.28`/HEAD），新材质未在该应用生效；真实现场项未验证。 |

> 状态更新（t17–t19）：页面 30% + 页面模糊默认开启、面板 60%、tooltip 不材质化、页内浮层暂停页面模糊。V3 fixed 60/60 关闭；V9/V10 在默认页面模糊且无页内浮层时仍存在（250/default-outside），暂停时回到 10/12/high-inside；V11 滚动底部失模糊、V13 页面 `::before` 覆盖、V14 关闭模糊时后方文字透出、V16 暂停可能被常驻页内控件长期触发，均开放；V12/V15 关闭。§13/§17/§18 的 alpha-only/实验描述是历史，§19 为 t19 行为复验，§21/§22/§23 为后续最终记录。

## 9. 跳过与未验证项

- 最终带 Playwright 的套件 **0 skip**；历史无模块运行有 18 skip（15 readability 浏览器 + 3 background 浏览器），这些跳过不计为通过。
- 真实 DSH 现场项（§7.2）全部未验证；本报告只对“真实 Chromium + 提交的 fixture”和“真实浏览器中的 console+readability 联动”负责。
- 视频背景性能未测：当前应用背景为图片，且切换用户背景不属于验证授权范围。

## 10. 复跑方式

```powershell
# 产品单元与全量（无浏览器时浏览器用例会显式 skip）
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"

# 浏览器（Lead 提供的临时 playwright-core + 本机 Edge）
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/background-rendering.browser.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

独立检查脚本（临时、未提交、不属于产品）：

- `.tmp/t4-api-check.mjs`：真实 readability + fake DOM，验证 API 形状、默认值、同步重绘、事件、旧拼写。
- `.tmp/t4-browser-check.mjs`：Edge CDP，验证 computed alpha/filter、嵌套、shell.overlay、no-role、0% baseline、fixed 坐标。
- `.tmp/t4-console-integration.mjs`：Edge CDP + 本地静态服务，真实 console.js + readability.js 滑杆联动。

## 11. 验收对照（t4 当时）

> 历史快照：下表数字是 t4 当时（console 39/39、全量 140/140、fixtures 未暂存）。最终基线为 console 49/49、全量 150/150、fixtures 已跟踪（见 §21/§22/§24）；不要把下表当作当前验收结果。

| t4 要求 | 状态 | 证据 |
|---|---|---|
| 语法 + 单元 | 通过 | `node --check` ×3；21/21、39/39 |
| 浏览器测试（Playwright 可用） | 通过 | t6 后 15/15，0 skip；全量 140/140 |
| 页面/会话/面板/嵌套/独立覆盖/shell.overlay/0% 行为 | 通过（真实 Chromium fixture） | §2 矩阵、§6 Edge CDP |
| 页面内 fixed / absolute / 层叠 / 滚动 | 默认页面模糊开启仍有 V9/V10，暂停时消除；真实 DSH 未验证 | t19：fixed 60/60、portal 40/40；默认无页内浮层时 absolute 250、default-outside；页内浮层暂停时 absolute 10/12、high-inside；V11 滚动 delta 1 仍开放；V3/V12/V15 关闭，V13/V14/V16 开放。见 §19/§24 |
| t3 API 契约 + 同窗口立即联动 | 通过 | §3 真实浏览器 console+readability 联动 |
| console 39 项零回归 | 通过 | 39/39 |
| 端口竞争隔离 | 通过（未复现） | §4，32/32、140/140 |
| 与 ADR 一致性/存储/回退/旧偏好/双重叠加 | 通过（低风险观察见 §5.2） | §5 |
| 夹具内联或提交到 test/fixtures | 已放入并已跟踪（V7 关闭；t4 当时未暂存） | §6 |
| 真实 DSH 现场 | 未能验证（环境限制） | §7；不得宣称现场通过 |
| 报告含命令/结果/跳过/差异/风险 | 通过 | 本文件 |

## 12. t7 修复后复跑（2026-11-10）

> 历史记录：本节的 V3 状态在 t8/t9 后改变，最终又被 t10 alpha-only 取代；本节保留 t7 当时的门禁与 fixed 证据。当前见 §19（行为复验）/§21/§22/§24（最终记录）。

t6 修复两处测试期望后，t7 在同一工作树独立复跑；本任务**未修改任何产品代码**，只追加本记录。命令：

```powershell
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 检查 | 结果 |
|---|---|
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 skip，0 fail**（t7 门禁满足） |
| `readability.test.mjs` | **21/21 pass** |
| `console.test.mjs` | **39/39 pass** |
| `node --check` ×3 | 3/3 exit 0 |
| 全量 harness（带浏览器模块） | **140/140 pass，0 skip，0 fail**（附加复核，非 t7 硬指标） |
| `.tmp/t4-api-check.mjs`（真实 readability + fake DOM） | 通过；`getPage/setPage/getMaterial/setMaterial/get/set` 形状与语义符合 t3 消费契约 |

15 项浏览器用例全部通过，包含：页面模式（页面 30%/2.4px、面板 100%/3.69px、嵌套无 filter）、会话模式（无页面材质、面板 2px）、页面 0%、面板 0%、高级档位/sqrt 模糊、shell.overlay 与无 role 浮层、#92 插件页光晕/壁纸/对比度、React 替换、视频背景、双通道关闭、透明行几何/hover/焦点、面板滑杆 0–100，以及 fixed 下拉。

关键核对值（独立 Edge CDP，`.tmp/t4-browser-check.mjs` 复跑）：

| 项 | 结果 |
|---|---|
| 页面默认 | alpha **77/255（.30）**，`backdrop-filter: blur(2.4px)`，root=page/level 1/depth 1 |
| 面板默认 | alpha **255（1.00）**，`blur(3.69px)`，root=panel/level 2 |
| 页面根内嵌套 | alpha **97/255（.38）**，`backdrop-filter: none`，无 `data-bc-material-blur` |
| `[data-shell-overlay]` | 容器不标记、alpha 0、无 filter；内部 dialog root=panel、`blur(3.69px)` |
| 0% | 无 root/layer 标记与内联变量；composer/dialog 的 background/backdrop/alpha 与未注入 readability 的 baseline 一致 |
| API | `getPage/setPage/getMaterial/setMaterial` 均存在且语义符合 §3；真实浏览器 console+readability 联动仍通过（页面 30→60 立即 .60/4.8px，面板/档位/重置均立即生效；direction 已在 t21/t22 移除） |

### 与 ADR 的差异 / 剩余风险

- **页面内 fixed 下拉仍是 V3**：t7 复跑的 fixed 用例 15 通过，但它断言的是**当前已知的包含块行为**：portal 在页面根外保持 `(40,40)`，页面根内 `x` 从关闭材质的 60 变为开启材质的 **300**（pageX 240 + 60）。这不是“不偏移”；ADR §4.1 的同根背板层回退在 t7 时尚未实现。t7 不修改产品代码；已由 Lead 建 t8（页面根同根背板层）修复，t9 在 t8 后独立复验（页面根无 backdrop-filter、背板 `blur(2.4px)`、页面内 fixed 坐标与关闭材质一致、portal fixed 稳定、15/15 0 skip、readability/console 全绿）；最终结果见 §13/§14。
- V4（多个独立浮层共用 `s2`）、V5（纯空白存储值）、V6（`backdrop-model.html` 未进 CI）状态不变；V7 已关闭（fixtures 已跟踪）。仍见 §8。
- 真实 DSH 现场仍未验证（运行旧插件且无渲染器 DOM，见 §7）；t5 文档应等待 t9 完成后再开始。
- 文件哈希与 t4 记录一致（产品代码未因 t6/t7 改动）：`readability.js` `DD3578…C4A51`、`console.js` `BA63E8…B44808`、`plugin-readability.browser.test.mjs` `48D713…96C1`。

## 13. t9 背板层修复复验（2026-11-10，历史）

> 历史记录：t10 已因 V9/V10/V11 回退页面 alpha-only，t11 复验；本节的页面背板/position/isolation/V9–V13 状态不再是最终形态。当前见 §19（行为复验）/§21/§22/§24（最终记录）。

t8 只修改 `readability.js` 与浏览器测试；t9 独立复跑，**未修改任何产品代码**，只追加本记录。命令与 t7 相同：

```powershell
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 检查 | 结果 |
|---|---|
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 skip，0 fail** |
| `readability.test.mjs` | **21/21 pass** |
| `console.test.mjs` | **39/39 pass** |
| `node --check` readability/console | 2/2 exit 0 |
| 全量 harness（带浏览器模块） | **140/140 pass，0 skip，0 fail** |
| `.tmp/t9-backplate-check.mjs`（独立真实 Edge + fixture） | 全部断言通过；关键值见下 |

### 13.1 V3：fixed 包含块偏移已关闭

t9 独立 Edge 复验（1200×800，fixture 页面列 `x=240`）：

| 检查 | 期望 | 实测 | 结论 |
|---|---|---|---|
| 页面根自身 filter | 无 | `backdrop-filter: none` | 通过 |
| 背板层 | `::before`、absolute、z-index -1、pointer-events none、`blur(2.4px)` | 全部符合；尺寸 960×800 | 通过 |
| 页面 alpha | 77/255（.30） | 77/255，背景为 30% color-mix | 通过 |
| portal fixed | 开/关均为 (40,40) | 开/关均 (40,40) | 通过 |
| 页面根内 fixed | 开/关均为 (60,60)（旧行为开启时 300） | 开/关均 (60,60) | 通过；**V3 原始 fixed 偏移关闭** |
| 页面列几何 | 开/关一致 | 开/关均 x=240、y=0、960×800 | 通过 |
| 页面 0% 清理 | 根 position static、isolation auto、伪元素 content none、无 filter | 全部符合 | 通过 |
| 背板视觉 | 真实模糊壁纸 | 高频壁纸开/关截图 max channel delta **89** | 通过 |

### 13.2 背板方案引入/保留的残留风险

| ID | 严重度 | 状态 | 证据与判断 |
|---|---|---|---|
| V9 | 中低 | **开放** | `position:relative` 使页面根成为 absolute 后代的包含块：合成直系 absolute 探针在页面材质关闭时 `x=10`，开启后 `x=250`（pageX 240 + 10）。fixture 自带的 host 卡片有 `position:relative` 包裹，未受影响；真实第三方页面若有无定位祖先的 absolute 子元素，会整体偏移。ADR §4.1 允许对页面根使用 `position:relative`，属于背板方案的已知代价，需现场检查。 |
| V10 | 中低 | **开放** | `isolation:isolate` 会建立层叠上下文：合成探针在页面材质关闭时，页面内 `z-index:9999` 的子元素可压过同父级 `z-index:1` 的兄弟；开启材质后被 isolation 困住，兄弟反而在上。DSH 自带的菜单/Toast/设置普遍 portal 到 body，主要风险在第三方页面内的高 z-index 浮层；需现场复核。 |
| V11 | 低-中 | **开放** | 背板 `position:absolute; inset:0` 在页面根是滚动容器时随内容滚动。fixture 页面列 `960×800`、`scrollHeight 836`、`clientHeight 800`、`overflow-y:auto`；`scrollTop=36` 后底部 strip（y=768、160×20）开/关模糊 max channel delta **1**，即底部 36px 不再被模糊。当前真实 DSH 的 `.mainPanel` 无 `overflow`，`centerCol` 为 `overflow:hidden`，页面列自身通常不是滚动容器；风险主要是第三方 page 或未来宿主改成滚动列。 |
| V12 | 低 | **开放** | `position:relative;isolation:isolate` 不按 `data-bc-material-blur` 门控：`maxBlur=0` 时页面根仍为 relative/isolate，但没有 `::before` 背板（content none），即无模糊却保留 V9/V10 的副作用。建议后续把这两个声明收窄到 `[data-bc-material-blur="on"]`；本轮不改产品代码。 |
| V13 | 低 | **开放** | 背板使用页面根的 `::before`；若宿主/第三方页面已在该列使用 `::before`，其 content/position/尺寸会被覆盖。fixture 未使用，需现场复核。 |

### 13.3 结论

- **V3 的原始 fixed 偏移已关闭**：页面根无 `backdrop-filter`，同根背板承担 `blur(2.4px)`，页面内 fixed 与关闭材质一致，portal 稳定，页面 alpha/视觉模糊成立。
- **滚动残留仍开放**（V11），但当前 DSH 页面列不是滚动容器；是否修复由 Lead 决定。V9/V10/V12/V13 为背板方案的绝对定位/层叠/无模糊/伪元素副作用，均已记录证据，未自行改产品代码。
- V4-V8 状态不变；真实 DSH 现场仍未验证；t5 文档可以开始，但必须带上 V9-V13 与“真实 DSH 未现场验证”的边界，不得宣称现场通过。
- t8 后文件哈希（t9 未改产品代码）：`readability.js` `0C0C8A2E…8D528D194`、`console.js` `BA63E8C9…B44808`（未变）、`plugin-readability.browser.test.mjs` `4DA3E28E…A4B7A15`。

## 14. t5 文档同步与最终集成记录（2026-11-10，历史）

> 历史快照：t5 当时把 t8 `::before` 背板写成最终形态，并称 V9–V13 开放。t10/t11 回退 alpha-only，t12/t16 依次更新文档与实验项；t17–t19 又把页面模糊改回默认开启、面板 60、tooltip 宿主样式与暂停。当前见 §19（行为复验）/§21/§22/§24（最终记录）。

t5 只改文档，**未改产品代码**。同步内容：

- [ADR 0011](../adr/0011-dsh-layered-material.md)：补充 t8 页面同根 `::before` 背板的最终实现、V3 关闭、V9–V13 开放残留、版本说明（本机包 `0.2.2-rc.1`，运行时版本文件 `44.7.0`）、与本文的互相链接；验收矩阵改为「页面根无 filter、背板承载 2.4/8px」。
- [docs/deepseek-harness.md](../deepseek-harness.md)：新增「分层材质与设置」一节，写入页面 30% / 面板 100% 两条独立滑杆、高级档位、`[data-global-panel]` 与标准 role 锚点、嵌套只 alpha、shell.overlay 容器跳过、无 role 边界、0% 与旧键兼容、V3 关闭与 V9–V13 风险、自动化结果与链接。
- [integrations/deepseek-harness/README.zh-CN.md](../../integrations/deepseek-harness/README.zh-CN.md)：替换「插件页完全透明、只有面板强度」的旧段落，改为两条材质通道、页面背板、0% 回退、风险与验证链接。
- 本文：更新顶部结论、页面默认行为矩阵、V3 行、验收对照与真实 DSH 未验证项；保留 t4/t7/t9 的历史段落，当时状态以 §13/§14 为准；当前见 §19/§21/§22。

文档互链：ADR §10 ↔ 本文；[docs/deepseek-harness.md](../deepseek-harness.md) 与 README 均链接 ADR 和本文。

### 14.1 最终测试（t5 文档改动后复跑，产品代码未变）

```powershell
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 套件 | 最终结果 |
|---|---|
| `node --check` ×3 | 3/3 exit 0 |
| `readability.test.mjs` | **21/21 pass，0 fail，0 skip** |
| `console.test.mjs` | **39/39 pass，0 fail，0 skip** |
| `plugin-readability.browser.test.mjs`（t4 修复后/t7/t9 门禁） | **15/15 pass，0 fail，0 skip** |
| 全量 harness（带 Playwright/Edge） | **140/140 pass，0 fail，0 skip** |

### 14.2 最终 git 状态（`git status --short`）

```text
 M docs/deepseek-harness.md
 M integrations/deepseek-harness/README.zh-CN.md
 M integrations/deepseek-harness/console.js
 M integrations/deepseek-harness/readability.js
 M integrations/deepseek-harness/test/console.test.mjs
 M integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
 M integrations/deepseek-harness/test/readability.test.mjs
?? .agent-teams/
?? docs/adr/0011-dsh-layered-material.md
?? docs/verification/2026-11-10-dsh-layered-material.md
?? integrations/deepseek-harness/test/fixtures/backdrop-model.html
?? integrations/deepseek-harness/test/fixtures/fake-dom.mjs
?? integrations/deepseek-harness/test/fixtures/layered-material.mjs
```

- `.agent-teams/` 是团队运行时状态，不属于交付内容，提交时应排除。
- ADR、验证记录与三个 fixture 在 t5 当时未跟踪；后续已纳入版本控制（V7 已关闭），当前无未跟踪 fixture，交付提交仍应确认包含它们。
- `git diff --check` 对文档无空白错误；仅 `core.autocrlf` 的 LF→CRLF 提示，不改变内容。

### 14.3 最终边界

- **V3 已关闭**：页面根自身无 `backdrop-filter`；页面内 fixed 开/关 `(60,60)`，portal `(40,40)`；背板 `blur(2.4px)`；页面 0% 时 `position`/`isolation`/伪元素一起移除。
- **V9–V13 开放**：absolute 包含块、isolation 层叠、滚动页面底部失模糊、`maxBlur=0` 仍保留 position/isolation、宿主 `::before` 覆盖；均需真实 DSH 现场复核，当前为低/中风险。
- **V4–V8 状态（t5 当时）**：多独立浮层共用 `s2`、纯空白存储值差异、`backdrop-model.html` 未进 CI、fixtures 当时未暂存（V7 后已跟踪）、真实 DSH 运行旧插件。
- **真实 DSH 未现场验证**：本机运行旧插件且无渲染器 DOM；上述 15/15、140/140 仅代表 Chromium/Edge fixture 与真实浏览器联动，不代表设置页/插件页/技能页/审批卡片/菜单/视频性能已在真实宿主通过。

## 15. t11 alpha-only 回退独立复验（2026-11-10，历史）

> 历史阶段：t17/t18 已把页面模糊改为默认开启、面板默认 60%、tooltip 移出材质并加入暂停；当前默认见 §19/§21/§22。

t10 按硬约束回退为 **页面 alpha-only**（保留 30% fill；移除页面 `backdrop-filter`、同根背板、`position:relative`、`isolation`）；面板根/嵌套层规则不变。t11 独立复跑，**未修改产品代码**。

```powershell
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 检查 | 结果 |
|---|---|
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 skip，0 fail** |
| `readability.test.mjs` | **21/21 pass** |
| `console.test.mjs` | **39/39 pass** |
| `node --check` readability/console | 2/2 exit 0 |
| 全量 harness（带浏览器模块） | **140/140 pass，0 skip，0 fail** |
| `.tmp/t11-alpha-only-check.mjs`（独立真实 Edge + fixture） | 全部断言通过；关键值见下 |

### 15.1 页面根与面板

| 检查 | 实测 |
|---|---|
| 页面根 | `data-bc-material-root="page"`，alpha **77/255（.30）**，`background: color(srgb … / 0.3)` |
| 页面根定位/层叠 | `position: static`、`isolation: auto` |
| 页面根 filter | `backdrop-filter: none`、`filter: none` |
| 页面伪元素/背板 | `::before content:none`；`[data-bc-material-backplate]` 数量 0 |
| 面板 blur | dialog `backdrop-filter: blur(3.69px)`（不变） |
| 模型值 vs 实际 | `getBlur()` 仍为 `{page:2.4, panel:3.69}`；**page 2.4 只是面板 sqrt 半径的模型尺度，页面实际无 blur**；页面根仍带 `data-bc-material-blur="on"` 与 inline `--bc-material-blur:2.4px`，但页面规则显式 `backdrop-filter:none`，不要把这个属性当作实际页面 blur（低语义观察 V15） |
| 页面 0% | root 标记移除、alpha 0、filter none、position static |

### 15.2 V3 / V9 / V10 / V11 状态

| ID | 检查 | 结果 | 状态 |
|---|---|---|---|
| V3 | 页面内 fixed / portal fixed 开/关 | page column x=240；portal 开/关均 `(40,40)`；页面根内 fixed 开/关均 `(60,60)`（旧行为开启 300） | **关闭** |
| V9 | 页面内 absolute 后代开/关 | 探针开/关均 `(10,12)`（相对 `#root`，不是列 x+10） | **关闭** |
| V10 | 页面内 `z-index:9999` 与页面外 `z-index:1` 兄弟 | 开/关均命中 `high-inside` | **关闭** |
| V11 | 页面列 `scrollTop>0` 后底部可见区域 | fixture `scrollHeight 836 / clientHeight 800 / overflow auto`；`scrollTop=36` 后底部 strip 开/关 max channel delta **67**，页面 fill 仍覆盖 scrollport；无背板可滚动丢失 | **关闭** |
| V12 | `maxBlur=0` 下 position/isolation 残留 | 回退后页面根本不加 position/isolation；随页面标记存在与否变化，无背板副作用 | **关闭** |
| V13 | 宿主 `::before` 被覆盖 | 页面通道不再使用 `::before` | **关闭** |

### 15.3 产品取舍：30% alpha 能否解决后方文字重叠？

用高对比黑/白竖条纹模拟页面后方的会话文字/图案，在页面列内固定裁剪区测合成后的相对亮度对比：

| 页面材质 | min / max 相对亮度 | 对比度 |
|---|---:|---:|
| 关闭（0%） | 0 / 1.0 | **21.0:1** |
| 开启（30% alpha） | 0.0052 / 0.5399 | **10.68:1** |

结论：30% alpha 只把后景文字对比度从 21:1 降到约 **10.7:1**，高对比背景文字仍然清晰可见；它**不能消除**“页面后方文字透出/重叠”，只能减弱。若最初的问题正是会话/背景文字在页面后明显重叠，alpha-only 30% 不足以解决，这是 t10 在硬约束 1/2 下接受的产品取舍（**V14，开放**），需 Lead/产品确认；本轮不自行改代码。页面自身文字（前景）在 30% fill 下的对比度/光晕仍通过浏览器用例（15/15 中的 #92 对比度/透明页面用例），不要把“前景可读”与“后景不重叠”混为一谈。

### 15.4 其他回归与边界

- 无新的 fixed/absolute/scroll/stacking 回归：页面根不再创建包含块或层叠上下文；alpha-only 只改 `background-color`。
- 性能：页面层不再有 `backdrop-filter`，按实现比 t8 背板方案更轻；本轮没有做视频帧时间测量，不能给出真实 DSH 性能结论。
- 真实 DSH 仍未现场验证（运行旧插件、无渲染器 DOM）；15/15、140/140 只代表 Edge fixture 与真实浏览器联动。
- **文档同步**：§14 是 t5 在 t10 之前写的文档快照，仍按 t8「页面根无 filter + `::before` 背板」描述，并称 V9–V13 开放；与当时 alpha-only 产品不符。t12 已完成 ADR、docs/deepseek-harness.md、README 与本文的同步：页面 alpha-only（30%，无页面 blur），V3/V9/V10/V11/V12/V13 关闭，V14（30% 不能消除后景文字重叠）作为产品取舍开放，并说明 `getBlur().page` 只是模型尺度；见 §16。
- t10 后文件哈希（t11 未改产品代码）：`readability.js` `2633D291…A1007F`、`console.js` `BA63E8C9…B44808`（未变）、`plugin-readability.browser.test.mjs` `9A08F9B6…B617D555`。

## 16. t12 文档同步与集成记录（2026-11-10，历史：实验开关之前）

> 历史快照：t16 已在 §18 追加「页面模糊（实验）」默认关闭、API/控制台、V9–V13 实验风险与最新测试。§16 的 alpha-only 描述是当时默认形态，但不再包含实验项，不能当作完整最终文档。

t12 只改文档，**未改产品代码**。把 t5 及 ADR/README 中「页面根无 filter + 同根 `::before` 背板为最终实现、V9–V13 开放」的过期描述，改为 t10/t11 的当前默认形态：

- **页面通道 alpha-only**：30% 底色；`backdrop-filter:none`、`filter:none`、`position:static`、`isolation:auto`，无 `::before` 背板；页面实际模糊 0。`getBlur().page = 2.4` 只是面板 sqrt 模型的尺度。
- **面板 blur 不变**：默认 3.69px；主会话/页面 0% 时 2px；嵌套层仍只做 alpha、无 filter。
- **V3/V9/V10/V11/V12/V13 全部关闭**：由移除页面 filter/背板/`position`/`isolation` 关闭；fixed 60/60、portal 40/40、absolute 10/12、层叠 high-inside、滚动 fill 覆盖底部。
- **V14 开放（产品取舍）**：30% alpha 把高对比后景文字对比度从 21:1 降到约 10.68:1，仍可见；30% 只能减弱、不能消除后方文字透出。若最初问题是会话/背景文字在页面后明显重叠，alpha-only 30% 不足，需 Lead/产品确认。
- **V15 低语义观察**：页面根仍可能带 `data-bc-material-blur="on"` 与 inline `--bc-material-blur:2.4px`，但 CSS 显式 `none`；不能当作页面实际模糊。
- **真实 DSH 仍未现场验证**：本机运行旧插件且无渲染器 DOM；15/15、140/140 只代表 Chromium/Edge fixture 与真实浏览器联动，不代表设置页/插件页/技能页/审批卡片/菜单/视频性能已在真实宿主通过。V14 是否满足最初产品目标也需现场/产品确认。
- **V7 交付提醒（t12 当时）**：`integrations/deepseek-harness/test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html` 当时尚未被 git 跟踪；后续已纳入，V7 已关闭，当前无未跟踪 fixture。

文档同步：

- [ADR 0011](../adr/0011-dsh-layered-material.md)：页面 alpha-only、V3/V9–V13 关闭、V14/V15、验收矩阵、最终测试/交付状态；历史 t8 背板仅作为演进记录，不再是最终实现。
- [docs/deepseek-harness.md](../deepseek-harness.md)：分层材质表改为页面 30% 底色、无页面模糊；风险段改为 V3/V9–V13 关闭、V14/V15；用户可见设计变更说明。
- [integrations/deepseek-harness/README.zh-CN.md](../../integrations/deepseek-harness/README.zh-CN.md)：同步 alpha-only、V14/V15、面板 blur 不变、测试/验证链接。
- 本文：顶部结论、§2 行为矩阵、§5.1 CSS 形状、§7.2、§8 V3、§11 验收对照更新；§13/§14 标注历史；§15 保留 t11 最终复验，§16 为 t12 文档同步。

### 16.1 最终测试（t12 文档改动后复跑，产品代码未变）

```powershell
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 套件 | 最终结果 |
|---|---|
| `node --check` ×3 | 3/3 exit 0 |
| `readability.test.mjs` | **21/21 pass，0 fail，0 skip** |
| `console.test.mjs` | **39/39 pass，0 fail，0 skip** |
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 fail，0 skip** |
| 全量 harness（带 Playwright/Edge） | **140/140 pass，0 fail，0 skip** |

### 16.2 最终 git 状态（`git status --short`）

```text
 M docs/deepseek-harness.md
 M integrations/deepseek-harness/README.zh-CN.md
 M integrations/deepseek-harness/console.js
 M integrations/deepseek-harness/readability.js
 M integrations/deepseek-harness/test/console.test.mjs
 M integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
 M integrations/deepseek-harness/test/readability.test.mjs
?? .agent-teams/
?? docs/adr/0011-dsh-layered-material.md
?? docs/verification/2026-11-10-dsh-layered-material.md
?? integrations/deepseek-harness/test/fixtures/backdrop-model.html
?? integrations/deepseek-harness/test/fixtures/fake-dom.mjs
?? integrations/deepseek-harness/test/fixtures/layered-material.mjs
```

- `.agent-teams/` 是团队运行时状态，不属于交付内容，提交时应排除。
- ADR、验证记录与三个 fixture 在 t12 当时未跟踪；后续已纳入版本控制（V7 已关闭），当前无未跟踪 fixture。
- `git diff --check` 对两份用户文档无空白错误；仅 `core.autocrlf` 的 LF→CRLF 提示，不改变内容。

### 16.3 最终风险表

| ID | 状态 | 说明 |
|---|---|---|
| V3 | **关闭**（t10/t11） | 页面 alpha-only 后不再创建 fixed 包含块；fixed 60/60、portal 40/40。t8/t9 背板为历史。 |
| V9 | **关闭** | 不再设置 `position:relative`；absolute 探针开/关 `(10,12)`。 |
| V10 | **关闭** | 不再设置 `isolation:isolate`；高 z-index 探针开/关 `high-inside`。 |
| V11 | **关闭** | 无 absolute 背板；`scrollTop=36` 后 30% fill 仍覆盖底部（delta 67）。 |
| V12 | **关闭** | 无 `position`/`isolation` 残留；`maxBlur=0` 只关面板 filter。 |
| V13 | **关闭** | 页面不再使用 `::before`。 |
| V14 | **开放（产品取舍）** | 30% alpha 只能减弱、不能消除后方文字透出；高对比 21:1→10.68:1，仍可见。需 Lead/产品确认是否足够。 |
| V15 | **低（语义观察）** | 页面仍带 blur 标记/变量但 CSS `none`；`getBlur().page` 仅模型值。 |
| V4–V8 | 当时状态 | 多独立浮层共用 `s2`、纯空白存储值差异、backdrop-model 未进 CI、fixtures 当时未跟踪（V7 后已解决）、真实 DSH 运行旧插件。 |

真实 DSH 未现场验证；本表只针对 Chromium/Edge fixture 与真实浏览器联动。

> §16 是 t12 在 t13/t14 加入「页面模糊（实验）」**之前**的 alpha-only 文档快照；当时产品默认是 §16 的 alpha-only，随后新增了默认关闭的实验开关。当前默认见 §19/§21/§22。

## 17. t15 实验页面模糊独立复验（2026-11-10，历史）

> 历史阶段：当时的「实验页面模糊默认关闭」已被 t17/t18 的「默认开启、面板 60%、tooltip 宿主样式、页内浮层暂停」取代；当前默认见 §19/§21/§22。

t13 在 `readability.js` 增加默认关闭的实验页面模糊（`beauticode-page-blur`、`getPageBlur/setPageBlur`），t14 在控制台「高级设置」增加「页面模糊（实验）」开关。t15 独立复跑，**未修改产品代码**。

```powershell
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 检查 | 结果 |
|---|---|
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 skip，0 fail** |
| `readability.test.mjs` | **21/21 pass** |
| `console.test.mjs` | **48/48 pass**（t14 新增 9 项） |
| `node --check` readability/client/console | 3/3 exit 0；`git diff --check` 无空白错误（仅 autocrlf 提示） |
| 全量 harness（带浏览器模块） | **149/149 pass，0 skip，0 fail** |
| `.tmp/t15-page-blur-check.mjs`（readability/API/背板边界） | 全部断言通过 |
| `.tmp/t15-console-page-blur-check.mjs`（真实 console + readability 同页） | 全部断言通过 |

### 17.1 默认关闭（安全形态）

| 检查 | 实测 |
|---|---|
| API | `getPageBlur() === false`；`getBlur() === {page:0, panel:3.69}`；存储键缺失 |
| 页面根 | alpha **77/255（.30）**、`backdrop-filter:none`、`filter:none`、`position:static`、`isolation:auto`、无 blur 标记、无内联 blur、`::before content:none` |
| 固定/绝对/叠放 | 页面内 fixed `(60,60)`、portal `(40,40)`、absolute `(10,12)`、高 z-index 探针 `high-inside` |
| V11 默认 | 页面列滚动到底部时 30% fill 仍覆盖；底部 strip 开关 fill delta **47** |
| 面板 | dialog `blur(3.69px)` 不变 |
| 结论 | t15 当时默认路径是 t10 alpha-only；V3/V9/V10/V11/V12/V13 均不出现 |

### 17.2 开启实验（已知风险按 opt-in 接受）

`setPageBlur(true)` 后：

| 检查 | 实测 |
|---|---|
| API/存储/flag | `getPageBlur()===true`、`getBlur()==={page:2.4,panel:3.69}`、`beauticode-page-blur="true"`、`html[data-bc-page-blur="true"]` |
| 页面根 | alpha **77/255**；`backdrop-filter:none`、`filter:none`；`position:relative`、`isolation:isolate`、`data-bc-material-blur="on"`、inline `--bc-material-blur:2.4px` |
| 背板 | `::before` content `""`、absolute、z-index -1、pointer-events none、`blur(2.4px)`；高频壁纸视觉模糊 delta **89** |
| fixed/portal | 页面内 fixed 仍 **`(60,60)`**、portal **`(40,40)`**（实验背板不重新引入 V3 fixed 偏移） |
| V9（实验） | absolute 探针 **`(250,12)`**（页面列 x=240 + 10），包含块变为页面根 |
| V10（实验） | 页面内 `z-index:9999` 探针被同父 `z-index:1` 兄弟压过（`high-outside`） |
| V11（实验） | `scrollTop=36` 后底部 strip 模糊开/关 delta **1**，底部 36px 失去背板模糊 |
| 面板 | dialog `blur(3.69px)` 不变 |

### 17.3 关闭、页面 0% 与控制台联动

| 检查 | 实测 |
|---|---|
| 关闭实验 | `setPageBlur(false)`：存储 `"false"`、flag 移除、root `static/auto`、`::before none`、`getBlur().page=0`、absolute `(10,12)`、`high-inside` 恢复 |
| 页面 0%（实验开） | `data-bc-page-blur` 移除、页面 root 数量 0、存储仍 `"true"`、`getPageBlur()===true`、`getBlur().page=0`；恢复页面 30% 后背板/flag 自动恢复 |
| 控制台默认 | 「页面模糊（实验）」按钮「已关」、`aria-pressed=false`、enabled（页面 30%）、提示隐藏；无 flag |
| 控制台开启（同一次 `evaluate` 内点击后立即读 DOM） | flag true、存储 true、root `relative/isolate`、`::before blur(2.4px)`、alpha 77、按钮「已开」/`aria-pressed=true`、`getBlur().page=2.4`；**不依赖 storage 事件** |
| 控制台重置 | 按钮/API/存储/形态全部回到 false/static/auto/no pseudo；`getBlur().page=0` |
| 页面 0% 控制台 | 开关与重置 disabled、`.bc-row-hint` 可见；点击 disabled 按钮 no-op（存储/flag 不变）；存储选项保留；恢复 30% 后按钮 enabled 且背板恢复 |
| 面板 blur | 默认/实验/关闭全过程均 `blur(3.69px)`，不被页面开关重置 |

### 17.4 状态结论

- **t15 当时默认仍是 alpha-only**：t13/t14 的实验项默认关闭；V3/V9/V10/V11/V12/V13 在默认路径保持关闭；V15（页面 blur 标记/模型语义）在默认路径也消失（页面根无 blur 标记、`getBlur().page=0`）。t17 起默认已改为页面模糊开启，见 §19。
- **实验开启时有意复现已知风险**：V9 absolute 包含块（250）、V10 isolation 层叠（high-outside）、V11 滚动底部失模糊（delta 1）；V3 fixed 仍 60，不重新引入原 fixed 偏移。UI 文案与注释已标「实验、默认关闭、仅建议现场试验」，这些是 opt-in 的已知行为，不作为默认回归；建议 Lead/产品决定是否保留该实验入口。
- **V14 仍未关闭（产品取舍）**：t13/t14 的实验 blur 可以在开启时提供页面模糊，但默认关闭；默认 alpha-only 30% 仍不能消除后方文字透出（t11：21:1→10.68:1）。
- **文档同步**：t13/t14 的「实验默认关闭」已被 t17/t18 的「页面模糊默认开启、面板 60%、tooltip 宿主样式、页内浮层暂停」取代；t20 已按 §19 更新 ADR/docs/README，见 §20。§16–§18 仅保留为历史。
- 真实 DSH 仍未现场验证；15/15、21/21、48/48、149/149 只代表 Edge fixture 与真实浏览器联动。
- t13/t14 后文件哈希：`readability.js` `D71DA27D…B3E3B9`、`console.js` `D1991C4D…394A182`、`plugin-readability.browser.test.mjs` `A9CC067E…6376C58`。

## 18. t16 文档同步与集成记录（2026-11-10，历史：实验默认关闭时代）

> 历史快照：t17/t18 已把页面模糊改为默认开启、面板默认 60%、tooltip 移出材质并加入页内浮层暂停；t20 已在 §20 更新文档。本节不再代表当前默认。

t16 只改文档，**未改产品代码**。在 t12 的 alpha-only 文档上追加 t13/t14/t15 的「页面模糊（实验）」：

- **默认形态不变**：页面 alpha-only 30%，无 `backdrop-filter`/背板/`position`/`isolation`；`getPageBlur=false`、`getBlur().page=0`、panel=3.69；V3/V9/V10/V11/V12/V13 默认不出现；V14 开放；V15 默认消失（无 blur 标记/变量）。
- **实验项默认关闭、不推荐**：控制台「高级设置 → 页面模糊（实验）」默认「已关」；存储 `beauticode-page-blur`（仅字面 `"true"` 开启）；API `getPageBlur()`/`setPageBlur(boolean)`；文案「默认关闭；开启后会启用页面背板，可能影响页面内 fixed/absolute/高层浮层；仅建议现场试验」。
- **开启后**：`html[data-bc-page-blur="true"]`、页面根 `position:relative`/`isolation:isolate`、`::before blur(2.4px)`、页面 alpha 77/255、`getBlur().page=2.4`；fixed 仍 60/60、portal 40/40（**不重新引入 V3 fixed 偏移**），但 V9 absolute 250、V10 high-outside、V11 滚动底部约 36px 失模糊（delta 1）；面板 blur 3.69 不变。开启后必须重新现场验收 V9–V13，不能把自动化结果当现场通过。
- **关闭 / 页面 0%**：关闭后存储 `"false"`、flag/背板/定位移除、`getBlur().page=0`、absolute/fixed/stacking 恢复；页面 0% 时 flag/页面根移除、存储仍 `"true"`、控制台按钮/重置 disabled、`.bc-row-hint`「需要页面材质 >0」可见、点击 no-op，恢复 30% 后背板自动恢复。
- **V14**：30% alpha 只能把高对比后景文字从 21:1 降到 10.68:1，不能消除后方文字透出；实验 blur 默认关闭，也不宣称解决 V14。
- **真实 DSH**：仍未现场验证；15/15、21/21、48/48、149/149 只代表 Chromium/Edge fixture 与真实浏览器联动，不代表设置页/插件页/技能页/审批卡片/菜单/视频性能或实验项已在真实宿主通过。实验项是否保留需用户/DSH 现场实测后决定。
- **V7（t15 当时）**：`test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html` 当时仍未跟踪；后续已纳入版本控制，V7 已关闭，当前无未跟踪 fixture。

文档互链：

- [ADR 0011](../adr/0011-dsh-layered-material.md)：默认 alpha-only + 实验项、`getBlur` 语义、V9–V13 实验风险、验收矩阵、测试/交付状态；§10 链接 §15/§16/§17/§18。
- [docs/deepseek-harness.md](../deepseek-harness.md)：新增「页面模糊（实验）」行、默认 `getBlur().page=0`、实验开启副作用、控制台禁用/提示、测试与链接。
- [integrations/deepseek-harness/README.zh-CN.md](../../integrations/deepseek-harness/README.zh-CN.md)：同步实验项、默认关闭/不推荐、V14/V15、测试与验证链接。
- 本文：顶部结论、§2 行为矩阵、§5.1 CSS 形状、§7.2 现场项、§8 状态、§11 验收对照更新；§16 标注历史；§17 为 t15 实验复验，§18 为 t16 文档同步。

### 18.1 最终测试（t16 文档改动后复跑，产品代码未变）

```powershell
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 套件 | 最终结果 |
|---|---|
| `node --check` ×3 | 3/3 exit 0 |
| `readability.test.mjs` | **21/21 pass，0 fail，0 skip** |
| `console.test.mjs` | **48/48 pass，0 fail，0 skip**（t14 新增 9） |
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 fail，0 skip** |
| 全量 harness（带 Playwright/Edge） | **149/149 pass，0 fail，0 skip** |
| `git diff --check` | 干净（仅 LF→CRLF 提示） |

### 18.2 最终 git 状态（`git status --short`）

```text
 M docs/deepseek-harness.md
 M integrations/deepseek-harness/README.zh-CN.md
 M integrations/deepseek-harness/console.js
 M integrations/deepseek-harness/readability.js
 M integrations/deepseek-harness/test/console.test.mjs
 M integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
 M integrations/deepseek-harness/test/readability.test.mjs
?? .agent-teams/
?? docs/adr/0011-dsh-layered-material.md
?? docs/verification/2026-11-10-dsh-layered-material.md
?? integrations/deepseek-harness/test/fixtures/backdrop-model.html
?? integrations/deepseek-harness/test/fixtures/fake-dom.mjs
?? integrations/deepseek-harness/test/fixtures/layered-material.mjs
```

- `.agent-teams/` 是团队运行时状态，不属于交付内容，提交时应排除。
- ADR、验证记录与三个 fixture 在 t16 当时未跟踪；后续已纳入版本控制（V7 已关闭），当前无未跟踪 fixture。
- `git diff --check` 对文档无空白错误；仅 `core.autocrlf` 的 LF→CRLF 提示，不改变内容。

### 18.3 最终风险表

| ID | 默认（实验关闭） | 实验开启（opt-in） |
|---|---|---|
| V3 | **关闭**：fixed 60/60、portal 40/40 | fixed 仍 60/60、portal 40/40；**不重新引入 fixed 偏移** |
| V9 | **关闭**：absolute 10/12 | **实验出现**：absolute 250 |
| V10 | **关闭**：high-inside | **实验出现**：high-outside |
| V11 | **关闭**：滚动 fill 覆盖底部（delta 47/67） | **实验出现**：滚动底部约 36px 失模糊（delta 1） |
| V12 | **关闭**：无 position/isolation | 实验开启时存在 position/isolation（opt-in） |
| V13 | **关闭**：无 ::before | 实验开启时使用页面 ::before（opt-in） |
| V14 | **开放**：30% alpha 不能消除后方文字透出（21:1→10.68:1） | 默认关闭；实验 blur 也不宣称解决 |
| V15 | **默认消失**：无 blur 标记/变量、`getBlur().page=0` | 实验开启时 `getBlur().page=2.4`，是实际应用值 |
| V4–V8 | 状态不变 | 状态不变 |

真实 DSH 未现场验证；本表只针对 Chromium/Edge fixture 与真实浏览器联动。实验项需用户完成 DSH 安装实测后再决定是否保留/清理。

## 19. t19 现场修复独立复验（2026-11-10，t19 当时；最终数字见 §21/§22/§24）

t17/t18 改为：面板默认 **60%**、页面模糊**默认开启**、页面根内标准 role 改为 60% 面板材质、tooltip 不再改写宿主样式、页面根内浮层打开时暂停页面背板。t19 独立复跑，**未修改产品代码**。

```powershell
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js
git diff --check
```

| 命令 / 检查 | 结果 |
|---|---|
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 skip，0 fail** |
| `readability.test.mjs` | **21/21 pass** |
| `console.test.mjs` | **48/48 pass**（t18 更新默认值后） |
| `node --check` readability/client/console | 3/3 exit 0 |
| `git diff --check` | 干净（仅 autocrlf LF→CRLF 提示） |
| 全量 harness（带浏览器模块） | **149/149 pass，0 skip，0 fail**（含 15 材质 + 3 background） |
| `.tmp/t19-field-fix-check.mjs`（独立 Edge + fixture） | 全部断言通过 |
| `.tmp/t18-defaults-check.mjs`（真实 console+readability，复跑） | 全部断言通过：默认面板 60%/页面模糊开 |

### 19.1 默认形态

| 检查 | 实测 |
|---|---|
| API | `getPage()=30`、`get()=60`、`getPageBlur()=true`、`getBlur()={page:2.4,panel:3.69}`、`html[data-bc-page-blur="true"]` |
| 页面根 | alpha **77/255（.30）**、`backdrop-filter:none`、`position:relative`、`isolation:isolate`、`::before blur(2.4px)` |
| 面板 | dialog alpha **153/255（.60）**、`blur(3.69px)`；主会话 composer alpha 153、`blur(2px)`、无 page root |
| 几何 | 页面内 fixed `(60,60)`、portal `(40,40)`；页面列未被背板改变 |
| 外部 tooltip | 不触发暂停，无 material/layer，背景/文字保持宿主（测试用 `rgb(20,24,32)` / `rgb(249,250,251)`） |

### 19.2 页面根内 tooltip / menu / listbox / dialog

| 场景 | 实测 |
|---|---|
| 页内 menu + tooltip | 页面根出现 `data-bc-page-blur-paused`；根 `static/auto`、`::before none`、alpha 仍 77；`getBlur().page=0`，panel blur 3.69 不变 |
| 页内 menu | root=panel、alpha **153/255**、`backdrop-filter:none`、无 `data-bc-material-blur`（不是 page 0.38，不会因 isolation 漂移） |
| menu 内 tooltip | 无 material/layer、`backdrop:none`、背景/文字与页面外 host tooltip 相同、viewport 坐标 `(40,40)`；`--dsw-alias-tooltip-bg` 在 body 与 menu 上均为 `rgb(20,24,32)`，未被 8-token 改写 |
| 页内 dialog / listbox（各自单独） | 均 root=panel、alpha 153、backdrop none；各自触发暂停，移除后恢复背板 |
| 暂停时 V9/V10 | absolute 探针回到 **`(10,12)`**；高 z-index 探针回到 **`high-inside`**（暂停消除了 V9/V10） |
| 关闭全部浮层 | 暂停标记移除、`::before` 与 `relative/isolate` 恢复、`getBlur().page=2.4` |

### 19.3 V9/V10/V11 的真实状态

- **默认页面模糊开启且没有页内浮层时，V9/V10 仍存在**：独立探针测得 absolute **`(250,12)`**（页面列 x=240+10），高 z-index 探针为 **`default-outside`**。暂停机制只覆盖“页内出现可见 tooltip/menu/listbox/dialog/alertdialog”的场景；普通页面内容的 absolute/层叠风险仍在。这是 t17/t18 把页面模糊改成默认开启后的核心取舍，必须由 Lead/产品决定。
- **V11 仍开放**：独立补高页面内容后 `scrollTop=300`，底部 strip（420,768,160×20）模糊开/关 delta **1**，即 absolute 背板滚动后最后一段不再模糊。暂停机制不解决此问题。
- **V3 fixed 仍关闭**：即使页面模糊开启，页面内 fixed 开/关均 `(60,60)`、portal `(40,40)`。
- **V12**：`maxBlur=0` 时页面无背板/`position`/`isolation`，已关闭；**V13**：页面模糊开启时仍使用页面根 `::before`，宿主若占用该伪元素仍有覆盖风险（开放）。
- **V14**：页面模糊默认开启后，默认不再是“30% alpha-only”；但用户关闭页面模糊时 V14（30% 不能消除后方文字透出）仍适用，实验开启的 2.4px 模糊也不宣称完全解决。保持开放/产品取舍。
- **V15**：默认页面模糊开启时页面根 blur 标记与实际 `::before` 一致；关闭后标记/变量移除；语义观察已闭合。
- **V16（新，低-中）**：暂停选择器包含任意可见的 `role=listbox/dialog` 等页面内元素，不只是临时浮层。页面自身常驻的 listbox/dialog 可能让页面模糊一直处于暂停；需真实 DSH/第三方页检查。暂停本身是 t17 为 tooltip/菜单定位引入的保护，不能简单删除。

### 19.4 回退

- 页面 0%：page root 0、`data-bc-page-blur` 移除、backplate/position/isolation 移除；面板仍 60%（dialog 153）。
- `maxBlur=0`：页面无 `::before`/position/isolation，`getBlur().page=0`。
- 页面模糊关闭（`setPageBlur(false)`）：页面根 static/auto、无伪元素，面板仍 60%/3.69；重新开启恢复 `::before blur(2.4px)`。
- 控制台真实浏览器（复跑 t18 探针）：默认面板 60%、页面模糊“已开”；已存 35 保持 35%（alpha 89），不强制迁移；页面 0% 按钮/重置 disabled、提示可见、存储保留；重置写回 true。

### 19.5 结论与文档

- 默认形态、tooltip 宿主样式、页内 60% 面板、暂停时序、页面 0%/maxBlur0/关闭模糊、主会话均通过真实 Edge fixture 验证；t19 当时为 15/15、21/21、48/48、149/149，最终 console 49/49、全量 150/150 见 §21/§22/§24。真实 DSH 仍未现场验证（当前运行上一版候选，需重新安装/重启后才能看到本轮结果），**不得宣称现场通过**。
- **文档同步**：t20 已按本节的“面板 60%、页面模糊默认开启、无实验文案、页面内 tooltip 不改写、暂停机制”更新 ADR、`docs/deepseek-harness.md`、README 与本文，并写入 V9/V10 默认仍存在（仅页内浮层暂停时消除）、V11/V13/V14/V16、真实 DSH 未验证；见 §20。
- t17/t18 后文件哈希：`readability.js` `86EA4C65…A9A8B703A`、`console.js` `F13736EB…C7E896E`、`plugin-readability.browser.test.mjs` `31D55251…86D519C2`。

## 20. t20 文档同步与集成记录（2026-11-10，历史：方向移除之前）

> 历史快照：t20 仍含「自动档位方向」行/`beauticode-material-direction`；t21/t22 已移除方向，t24 已按 §21 更新 ADR/docs/README，见 §22。默认面板 60/页面模糊开/tooltip/暂停仍延续。

t20 只改文档，**未改产品代码**。按 t17–t19 的最终现场修复口径重写：

- **默认**：页面材质 30%、页面模糊默认开启（`getPageBlur=true`、`getBlur={page:2.4,panel:3.69}`、页面根 `relative/isolate`、`::before blur(2.4px)`）；面板默认 **60%**（dialog alpha 153、blur 3.69）；主会话 composer 60%、blur 2px；`beauticode-page-blur` 默认 true，仅字面 `"false"` 关闭；面板键缺失/`"true"`→60、`"false"`→0、数字保留（35 仍是 35）、重置 60。
- **tooltip**：不再材质化、不是候选、不改写 `--dsw-alias-tooltip-bg`，保留宿主黑底白字/定位；页内 tooltip 只触发页面模糊暂停。
- **页内 menu/listbox/dialog/alertdialog**：按面板材质 60% 处理，`backdrop-filter:none`，不继承 page alpha。
- **页面模糊暂停**：页内出现可见 tooltip/menu/listbox/dialog/alertdialog 时，页面根 `data-bc-page-blur-paused`，移除 `position`/`isolation`/`::before`，仅保留 30% alpha，`getBlur().page=0`；关闭后恢复 `relative/isolate`/`blur(2.4px)`。暂停只消除页内浮层下的 V9/V10 漂移，不是永久解决。
- **V9/V10**：默认页面模糊开启且无页内浮层时仍存在（absolute 250、default-outside）；暂停期间回到 10/12、high-inside。**V11** 滚动底部失模糊、**V13** 页面 `::before` 覆盖、**V14** 关闭模糊时后方文字透出、**V16** 暂停可能被常驻页内控件长期触发，均开放；**V3 fixed 60/60 关闭**；**V12/V15 关闭**。
- **面板 60% 取舍**：默认从 100% 降到 60%，后景更明显透出；设置页/添加插件弹窗在 35% 下已偏透，60% 是新基线；已有 35/40 等保存值保留，不强制迁移。
- **真实 DSH**：当前运行上一版候选，未验证本轮 tooltip/暂停/面板 60/页面模糊默认开启；需重新安装/重启候选后现场确认，不能宣称本轮现场通过。
- **fixtures**：三个 fixture 已随上一提交纳入版本控制，当前 `git status` 无未跟踪 fixture（V7 已解决）；交付时确认提交包含它们。

文档同步：

- [ADR 0011](../adr/0011-dsh-layered-material.md)：页面模糊默认开、面板 60、tooltip 不材质化、页内浮层暂停、V9/V10 默认仍存在、V11/V13/V14/V16；§10 链接 §19/§20。
- [docs/deepseek-harness.md](../deepseek-harness.md)：重写分层材质表/默认值、tooltip、暂停时序、风险与测试；删除实验默认关闭旧文案。
- [integrations/deepseek-harness/README.zh-CN.md](../../integrations/deepseek-harness/README.zh-CN.md)：同步面板 60、页面模糊默认开、tooltip/暂停、V9/V10/V11/V13/V14/V16、真实 DSH 待测。
- 本文：顶部结论、§2 行为矩阵、§5.1 CSS 形状、§7.2 现场项、§8 状态、§11 验收对照更新；§16/§18 标注历史；§19 为 t19 最终复验，§20 为 t20 文档同步。

### 20.1 最终测试（t20 文档改动后复跑，产品代码未变）

```powershell
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 套件 | 最终结果 |
|---|---|
| `node --check` ×3 | 3/3 exit 0 |
| `readability.test.mjs` | **21/21 pass，0 fail，0 skip** |
| `console.test.mjs` | **48/48 pass，0 fail，0 skip** |
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 fail，0 skip** |
| 全量 harness（带 Playwright/Edge） | **149/149 pass，0 fail，0 skip** |
| `git diff --check` | 干净（仅 LF→CRLF 提示） |

### 20.2 最终 git 状态（`git status --short`）

```text
 M docs/adr/0011-dsh-layered-material.md
 M docs/deepseek-harness.md
 M docs/verification/2026-11-10-dsh-layered-material.md
 M integrations/deepseek-harness/README.zh-CN.md
 M integrations/deepseek-harness/console.js
 M integrations/deepseek-harness/readability.js
 M integrations/deepseek-harness/test/console.test.mjs
 M integrations/deepseek-harness/test/fixtures/layered-material.mjs
 M integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
 M integrations/deepseek-harness/test/readability.test.mjs
?? .agent-teams/
```

- `.agent-teams/` 是团队运行时状态，不属于交付内容，提交时应排除。
- 三个 fixture 已纳入版本控制；当前仅有 `layered-material.mjs` 的内容修改，无未跟踪 fixture。
- `git diff --check` 对文档无空白错误；仅 `core.autocrlf` 的 LF→CRLF 提示，不改变内容。

### 20.3 最终风险表

| ID | 默认（页面模糊开启、无页内浮层） | 页内浮层暂停时 |
|---|---|---|
| V3 | **关闭**：fixed 60/60、portal 40/40 | 仍 60/60、40/40 |
| V9 | **存在**：absolute 250 | **消除**：absolute 10/12 |
| V10 | **存在**：default-outside | **消除**：high-inside |
| V11 | **开放**：滚动底部 delta 1 | 暂停不解决 |
| V12 | **关闭**：maxBlur0 无背板/position/isolation | 关闭 |
| V13 | **开放**：页面 `::before` 可能被占用 | 暂停时无伪元素，但仍需现场复核 |
| V14 | **开放**：关闭页面模糊时 30% alpha 不能消除后方文字透出 | 同样开放 |
| V15 | **关闭**：blur 标记/实际值一致 | 关闭 |
| V16 | **开放（低-中）**：暂停选择器可能被常驻页内控件长期触发 | 需现场复核 |

真实 DSH 未现场验证；本表只针对 Chromium/Edge fixture 与真实浏览器联动。页面模糊默认开启、面板 60、tooltip/暂停都需要新候选安装/重启后现场确认。

## 21. t23 方向设置移除与“越上层越实”独立复验（2026-11-10）

t21 从 `readability.js` 删除方向配置，固定嵌套层越深越实；t22 从控制台删除「自动档位方向」行。t23 独立复跑，**未修改产品代码**。

```powershell
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js
git diff --check
```

| 命令 / 检查 | 结果 |
|---|---|
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 skip，0 fail** |
| `readability.test.mjs` | **21/21 pass** |
| `console.test.mjs` | **49/49 pass** |
| `node --check` readability/client/console | 3/3 exit 0 |
| `git diff --check` | 干净（仅 autocrlf LF→CRLF 提示） |
| 全量 harness（带浏览器模块） | **150/150 pass，0 skip，0 fail** |
| `.tmp/t23-direction-check.mjs`（独立 Edge：readability + 真实 console） | 全部断言通过 |
| `.tmp/t19-field-fix-check.mjs`（tooltip/暂停/面板 60 回归） | 通过（方向移除后复跑） |

### 21.1 API / 存储清理

| 检查 | 实测 |
|---|---|
| 默认值 | `getPage()=30`、`get()=60`、`getPageBlur()=true`；`defaults` 为 `{page:30,pageBlur:true,panel:60,alphaStep:8,blurStep:2,maxBlur:8}` |
| `getMaterial()` | 仅 `{alphaStep:8,blurStep:2,maxBlur:8}`，**无 direction** |
| `storageKeys.direction` | `undefined`（键已退休） |
| `--bc-material-direction` | 根元素上不存在/空字符串 |
| 旧存储 `beauticode-material-direction="down"` | 加载后仍保留 `"down"`，**未被读取、未被改写**；嵌套 alpha 仍递增 |
| `setMaterial({direction:"down"})` | 静默忽略，返回值不含 direction，不写旧键 |
| `setMaterial({direction:"down", alphaStep:12})` | 仅 alphaStep 生效；旧 direction 键仍保持原值 |
| 跨窗口 `storage` 事件 key=direction | 被忽略；旧值不变、alpha 不变 |
| 嵌套 alpha（面板 60%、默认 step 8） | depth 2 = **173/255（.68）**、depth 3 = **194/255（.76）**；alphaStep 12 后为 **184（.72）**、**214（.84）**，单调递增 |
| 页内 panel 默认 | menu/listbox 面板根 alpha 153；页面模糊暂停逻辑不变 |

### 21.2 控制台

真实 Edge 加载真实 `console.js` + `readability.js`，并预先写入旧方向键 `"down"`：

| 检查 | 实测 |
|---|---|
| 方向行/重置箭头 | `[data-row="direction"]` 与 `[data-act="direction-reset"]` 均不存在 |
| 方向文案/变量 | 页面无自动方向渲染；`--bc-material-direction` 为空 |
| 旧键 | 加载后仍为 `"down"`，控制台未读/未写/未迁移 |
| 默认值 | 面板滑杆 `60`/标签 `60%`；页面模糊按钮 `aria-pressed=true`（默认开） |
| `getMaterial` | `{alphaStep:8,blurStep:2,maxBlur:8}`，无 direction |
| 修改 alphaStep=12 | 只写 `beauticode-material-alpha-step`；旧 direction 仍 `"down"`、变量仍为空、面板仍 60 |

### 21.3 状态与差异

- 方向键、方向 API 字段、方向 CSS 变量、控制台方向行均已清理；旧值保留但无影响，**不做迁移/删除**，这是兼容策略而非遗漏。控制台/第三方若仍发送 `direction` 会被静默忽略，不报错。
- 越上层越实的 alpha 公式在默认面板 60% 下实测 `.68/.76`，alphaStep 12 时 `.72/.84`，无 down 分支；`set(100)` 夹取 1、无 page 等旧断言仍由 21/21 单测覆盖。
- 页面 30/面板 60/页面模糊开、tooltip 宿主样式/暂停、面板 60 等 t17/t18 行为在方向移除后复跑无回归。
- **文档同步**：t24 已删除 ADR、`docs/deepseek-harness.md`、README 与本文中的方向行/键/API 字段描述，写明旧键保留但忽略、`getMaterial` 不再含 direction、嵌套固定递增；并补充侧栏/主会话边界。见 §22。
- 真实 DSH 仍未现场验证；15/15、21/21、49/49、150/150 只代表 Chromium/Edge fixture 与真实浏览器联动，不能宣称现场通过。
- t21/t22 后文件哈希：`readability.js` `19F21727…0562ACB`、`console.js` `EFF9CC39…9117DFF`、`plugin-readability.browser.test.mjs` `16D2CDB1…EA45832`、`console.test.mjs` `FDB35EEF…5555E20`。

## 22. t24 文档同步与最终集成记录（2026-11-10，t24 当时；最终见 §24）

t24 只改文档，**未改产品代码**。按 t21–t23 的最终口径：

- **方向配置已移除**：控制台高级设置没有「自动档位方向」行、没有越上层越透/up-down 文案；高级设置只有 alpha-step、blur-step、max-blur 三个滑杆加页面模糊。`getMaterial()` 只返回 `{alphaStep,blurStep,maxBlur}`，`setMaterial({direction})` 静默忽略；`beauticode-material-direction` 不读不写、不在 `storageKeys`、不参与 storage 事件，旧值保留但无影响。嵌套 alpha 固定 `rootAlpha + (depth-1)*alphaStep`，实现 `.60→.68→.76`（alphaStep 12 时 `.72→.84`）。
- **默认不变**：页面 30%、页面模糊默认开（`getPageBlur=true`、`getBlur={page:2.4,panel:3.69}`、`::before blur(2.4px)`）、面板 60%（alpha 153、blur 3.69）、tooltip 宿主黑底白字、页内 menu/listbox/dialog 面板 60%、页内浮层暂停页面模糊。
- **侧栏/主会话**：左侧栏在 `[data-global-panel]` 之外，由 `client.js` 的 `--bc-surface-mix`（默认 36%，会话 active/settling 86%）与 `--dsw-specific-sidebar-fill` 决定，不随页面/面板滑杆或页面模糊变化；背景阴影/壁纸磨砂只改变透出的壁纸，不是侧栏自身材质。主会话没有 `[data-global-panel]`，页面材质/页面模糊不铺，保持壁纸直出；未来统一页面需独立可选项，不应默认扩展。
- **文档互链（t26 后）**：ADR §10 链接 §21/§22/§23/§24；docs/deepseek-harness.md 与 README 链接 §21/§24（§19/§20 标历史）；锚点指向存在章节（ADR §4 风险、验证 §21/§24）。t5/t12/t16/t20 历史段落已标历史，不再与当前默认矛盾。
- **真实 DSH**：当前运行上一版候选，未验证本轮 tooltip/暂停/面板 60/页面模糊默认开启/方向移除；需重新安装/重启后现场确认，不能宣称本轮现场通过。
- **fixtures**：已随上一提交纳入版本控制，当前 `git status` 无未跟踪 fixture。

### 22.1 最终测试（t24 文档改动后复跑，产品代码未变）

```powershell
node --check integrations/deepseek-harness/readability.js
node --check integrations/deepseek-harness/client.js
node --check integrations/deepseek-harness/console.js
node --test integrations/deepseek-harness/test/readability.test.mjs
node --test integrations/deepseek-harness/test/console.test.mjs
$env:BEAUTICODE_PLAYWRIGHT_MODULE='file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs'
$env:BEAUTICODE_BROWSER_CHANNEL='msedge'
node --test integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
node --test "integrations/deepseek-harness/test/*.test.mjs"
```

| 命令 / 套件 | 最终结果 |
|---|---|
| `node --check` ×3 | 3/3 exit 0 |
| `readability.test.mjs` | **21/21 pass，0 fail，0 skip** |
| `console.test.mjs` | **49/49 pass，0 fail，0 skip** |
| `plugin-readability.browser.test.mjs` | **15/15 pass，0 fail，0 skip** |
| 全量 harness（带 Playwright/Edge） | **150/150 pass，0 fail，0 skip** |
| `git diff --check` | 干净（仅 LF→CRLF 提示） |

### 22.2 最终 git 状态（`git status --short`）

```text
 M docs/adr/0011-dsh-layered-material.md
 M docs/deepseek-harness.md
 M docs/verification/2026-11-10-dsh-layered-material.md
 M integrations/deepseek-harness/README.zh-CN.md
 M integrations/deepseek-harness/console.js
 M integrations/deepseek-harness/readability.js
 M integrations/deepseek-harness/test/console.test.mjs
 M integrations/deepseek-harness/test/fixtures/layered-material.mjs
 M integrations/deepseek-harness/test/plugin-readability.browser.test.mjs
 M integrations/deepseek-harness/test/readability.test.mjs
?? .agent-teams/
```

- `.agent-teams/` 是团队运行时状态，不属于交付内容，提交时应排除。
- 三个 fixture 已纳入版本控制；当前仅 `layered-material.mjs` 有内容修改，无未跟踪 fixture。

### 22.3 当前风险表

| ID | 状态 |
|---|---|
| V3 | **关闭**：fixed 60/60、portal 40/40 |
| V9/V10 | **默认页面模糊开启且无页内浮层时存在**（absolute 250、default-outside）；页内浮层暂停时回到 10/12、high-inside，暂停结束恢复 |
| V11 | **开放**：滚动底部 delta 1 |
| V12 | **关闭**：maxBlur0 无背板/position/isolation |
| V13 | **开放**：页面 `::before` 可能被占用 |
| V14 | **开放**：关闭页面模糊时 30% alpha 不能消除后方文字透出 |
| V15 | **关闭**：blur 标记与实际值一致 |
| V16 | **开放（低-中）**：暂停选择器可能被常驻页内控件长期触发 |
| 方向 | **已移除**：无 UI/键/API 字段，旧值忽略；固定越上层越实 |

真实 DSH 未现场验证；本表只针对 Chromium/Edge fixture 与真实浏览器联动。

## 23. t25 提交前文档一致性检查（2026-11-10，t25 当时，只读）

范围：`docs/deepseek-harness.md`、`integrations/deepseek-harness/README.zh-CN.md`、`docs/adr/0011-dsh-layered-material.md`、本验证记录，以及 `readability.js`/`console.js` 的默认值与 API。未改产品代码，也未改上述前三份文档；本节只追加检查记录。

**结论（t25 当时）：不建议按当前工作树直接提交；t26 已按本节修复，见 §24。** 产品代码默认值/API 与 README 当前口径通过；`docs/deepseek-harness.md`、ADR 与本验证记录仍有方向残留、过期默认值、夹具“未跟踪”旧话术、旧测试数字和失效的“最新见 §…”交叉引用。以下为逐文件结论与行号。

| 文件 | 结论 | 关键位置 |
|---|---|---|
| `docs/deepseek-harness.md` | **FAIL** | `:28` 写“alpha 增加/减少多少”；其余默认值表（页面 30、面板 60、页面模糊开启、8/2/8）与当前代码一致 |
| `integrations/deepseek-harness/README.zh-CN.md` | **PASS（语义）** | `:21`/`:31` 默认值、页面模糊、tooltip/暂停、150/150、49/49 与 §19/§21 链接均正确；`:21` 仍按兼容说明提到旧 `beauticode-material-direction`，若发布门禁要求字面零出现则需另删（见下） |
| `docs/adr/0011-dsh-layered-material.md` | **FAIL** | `:169`“递增/递减”；`:377`、`:529`、`:572`、`:573` 默认值/重置仍写 `"up"`；`:642`“四个 `beauticode-material-*` 键”实为三个 |
| 本验证记录 | **FAIL** | `:10` 把 §20 当最终记录；`:86`/`:87` 重复存储行且含 `"up"`；`:131`/`:133`/`:134`/`:138` 旧候选、panel 100、alpha-only、四个键；`:150` 等夹具“未跟踪”；`:232`/`:237`/`:240` 旧 t4 数字/未暂存；`:732`/`:735`/`:779` 旧 t19 数字；`:246`/`:290`/`:346`/`:353` 等“最新见”指向历史节 |
| `readability.js` / `console.js` | **PASS** | 默认 `page30/pageBlur true/panel60/alphaStep8/blurStep2/maxBlur8`；`getMaterial()` 仅 `{alphaStep,blurStep,maxBlur}`；`storageKeys.direction` 不存在；控制台无方向行，面板滑杆 60、页面模糊默认开 |

### 23.1 必须修的方向/默认值残留

1. `docs/deepseek-harness.md:28`：“嵌套层每深一层，alpha 增加/减少多少”应改为只增加（`根 alpha + (depth-1) × alphaStep`），删除“减少”。
2. ADR `:169`：“alpha 逐级递增/递减”应改为“逐级递增”。
3. ADR `:377`、`:573` 的重置默认值串仍为 `30 / 60 / 8 / 2 / 8 / "up" / 页面模糊 true`；`:529`、`:572` 的默认值仍写 `8 / 2 / 8 / "up"`。方向已移除，应删除 `"up"`，只保留 30/60/8/2/8 与页面模糊 true。
4. ADR `:642`：“旧版忽略 `beauticode-page-material` 与四个 `beauticode-material-*` 键”应改为三个高级键（`alpha-step`、`blur-step`、`max-blur`）；`beauticode-page-material` 是独立页面键，`page-blur` 也不是 `material-*`。
5. 本记录 `:86`/`:87` 是两条重复的“页面/档位存储”行，均含 `"up"`，且一条有“页面模糊 true”、一条没有；应合并为当前口径一行（默认 30 / 页面模糊 true / 8 / 2 / 8，无 direction）。

### 23.2 过期的当前行为描述

6. 本记录 `:131` 仍把 `tooltip` 列为面板候选；当前产品明确 tooltip 不是候选、不材质化、不改写 `--dsw-alias-tooltip-bg`。
7. 本记录 `:133` 写“page 30、panel 100、alpha step 8、blur step 2、max blur 8、direction up”，并称页面实际 blur 0（alpha-only）；这是 t3 当时口径。当前为 panel 60、页面模糊默认开启（页面根 `::before blur(2.4px)`）、无 direction，应标为历史或改写。
8. 本记录 `:134` 的“四个 `beauticode-material-*` 键名”同样应为三个；`:138` 说公开 API“命名、返回值和语义保持”，但 `getMaterial()` 已不含 direction，措辞应收紧为“除 direction 外保持”。
9. ADR `:3`、`:21`、`:30` 等历史说明仍出现 alpha-only/实验；这些位置已明确标为历史，**可保留**；但当前仍有效的 `:332`/`:357`/`:370`/`:575`/`:717` 是“旧键忽略”的兼容说明，按语义不算配置残留。

### 23.3 夹具与测试数字

10. 本记录 `:150`（§5.2）仍说 `test/fixtures/*.mjs`、`backdrop-model.html` 是未跟踪文件；`:195`（V7）、`:240`（§11）、`:284`、`:398`、`:405`、`:486`、`:536`、`:551`、`:641`、`:692` 重复同一旧话术。实际 `git status` 显示三个 fixture 均已跟踪，只有 `.agent-teams/` 未跟踪；`:979`/`:980` 与 `:845`/`:938` 已写“已纳入、无未跟踪 fixture”。这组内容是同一文档内的直接矛盾，必须把旧段落标为历史或改为 V7 已关闭。
11. 本记录 §11 `:232`/`:237`/`:240` 是 t4 验收表，仍用 console 39/39、全量 140/140、“未暂存（见 V7）”；最终为 console 49/49、全量 150/150、fixtures 已跟踪。§11 没有“历史”标记，读者会把它当当前验收；应加“t4 当时”限定或更新。
12. 本记录 §19 `:732`/`:735`/`:779` 仍写 console 48/48、全量 149/149；这是 t19 当时数字，最终为 49/49、150/150。§19 标题也未标历史，应标注“t19 当时，最终见 §21/§22”，或更新数字。当前 §21/§22、README `:31`、docs `:72` 均为 150/150、49/49，代码未再变。

### 23.4 交叉引用与历史标记

13. 记录顶部 `:10` 仍写“§20 为 t20 文档同步/最终集成记录”；§20 标题已标“历史：方向移除之前”，当前最终记录是 §21/§22，应改为 §21/§22。
14. `:198`、`:235`、`:290`、`:346` 的“最新见/以 §19/§20 为准”把 §20（历史）当当前；`:246` 的“最新见 §17/§18”两节都是历史；`:353` 的“最新以 §13/§14 为准”两节也都是历史。应统一指向 §19（t19 行为复验）/§21（方向移除）/§22（文档同步），或明确写“当时最新”。
15. `:476` 说“当前产品默认仍是 §16 的 alpha-only”，`:555` 说“当前产品默认仍是 §16 的 alpha-only，但新增默认关闭的实验开关”；这两句与当前“页面模糊默认开启、无实验开关”直接冲突，不能因为所在节是历史就保留“当前”断言，应改为“当时”。
16. 链接与编号：`.tmp/t25-link-check.mjs` 解析 docs 6 条、README 2 条、ADR 7 条、本记录 13 条相对链接/锚点，`broken` 均为空；章节 1–22 连续，§13–§18、§20 已标历史，§19/§21/§22 为当前；未发现死链/错锚点。

### 23.5 代码审查与 ADR 差异

- `readability.js`：`DEFAULTS` 为 `{page:30,pageBlur:true,panel:60,alphaStep:8,blurStep:2,maxBlur:8}`；`getMaterial()` 返回 `{alphaStep,blurStep,maxBlur}`；`beauticode-material-direction` 不在 `storageKeys`，旧值不读不写；`getPageBlur()` 默认 true，只有字面 `"false"` 关闭；页面根 30%、`::before 2.4px`，面板 60%/3.69px；页内标准 role 为 panel root 60%、无 blur；tooltip 不进入候选；浮层可见时 `data-bc-page-blur-paused` 暂停页面模糊。与 ADR 当前口径一致。
- `console.js`：页面材质 60 行外的高级设置只有 alpha-step/blur-step/max-blur，无 direction 行/键/API 字段；面板默认 60、页面模糊默认开；页面 0% 禁用页面模糊并保留偏好；滑杆通过 `BeauticodeReadableSurfaces` 立即生效。与 ADR 当前口径一致。
- 未发现 `client.js` 双重叠加：页面根只加 30% 填充，面板根局部改写 token；`client.js` 的 body token/壁纸/磨砂仍是下层宿主，未改 `client.js`。ADR 的“页面根不改写 8 token、面板根局部改写”与代码一致。
- 与 ADR 的差异均集中在**文档残留**（方向、`"up"`、四个键、旧数字），不是产品代码或 ADR 的当前设计；ADR 的当前条款（page30/panel60/pageBlur on/tooltip 例外/暂停/V9–V16 状态）与代码一致。

### 23.6 命令、结果与跳过

| 命令/检查 | 结果 |
|---|---|
| `node --check` readability/client/console | 3/3 exit 0 |
| `node --test integrations/deepseek-harness/test/readability.test.mjs integrations/deepseek-harness/test/console.test.mjs` | **70/70 pass**（21 + 49），0 fail，0 skip |
| 全量 harness（`BEAUTICODE_PLAYWRIGHT_MODULE=.tmp/pw-runtime/...`、`BEAUTICODE_BROWSER_CHANNEL=msedge`） | **150/150 pass**，0 fail，0 skip（含 15 浏览器材质 + 3 background） |
| `.tmp/t25-link-check.mjs` | 4 个文件共 28 条链接/锚点，`broken: []` |
| `git diff --check` | 干净；仅 `core.autocrlf` 的 LF→CRLF 警告 |
| `git status --short` | 4 份文档 + 6 个产品/测试文件已修改；三个 fixture 已跟踪；仅 `?? .agent-teams/` |

**跳过项：无。** 浏览器用例未跳过，已包含在全量 150/150 中。真实 DSH 现场仍未验证（本机运行上一版候选、无渲染器 DOM），不能把 150/150 当作现场通过；这是既有环境限制，不是本轮文档检查的跳过。

### 23.7 建议给 Lead 的处理顺序

1. 先修 `docs/deepseek-harness.md:28`、ADR `:169`/`:377`/`:529`/`:572`/`:573`/`:642`（方向、`"up"`、三个键）。
2. 再修本记录 §2 `:86`/`:87`、§5.1 `:131`/`:133`/`:134`/`:138`、§5.2 `:150` 与所有夹具“未跟踪”旧话术（标历史或改为已跟踪）。
3. 把 §11 t4 数字、§19 t19 数字标为当时快照；修正 `:10`、`:198`、`:235`、`:246`、`:290`、`:346`、`:353`、`:476`、`:555` 的“最新/当前”指向。
4. 重跑 `.tmp/t25-link-check.mjs` 与上述测试；确认 README 旧键兼容说明是否保留（若发布门禁要求字面零出现，需删除/改写该句）。
5. 文档修复后由 Lead 打包安装并在真实 DSH 现场确认；在修完前不应按当前工作树直接提交。

剩余风险：V9/V10 默认仍存在（暂停时消除）、V11 滚动底部失模糊、V13 宿主 `::before` 覆盖、V14 关闭模糊时后景文字透出、V16 常驻页内控件可能长期触发暂停；真实 DSH 未现场验证；旧方向键的兼容说明与“字面零出现”门禁存在口径差异。

## 24. t26 文档一致性修复（2026-11-10）

范围：只改 `docs/deepseek-harness.md`、`integrations/deepseek-harness/README.zh-CN.md`、`docs/adr/0011-dsh-layered-material.md` 与本验证记录；未改产品代码，未改测试。目标是修掉 §23 列出的文档残留，让四份文档与当前代码（page30 / pageBlur true / panel60 / alphaStep8 / blurStep2 / maxBlur8；`getMaterial()` 三字段；无 direction 键/UI/API；tooltip 不是候选；页内浮层暂停）一致。

### 24.1 逐文件修复

| 文件 | 修复 |
|---|---|
| `docs/deepseek-harness.md` | `:28` 的“alpha 增加/减少多少”改为“alpha 增加多少（只增不减、越上层越实）”；默认值表其余项无需改动。 |
| `README.zh-CN.md` | `:21` 明确旧 `beauticode-material-direction` **不读不写**，旧值保留但忽略；页面/面板默认值、页面模糊、tooltip/暂停、测试数字与链接保持不变。 |
| `docs/adr/0011-dsh-layered-material.md` | `:169` “递增/递减”改为“逐级递增（越上层越实）”；`:373` 改为“除 `getMaterial()` 不再含 direction 外，既有形状不变；`getMaterial()` 只返回三字段”；`:377`/`:529`/`:572`/`:573` 删除 `"up"` 与方向语义；`:642` 改为“旧版忽略 `beauticode-page-material`、`beauticode-page-blur` 与三个 `beauticode-material-*` 键”；`:528` 旧 `beauticode-readable-surfaces` 的 `"true"`/无效值默认由 100 修正为 60。 |
| 本验证记录 | 顶部交叉引用改为“§20 历史、§21 方向移除、§22 t24 文档同步、§23 t25 检查、§24 t26 修复”；§2 合并两条重复存储行并去掉 `"up"`；§5.1 移除 tooltip 候选、更新 page30/panel60/8/2/8、页面模糊默认开、面板 3.69、API 三字段与三个高级键；§5.2 与 §8 的 V7 改为已关闭/已跟踪；§11 标为 t4 当时快照并注明最终数字与已跟踪；所有“最新见 §17/§18、§19/§20、§13/§14”改为当时/当前指向；§19 标为 t19 当时并保留其 48/48、149/149 快照，另注最终 console49/49、全量150/150。 |

### 24.2 验证

| 命令/检查 | 结果 |
|---|---|
| `node --check integrations/deepseek-harness/readability.js`、`client.js`、`console.js` | 3/3 exit 0 |
| `node --test integrations/deepseek-harness/test/readability.test.mjs integrations/deepseek-harness/test/console.test.mjs` | **70/70 pass**（21 + 49），0 fail，0 skip |
| 全量 harness（`BEAUTICODE_PLAYWRIGHT_MODULE=file:///E:/Projects/dsh/beautiCode/.tmp/pw-runtime/node_modules/playwright-core/index.mjs`、`BEAUTICODE_BROWSER_CHANNEL=msedge`） | **150/150 pass**，0 fail，0 skip（含浏览器材质 15 项与 background 3 项） |
| `.tmp/t25-link-check.mjs` | 见 §24.3；修复后重跑，`broken: []` |
| `git diff --check` | 无空白错误；`core.autocrlf` 的 LF→CRLF 警告属环境提示 |

### 24.3 链接与残留检查

- 相对链接/锚点检查覆盖 4 个文件，修复后仍是 28 条链接，`broken` 为空；新增 §24 标题不引入新的链接目标。
- 方向旧词（`"up"`、“增加/减少”“递增/递减”“四个 `beauticode-material-*` 键”）现在只作为历史/修复说明出现在 §3、§23 与本节；用户文档、ADR 当前条款与 §24 最终状态均已统一为“固定递增、越上层越实”，不再提供方向配置。所有“未跟踪”表述都已限定为历史并注明后续已跟踪，当前状态为无未跟踪 fixture。
- README 保留旧方向键的兼容说明，但明确“不读不写”；如果发布门禁要求 `beauticode-material-direction` 字面零出现，应删除该兼容句，而不是声称它仍可配置。

**边界**：本轮是文档一致性修复，不是真实 DSH 现场验证；上述 150/150 只证明 harness/fixture 与本地浏览器联动通过，不能替代真实 DSH 打包安装后的现场确认。


# DSH 分层材质独立验证（t4）

- 日期：2026-11-10
- 角色：verifier（t4，attempt `17116485-da2b-4004-815e-0ef1ee6d75b9`）
- 基线：`main` `71b641b` + 本轮未提交变更（`readability.js`、`console.js`、三份测试、`docs/adr/0011-dsh-layered-material.md`、`test/fixtures/`）
- 范围：ADR 0011 的两通道材质、材质档位、readability 材质根重写、console 联动、夹具与真实 DSH 现场条件；本记录不修改产品代码。
- 结论（t4 当时）：**除 V3（页面根内 fixed 包含块偏移）外，可自动化的产品行为通过**。语法、单元、控制台、真实 Edge 浏览器与全量 harness 均通过（最终 140/140，0 skip）；console 滑杆 → 真实 `readability.js` → DOM 的同窗口立即联动已在真实 Edge 中直接验证。
- t4 后历史：t8 曾用页面同根 `::before` 背板关闭 V3（fixed 60/60、portal 40/40），但背板依赖 `position:relative`/`isolation`/absolute 层，暴露 V9/V10/V11；t9 复验的是该历史形态。
- **当前默认形态（t10/t11）**：页面回退 **alpha-only**（30% 底色，无页面 `backdrop-filter`/`::before` 背板/`position`/`isolation`）；面板 blur 仍 3.69px；`getPageBlur=false`、`getBlur().page=0`、panel=3.69。默认形态下 V3/V9/V10/V11/V12/V13 不出现；V14（30% alpha 不能消除后方文字透出）开放；V15 默认消失（默认页面无 blur 标记/变量）。
- **可选实验（t13/t14，默认关闭）**：「页面模糊（实验）」通过 `beauticode-page-blur`/`getPageBlur`/`setPageBlur`/控制台高级设置开启；开启后恢复 v1 `::before` 背板 blur 2.4px，fixed 仍 60/60、portal 40/40，但 V9 absolute 250、V10 high-outside、V11 滚动底部 delta 1 重新出现；不推荐默认，开启后必须重新现场验收。详见 §17；§18 为 t16 文档同步与最终集成记录。
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
| 页面默认 30% | `[data-global-panel]` root=page、level 1、depth 1、alpha .30、无页面 filter/背板 | root=page，computed alpha **77/255 ≈ 30%**；`backdrop-filter:none`、`filter:none`、`position:static`、`isolation:auto`，无 `::before`；`getPageBlur=false`、`getBlur().page=0`、panel=3.69；无 blur 标记/变量（t13 后默认） | B、C、§15/§17 |
| 主会话无页面 | 无 page root；composer/待交互卡片 panel 100%、blur 2px | 页面 root 数 0；composer、三张卡片 `blur(2px)`、alpha 255 | B（15 项中的会话用例） |
| 独立面板默认 | panel root、level 2、alpha 1、blur 3.69px | dialog alpha 255，`blur(3.69px)`，level 2/depth 1 | B、C |
| 页面根内嵌套 | 无 backdrop-filter；alpha 按步长 .38 | page nested listbox alpha **97/255 = .38**，`backdrop-filter: none`，无 `data-bc-material-blur` | B、C |
| 面板根内嵌套 | 无 backdrop-filter；panel alpha 夹取 1 | dialog listbox alpha 255，`backdrop-filter: none`；计算 `--bc-material-blur` 从父级继承为 3.69px，但**不应用 filter**（见 §8 V1） | B、C |
| 方向 down | 页面嵌套 .22；面板嵌套 .92 | 页面嵌套 56/255=.22；面板嵌套 235/255=.92；均无 filter | B、C |
| 页面 100% | 页面 alpha 1、无 filter；面板无 filter | page root alpha 1、`backdrop-filter:none`；dialog root 仍存在但无 filter/无 blur 属性 | B、C、§15 |
| `maxBlur=0` | 所有层无 filter；页面 alpha 保留 | page alpha .30、根无 filter、无背板；dialog 无 filter；无 position/isolation | B、C、§15 |
| `blurStep=0` | 页面 alpha .30、无 filter；面板无 filter | page alpha .30、无 filter；dialog 无 filter | B、C、§15 |
| 页面 0% | 页面无标记/无 filter；面板按 I=0 → 2px | page root/layer 标记清零、alpha 0；dialog `blur(2px)` | B、C、§15 |
| 面板 0% | 页面 alpha .30、无 filter 保留；role 面板回退宿主半透明 | page root 保留、无 filter；dialog 无标记，alpha 82/255（宿主半透明），composer 同样回退 | B、C、§15 |
| 两者 0% | 无材质标记/变量，回到宿主外观 | `data-bc-material-root`/`layer` 数 0；composer/dialog 的 background/backdrop/alpha 与未注入 readability 的 baseline 完全一致 | B、C |
| `[data-shell-overlay]` | 容器不标记；内部 role 仍独立 | 容器 0 alpha、无标记/无 filter；内部 dialog root=panel、`blur(3.69px)` | B、C |
| 无 role 第三方浮层 | 不标记、不改背景 | 无 root/layer，背景保持 `rgba(0,0,0,.5)`，`backdrop-filter: none` | B、C |
| 页面根外 fixed 下拉 | 开关页面材质前后坐标不变 | portal fixed：开/关均 `(40,40)` | B、C |
| 页面根内 fixed 下拉 | 最终应与关闭材质一致 | **t4 时曾偏移 60→300**；t8 背板后 t9 为 `(60,60)`；t10 alpha-only 后 t11 仍为 `(60,60)`，portal `(40,40)`；V3 关闭 | B、C、§13/§15 |
| 页面内 absolute / 层叠 / 滚动 | 与关闭材质一致；无背板可丢 | absolute 开/关 `(10,12)`；高 z-index 开/关 `high-inside`；`scrollTop=36` 后底部 fill delta 47/67；V9/V10/V11 默认关闭 | B、C、§15/§17 |
| 页面模糊实验（默认关闭） | `getPageBlur=false`、`getBlur().page=0`、无 flag/伪元素 | 无 `data-bc-page-blur`；页面 static/auto；fixed/portal/absolute/stacking 与默认一致；控制台「已关」 | C、§17.1 |
| 页面模糊实验（开启） | flag true、relative/isolate、::before 2.4、fixed 60/60 | alpha 77/255、`getBlur().page=2.4`、`::before blur(2.4px)`；V9 absolute 250、V10 high-outside、V11 滚动底部 delta 1；panel 3.69 不变 | C、§17.2 |
| 实验关闭 / 页面 0% | 移除 flag/背板/定位；存储保留 | 关闭后 static/auto/no pseudo、`getBlur().page=0`；页面 0% 时 flag/根移除、存储仍 true、控制台按钮/重置 disabled、hint 可见，恢复 30% 后背板恢复 | C、§17.3 |
| V14 后景文字透出 | 30% alpha 只能减弱；实验 blur 也不宣称解决 | 高对比后景文字对比度 21:1 → **10.68:1**，仍可见；不能消除重叠，产品取舍开放 | C、§15.3/§17.4 |
| 旧面板偏好 | `"true"`→100、`"false"`→0、数字夹取、无效→100；0 写 `"false"` | 单元测试全覆盖；浏览器 40% alpha 102、0% 回宿主 | U、B |
| 页面/档位存储 | 默认 30 / 8 / 2 / 8 / `"up"`；无效回落；夹取 | 单元与控制台测试通过；控制台滑杆实际写入见 §3 | U、I |

## 3. t3 依赖的 API 与同窗口立即联动

`readability.js` 保留并冻结以下公开面（名称、形状、语义均与 console 的消费一致）：

| 成员 | 形状 / 语义 | 验证 |
|---|---|---|
| `BeauticodeReadableSurfaces.get()` | 面板强度 0–100（数字） | U、I |
| `set(number \| boolean)` | 返回面板强度；0 写 `"false"` 以兼容旧版 | U、I |
| `getPage()` / `setPage(number)` | 页面强度 0–100；0 写新键 `"0"`；缺失键回落 30 | U、I |
| `getMaterial()` | `{alphaStep, blurStep, maxBlur, direction}` | U、I |
| `setMaterial(patch)` | 部分更新、夹取/归一化、立即 apply | U、I |
| `defaults` / `storageKeys` / `getBlur()` / `refresh()` | 只读辅助 / 半径快照 / 同步重扫 | U、B |

**真实浏览器联动证据**（`.tmp/t4-console-integration.mjs`）：同一页面先加载真实 `readability.js`，再加载真实 `console.js`；`console` 自动挂载“背景”页，测试直接设置滑杆 value 并派发 `input`，在同一个 `Runtime.evaluate` 调用内读取 DOM（没有等待 storage 事件，也没有跨窗口）：

| 操作 | 同一次求值内观察到的结果 |
|---|---|
| 页面材质 30 → 60 | page alpha **153/255（.60）**，`blur(4.8px)`；dialog 半径同步为 **4.82px**；label `60%`；localStorage `beauticode-page-material="60"` |
| 面板滑杆 100 → 40 | dialog alpha **102/255（.40）**；页面 alpha 仍 .60，未被面板滑杆重置；label `40%`；旧键 `"40"` |
| 材质档位（透明度）8 → 20 | 页面嵌套层 alpha **204/255（.80）**，无 filter；label `20%`；存储 `"20"` |
| 方向切换（越上层越透） | 同一嵌套层 alpha **102/255（.40）**；label 变为“越上层越透”；存储 `"down"` |
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

- **锚点/候选集合**：页面只认 `[data-global-panel]`；面板只认 dialog/alertdialog/menu/listbox/tooltip、`[data-composer-card]` 和三类待交互卡片内层；不使用构建类名；`[data-shell-overlay]` 容器跳过、内部 role 仍处理；无 role 浮层不处理；`#beauticode-*` 自身 UI 跳过。与 ADR §3.1 一致。
- **分层与属性**：page root level 1/depth 1；独立 panel root level 2/depth 1；嵌套层 level/depth +1；只有 root 写 `data-bc-material-blur="on"`，嵌套层只写 alpha；嵌套层无 `backdrop-filter`。与 ADR §3.2 一致。
- **默认值与模糊模型**：page 30、panel 100、alpha step 8、blur step 2、max blur 8、direction up；`I = page/100×maxBlur`，`T2 = min(M, I+B)`，`s2 = sqrt(T2²−I²)`；模型 2.4 / 3.69px，但页面实际 blur **0**（alpha-only），面板 3.69px；页面 0/主会话面板 2px，页面 100 面板 0，`maxBlur=0`/`blurStep=0` 无多余 filter。与 ADR §3.4/§5.6 一致。
- **存储与迁移**：`beauticode-page-material`、`beauticode-readable-surfaces`、四个 `beauticode-material-*` 键名、默认值、夹取、四舍五入、无效回落；旧 `"true"`/`"false"` 兼容；面板 0 仍写 `"false"`；页面 0 写 `"0"`。与 ADR §3.3 一致。
- **0% 回退**：页面 0 只移除页面通道；面板 0 只移除面板通道；两者 0 无标记/内联变量/filter；实际 computed 与未注入 readability 的宿主 baseline 一致（Console+Edge 均验证）。与 ADR §3.3 一致。
- **查询/重扫**：MutationObserver 以 rAF/setTimeout 节流，忽略自身 `data-bc-material-*`/`style` 写入；先清 stale 再重算；角色变化、节点移除、页面根替换均幂等；重复加载不重复注入样式。与 ADR §5.1 一致。
- **CSS 形状**：旧全局 `:is([role=...])` 规则已删除；页面根只加 fill，不改写 8 个 surface token；panel root 与嵌套层才改写 8 token；页面根显式 `backdrop-filter:none`，默认 alpha-only（无 `position`/`isolation`/`::before` 背板）；面板根直接持有 filter。t13 新增的实验规则只在 `html[data-bc-page-blur="true"]` + 页面根 blur 标记同时存在时启用 `position:relative`/`isolation:isolate`/`::before`，默认不匹配。与 ADR §3.2/§4.1/§3.5 一致，未发现与 `client.js` 的双重叠加（`client.js` 未改，body token/壁纸/磨砂作为下层宿主）。
- **公开 API**：`get/set/getPage/setPage/getMaterial/setMaterial` 的命名、返回值和语义保持；另有 `defaults/storageKeys/getBlur/refresh`。console 消费路径见 §3。
- **夹具**：`test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html` 已放入 `test/fixtures/`（未再依赖 `.tmp`）；嵌套、shell.overlay、无 role、fixed 下拉、会话模式均有 fixture。`backdrop-model.html` 是可手工打开的静态复现（见 §6/§8 V6）。

### 5.2 差异与低风险观察

| 观察 | 说明 | 严重度 |
|---|---|---|
| 纯空白存储值 | `readability.js` 的 `readNumber`/`readPanelStrength` 对 `" "` 会 `Number(" ") → 0`，即页面/面板/档位被当作 0；console 的 `readStoredNumber` 会 trim 后回落默认。ADR 说“无效值回退默认”，两者不一致。仅手工破坏 localStorage 时可见。建议读取时先 `String(raw).trim()`，并补 `" "` 用例。 | 低 |
| 0% 时 `--bc-page-material-strength` | 真实 API 路径保留变量值 `"0"`（供调试）；console 独立回退路径移除该变量。CSS 不依赖它，无用户可见差异，但两条路径行为不完全一致。 | 信息 |
| 主会话的 `data-bc-page-material` | 默认 page=30 时，即使没有 `[data-global-panel]`，`html` 仍带 `data-bc-page-material="true"`；没有页面锚点所以不产生页面材质，插件页辅助也不在主会话匹配。与 ADR 的“页面强度 > 0 时存在”一致，但读属性的人容易误解。 | 信息 |
| `isVisuallyCovering` | 只有宽高**同时**为 0 才判定不可见；单维为 0 仍会标记。真实页面列不会出现单维 0，未构成失败。 | 低 |
| 版本号 | t5 已把 ADR 改为「本机官方 Desktop 包 `0.2.2-rc.1`（运行时版本文件 `44.7.0`）」；`data-global-panel`/`data-shell-overlay` 源码片段在本机包内逐字存在，锚点契约一致，但仍**不能声称与 ADR 是同一构建**。 | 信息（已同步） |
| 夹具未暂存 | `test/fixtures/*.mjs`、`backdrop-model.html` 当前为 `git status` 的未跟踪文件；交付提交时必须一并纳入，否则浏览器用例在干净检出中失败。 | 交付提示 |

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
  - 默认页面 alpha-only 在真实 DSH 中的效果：V14 后方文字仍可能透出（30% 只能减弱），默认无 blur 标记/变量、`getBlur().page=0`；V3/V9–V13 默认关闭；
  - 可选实验「页面模糊（实验）」开启后的 V9 absolute 包含块、V10 isolation 层叠、V11 滚动底部失模糊；fixed 预期仍 60/60，但必须现场复核；
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
| V7 | 交付 | 开放 | `test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html` 当前未跟踪；提交时必须纳入。 |
| V8 | 信息 | 开放 | 本机真实 DSH 运行旧插件（`1.0.28`/HEAD），新材质未在该应用生效；真实现场项未验证。 |

> 状态更新（t10/t11/t13/t15）：默认页面 alpha-only，V3/V9/V10/V11/V12/V13 不出现；V14（30% alpha 仍透出后方文字）开放；V15 默认消失（无 blur 标记/变量、`getBlur().page=0`）。t13/t14 另加默认关闭的「页面模糊（实验）」；开启后会重新出现 V9/V10/V11（fixed 仍 60/60），见 §17/§18。§13 的背板结论是历史。

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

## 11. 验收对照

| t4 要求 | 状态 | 证据 |
|---|---|---|
| 语法 + 单元 | 通过 | `node --check` ×3；21/21、39/39 |
| 浏览器测试（Playwright 可用） | 通过 | t6 后 15/15，0 skip；全量 140/140 |
| 页面/会话/面板/嵌套/独立覆盖/shell.overlay/0% 行为 | 通过（真实 Chromium fixture） | §2 矩阵、§6 Edge CDP |
| 页面内 fixed / absolute / 层叠 / 滚动 | 默认通过；实验开关注明风险（真实 DSH 未验证） | 默认 t10/t11：fixed 60/60、portal 40/40、absolute 10/12、层叠 high-inside、滚动 fill 覆盖；V3/V9–V13 默认关闭。实验开启 t15：fixed 60/60、portal 40/40，但 V9 absolute 250、V10 high-outside、V11 滚动 delta 1，必须现场复验。V14 开放 |
| t3 API 契约 + 同窗口立即联动 | 通过 | §3 真实浏览器 console+readability 联动 |
| console 39 项零回归 | 通过 | 39/39 |
| 端口竞争隔离 | 通过（未复现） | §4，32/32、140/140 |
| 与 ADR 一致性/存储/回退/旧偏好/双重叠加 | 通过（低风险观察见 §5.2） | §5 |
| 夹具内联或提交到 test/fixtures | 已放入（未暂存，见 V7） | §6 |
| 真实 DSH 现场 | 未能验证（环境限制） | §7；不得宣称现场通过 |
| 报告含命令/结果/跳过/差异/风险 | 通过 | 本文件 |

## 12. t7 修复后复跑（2026-11-10）

> 历史记录：本节的 V3 状态在 t8/t9 后改变，最终又被 t10 alpha-only 取代；最新状态见 §17/§18。此节保留 t7 当时的门禁与 fixed 证据。

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
| API | `getPage/setPage/getMaterial/setMaterial` 均存在且语义符合 §3；真实浏览器 console+readability 联动仍通过（页面 30→60 立即 .60/4.8px，面板 100→40 立即 .40，档位/方向/重置均立即生效） |

### 与 ADR 的差异 / 剩余风险

- **页面内 fixed 下拉仍是 V3**：t7 复跑的 fixed 用例 15 通过，但它断言的是**当前已知的包含块行为**：portal 在页面根外保持 `(40,40)`，页面根内 `x` 从关闭材质的 60 变为开启材质的 **300**（pageX 240 + 60）。这不是“不偏移”；ADR §4.1 的同根背板层回退在 t7 时尚未实现。t7 不修改产品代码；已由 Lead 建 t8（页面根同根背板层）修复，t9 在 t8 后独立复验（页面根无 backdrop-filter、背板 `blur(2.4px)`、页面内 fixed 坐标与关闭材质一致、portal fixed 稳定、15/15 0 skip、readability/console 全绿）；最终结果见 §13/§14。
- V4（多个独立浮层共用 `s2`）、V5（纯空白存储值）、V6（`backdrop-model.html` 未进 CI）、V7（fixtures 未暂存）状态不变，仍见 §8。
- 真实 DSH 现场仍未验证（运行旧插件且无渲染器 DOM，见 §7）；t5 文档应等待 t9 完成后再开始。
- 文件哈希与 t4 记录一致（产品代码未因 t6/t7 改动）：`readability.js` `DD3578…C4A51`、`console.js` `BA63E8…B44808`、`plugin-readability.browser.test.mjs` `48D713…96C1`。

## 13. t9 背板层修复复验（2026-11-10，历史）

> 历史记录：t10 已因 V9/V10/V11 回退页面 alpha-only，t11 复验；本节的页面背板/position/isolation/V9–V13 状态不再是最终形态。最新见 §17/§18。

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

> 历史快照：t5 当时把 t8 `::before` 背板写成最终形态，并称 V9–V13 开放。t10 已回退页面 alpha-only、t11 复验；t12 更新 alpha-only 文档并新增 §16，t16 再追加实验项 §18。最新以 §17/§18 为准。

t5 只改文档，**未改产品代码**。同步内容：

- [ADR 0011](../adr/0011-dsh-layered-material.md)：补充 t8 页面同根 `::before` 背板的最终实现、V3 关闭、V9–V13 开放残留、版本说明（本机包 `0.2.2-rc.1`，运行时版本文件 `44.7.0`）、与本文的互相链接；验收矩阵改为「页面根无 filter、背板承载 2.4/8px」。
- [docs/deepseek-harness.md](../deepseek-harness.md)：新增「分层材质与设置」一节，写入页面 30% / 面板 100% 两条独立滑杆、高级档位、`[data-global-panel]` 与标准 role 锚点、嵌套只 alpha、shell.overlay 容器跳过、无 role 边界、0% 与旧键兼容、V3 关闭与 V9–V13 风险、自动化结果与链接。
- [integrations/deepseek-harness/README.zh-CN.md](../../integrations/deepseek-harness/README.zh-CN.md)：替换「插件页完全透明、只有面板强度」的旧段落，改为两条材质通道、页面背板、0% 回退、风险与验证链接。
- 本文：更新顶部结论、页面默认行为矩阵、V3 行、验收对照与真实 DSH 未验证项；保留 t4/t7/t9 的历史段落，最新状态以 §13/§14 为准。

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
- ADR、验证记录与三个 fixture 当前未跟踪；**提交时必须纳入**（V7），否则干净检出的浏览器用例会失败。
- `git diff --check` 对文档无空白错误；仅 `core.autocrlf` 的 LF→CRLF 提示，不改变内容。

### 14.3 最终边界

- **V3 已关闭**：页面根自身无 `backdrop-filter`；页面内 fixed 开/关 `(60,60)`，portal `(40,40)`；背板 `blur(2.4px)`；页面 0% 时 `position`/`isolation`/伪元素一起移除。
- **V9–V13 开放**：absolute 包含块、isolation 层叠、滚动页面底部失模糊、`maxBlur=0` 仍保留 position/isolation、宿主 `::before` 覆盖；均需真实 DSH 现场复核，当前为低/中风险。
- **V4–V8 状态不变**：多独立浮层共用 `s2`、纯空白存储值差异、`backdrop-model.html` 未进 CI、fixtures 未暂存、真实 DSH 运行旧插件。
- **真实 DSH 未现场验证**：本机运行旧插件且无渲染器 DOM；上述 15/15、140/140 仅代表 Chromium/Edge fixture 与真实浏览器联动，不代表设置页/插件页/技能页/审批卡片/菜单/视频性能已在真实宿主通过。

## 15. t11 alpha-only 回退独立复验（2026-11-10）

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
- **文档同步**：§14 是 t5 在 t10 之前写的文档快照，仍按 t8「页面根无 filter + `::before` 背板」描述，并称 V9–V13 开放；与当前 alpha-only 产品不符。t12 已完成 ADR、docs/deepseek-harness.md、README 与本文的同步：页面 alpha-only（30%，无页面 blur），V3/V9/V10/V11/V12/V13 关闭，V14（30% 不能消除后景文字重叠）作为产品取舍开放，并说明 `getBlur().page` 只是模型尺度；见 §16。
- t10 后文件哈希（t11 未改产品代码）：`readability.js` `2633D291…A1007F`、`console.js` `BA63E8C9…B44808`（未变）、`plugin-readability.browser.test.mjs` `9A08F9B6…B617D555`。

## 16. t12 文档同步与集成记录（2026-11-10，历史：实验开关之前）

> 历史快照：t16 已在 §18 追加「页面模糊（实验）」默认关闭、API/控制台、V9–V13 实验风险与最新测试。§16 的 alpha-only 描述仍是默认形态，但不再包含实验项，不能当作完整最终文档。

t12 只改文档，**未改产品代码**。把 t5 及 ADR/README 中「页面根无 filter + 同根 `::before` 背板为最终实现、V9–V13 开放」的过期描述，改为 t10/t11 的当前默认形态：

- **页面通道 alpha-only**：30% 底色；`backdrop-filter:none`、`filter:none`、`position:static`、`isolation:auto`，无 `::before` 背板；页面实际模糊 0。`getBlur().page = 2.4` 只是面板 sqrt 模型的尺度。
- **面板 blur 不变**：默认 3.69px；主会话/页面 0% 时 2px；嵌套层仍只做 alpha、无 filter。
- **V3/V9/V10/V11/V12/V13 全部关闭**：由移除页面 filter/背板/`position`/`isolation` 关闭；fixed 60/60、portal 40/40、absolute 10/12、层叠 high-inside、滚动 fill 覆盖底部。
- **V14 开放（产品取舍）**：30% alpha 把高对比后景文字对比度从 21:1 降到约 10.68:1，仍可见；30% 只能减弱、不能消除后方文字透出。若最初问题是会话/背景文字在页面后明显重叠，alpha-only 30% 不足，需 Lead/产品确认。
- **V15 低语义观察**：页面根仍可能带 `data-bc-material-blur="on"` 与 inline `--bc-material-blur:2.4px`，但 CSS 显式 `none`；不能当作页面实际模糊。
- **真实 DSH 仍未现场验证**：本机运行旧插件且无渲染器 DOM；15/15、140/140 只代表 Chromium/Edge fixture 与真实浏览器联动，不代表设置页/插件页/技能页/审批卡片/菜单/视频性能已在真实宿主通过。V14 是否满足最初产品目标也需现场/产品确认。
- **V7 交付提醒**：`integrations/deepseek-harness/test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html` 仍未被 git 跟踪，提交时必须纳入，否则干净检出的浏览器用例会失败。

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
- ADR、验证记录与三个 fixture 当前未跟踪；**提交时必须纳入**（V7）。
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
| V4–V8 | 状态不变 | 多独立浮层共用 `s2`、纯空白存储值差异、backdrop-model 未进 CI、fixtures 未跟踪、真实 DSH 运行旧插件。 |

真实 DSH 未现场验证；本表只针对 Chromium/Edge fixture 与真实浏览器联动。

> §16 是 t12 在 t13/t14 加入「页面模糊（实验）」**之前**的 alpha-only 文档快照；当前产品默认仍是 §16 的 alpha-only，但新增了默认关闭的实验开关。最新复验与实验边界见 §17；ADR/README/docs 需要 t12 追加实验说明，不能把 §16 当作完整最终文档。

## 17. t15 实验页面模糊独立复验（2026-11-10）

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
| 结论 | 默认路径仍是 t10 alpha-only；V3/V9/V10/V11/V12/V13 均不出现 |

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

- **默认仍是 alpha-only**：t13/t14 的实验项默认关闭；V3/V9/V10/V11/V12/V13 在默认路径保持关闭；V15（页面 blur 标记/模型语义）在默认路径也消失（页面根无 blur 标记、`getBlur().page=0`）。
- **实验开启时有意复现已知风险**：V9 absolute 包含块（250）、V10 isolation 层叠（high-outside）、V11 滚动底部失模糊（delta 1）；V3 fixed 仍 60，不重新引入原 fixed 偏移。UI 文案与注释已标「实验、默认关闭、仅建议现场试验」，这些是 opt-in 的已知行为，不作为默认回归；建议 Lead/产品决定是否保留该实验入口。
- **V14 仍未关闭（产品取舍）**：t13/t14 的实验 blur 可以在开启时提供页面模糊，但默认关闭；默认 alpha-only 30% 仍不能消除后方文字透出（t11：21:1→10.68:1）。
- **文档同步**：t16 已在 §18 追加「页面模糊（实验）」默认关闭、`beauticode-page-blur`、`getPageBlur/setPageBlur`、控制台行、V9–V13 实验风险与最新测试；ADR/docs/README 已同步，保留 V14 与真实 DSH 未验证边界。
- 真实 DSH 仍未现场验证；15/15、21/21、48/48、149/149 只代表 Edge fixture 与真实浏览器联动。
- t13/t14 后文件哈希：`readability.js` `D71DA27D…B3E3B9`、`console.js` `D1991C4D…394A182`、`plugin-readability.browser.test.mjs` `A9CC067E…6376C58`。

## 18. t16 文档同步与最终集成记录（2026-11-10）

t16 只改文档，**未改产品代码**。在 t12 的 alpha-only 文档上追加 t13/t14/t15 的「页面模糊（实验）」：

- **默认形态不变**：页面 alpha-only 30%，无 `backdrop-filter`/背板/`position`/`isolation`；`getPageBlur=false`、`getBlur().page=0`、panel=3.69；V3/V9/V10/V11/V12/V13 默认不出现；V14 开放；V15 默认消失（无 blur 标记/变量）。
- **实验项默认关闭、不推荐**：控制台「高级设置 → 页面模糊（实验）」默认「已关」；存储 `beauticode-page-blur`（仅字面 `"true"` 开启）；API `getPageBlur()`/`setPageBlur(boolean)`；文案「默认关闭；开启后会启用页面背板，可能影响页面内 fixed/absolute/高层浮层；仅建议现场试验」。
- **开启后**：`html[data-bc-page-blur="true"]`、页面根 `position:relative`/`isolation:isolate`、`::before blur(2.4px)`、页面 alpha 77/255、`getBlur().page=2.4`；fixed 仍 60/60、portal 40/40（**不重新引入 V3 fixed 偏移**），但 V9 absolute 250、V10 high-outside、V11 滚动底部约 36px 失模糊（delta 1）；面板 blur 3.69 不变。开启后必须重新现场验收 V9–V13，不能把自动化结果当现场通过。
- **关闭 / 页面 0%**：关闭后存储 `"false"`、flag/背板/定位移除、`getBlur().page=0`、absolute/fixed/stacking 恢复；页面 0% 时 flag/页面根移除、存储仍 `"true"`、控制台按钮/重置 disabled、`.bc-row-hint`「需要页面材质 >0」可见、点击 no-op，恢复 30% 后背板自动恢复。
- **V14**：30% alpha 只能把高对比后景文字从 21:1 降到 10.68:1，不能消除后方文字透出；实验 blur 默认关闭，也不宣称解决 V14。
- **真实 DSH**：仍未现场验证；15/15、21/21、48/48、149/149 只代表 Chromium/Edge fixture 与真实浏览器联动，不代表设置页/插件页/技能页/审批卡片/菜单/视频性能或实验项已在真实宿主通过。实验项是否保留需用户/DSH 现场实测后决定。
- **V7**：`test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html` 仍未跟踪，提交必须纳入。

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
- ADR、验证记录与三个 fixture 当前未跟踪；**提交时必须纳入**（V7）。
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




# DeepSeek Harness 桥接插件

该 Cordis 插件向 DSH Web 和官方 Desktop 注入 beautiCode 浏览器客户端，并提供本机鉴权接口。支持图片、MP4 / MOV、播放位置、静音、摸鱼模式以及清除背景。Web 和 Desktop 使用同一组结构化页面注入；Desktop 的页面请求经原生壳转发，回执由每次 Host 启动生成的页面密钥验证。

DSH Web 和 Desktop 启动及普通点击不会自动进入全屏。需要全屏时，在「设置 → 背景 → 全屏显示」中主动开启，按 `Esc` 或点击「退出全屏」退出。

## 官方 Desktop

先启动 Desktop 一次，让它创建 `desktop` profile，然后从系统托盘明确退出（关闭窗口通常只会隐藏）。可在 Desktop 的插件页面安装 `beauticode-dsh`，或使用 **Desktop 安装的** `dsh` 命令：

```sh
dsh plugin --profile desktop add beauticode-dsh
```

要试当前仓库源码，可先在仓库根目录运行 `npm run plugin:pack`，再将上面命令的包名换成 `file:<仓库绝对路径>/artifacts/dsh-plugin`。

重新打开 Desktop，在「设置」中使用「背景」。Desktop 默认 Host 端口是 `19387`；如果还使用 beautiCode 托盘，将托盘的 `-DshUrl` 指向 `http://127.0.0.1:19387`（若 Desktop profile 改过 `webserver.config.port`，请使用实际端口）。Desktop 插件由 Desktop 自己管理；下方的 `npx beauticode-dsh` 安装器针对 Web profile。

## Web

「设置 → 背景」现在有两条独立材质通道。**页面材质**默认 30%，只作用于页面模式 MainPanel 布局列 `[data-global-panel]`（插件页、技能页、自动化任务等）；主会话没有该锚点，因此不铺页面材质。**页面模糊默认开启**：`html[data-bc-page-blur="true"]`、页面根 `position:relative`/`isolation:isolate`、`::before` `blur(2.4px)`；`getPageBlur()` 默认 true，`getBlur()` 默认 `{page:2.4, panel:3.69}`。**功能面板不透明**默认 **60%**（153/255），作用于 dialog / alertdialog / menu / listbox、消息编辑栏 `[data-composer-card]` 和提问/计划审核/授权确认卡片；已有 35 等保存值保留，重置写回 60。高级设置提供三个档位滑杆：材质档位间隔（透明度）默认 8%、材质档位间隔（模糊）默认 2px、最大模糊默认 8px；嵌套 alpha 固定递增（越上层越实），没有方向选项。旧 `beauticode-material-direction` 不读不写，旧值保留但忽略；`getMaterial()` 只返回 `{alphaStep,blurStep,maxBlur}`，`setMaterial({direction})` 静默忽略。面板根独立应用一次 `backdrop-filter`，默认页面下为 `blur(3.69px)`；嵌套层只按 alpha 档位变化、绝不加模糊；`[data-shell-overlay]`（`shell.overlay`）容器本身跳过，但其中标准 role 浮层仍按独立/嵌套处理；无标准 role 的第三方浮层不处理。

页面根内的标准 role 分两类：**tooltip 不再材质化**——不是候选、不加 alpha/层，也不改写 `--dsw-alias-tooltip-bg`，保留宿主黑底白字、背景和定位；**menu / listbox / dialog / alertdialog** 按面板材质 60% 处理、`backdrop-filter:none`，不继承 page alpha。页面根内出现可见 tooltip/menu/listbox/dialog/alertdialog 时，页面模糊**暂停**：页面根加 `data-bc-page-blur-paused`，移除 `position`/`isolation`/`::before`，仅保留 30% 底色，`getBlur().page=0`，面板 blur 3.69 不变；关闭浮层后自动恢复 `relative/isolate` 与 `blur(2.4px)`。暂停是为了消除这些页内浮层在 V9/V10 下的现场漂移，**不是把 V9/V10 永久解决**：没有页内浮层时，页面根仍有 V9 absolute 包含块（探测 250）和 V10 层叠（default-outside）。

**为什么侧栏和主会话不在页面材质内**：左侧栏是 DSH chrome，位于 `[data-global-panel]` 之外，半透明由 `client.js` 的 `--bc-surface-mix`（默认 36%，会话 active/settling 86%）与 `--dsw-specific-sidebar-fill` 决定，不随页面/面板强度滑杆或页面模糊变化；背景阴影/壁纸磨砂只改变透出的壁纸，不是侧栏自身材质。主会话没有 `[data-global-panel]`，页面材质/页面模糊不铺，保持壁纸直出；若未来要统一页面，应新增独立可选项，不应默认扩到主会话。

页面 0% 时移除页面根、30% 底色、页面模糊/背板与插件页辅助；`beauticode-page-blur` 偏好保留，恢复页面强度 > 0 后自动恢复模糊。面板 0% 只关闭面板材质。两者回到 `client.js` 发布的半透明宿主外观（不是未经 beautiCode 处理的 DSH 原生实色）。旧键 `beauticode-readable-surfaces`：缺失/`"true"` → 60、`"false"` → 0、数字原样保留（35 仍是 35）、无效 → 60；0 仍写 `"false"` 方便回滚。页面模糊键 `beauticode-page-blur` 仅字面 `"false"` 关闭。选择即时生效并跨同源窗口同步；清除背景后恢复宿主样式，偏好保留。需要回滚时把页面/面板强度调到 0%，或恢复旧插件版本。

需要知道的取舍与风险：30% 页面底色不是「任意壁纸都 ≥ 4.5:1」的保证；面板默认从 100% 降到 60%，会更明显地透出后景，设置页/添加插件弹窗在 35% 下已偏透，60% 是新的基线，用户可自行调高。**V3 fixed 已关闭**：页面内 fixed 开/关 `(60,60)`、portal `(40,40)`。**V9/V10 默认仍存在**：页面模糊开启且没有页内浮层时，absolute 250、页面内高 z-index `default-outside`；只有页内 tooltip/menu/listbox/dialog/alertdialog 可见触发暂停时才回到 absolute `(10,12)`、`high-inside`。**V11 仍开放**：页面列自身滚动时 absolute 背板底部一段失模糊（delta 1）；暂停不解决。**V13 仍开放**：页面 `::before` 可能被宿主/第三方占用。**V14 开放**：关闭页面模糊时 30% alpha 只能把高对比后景文字从 21:1 降到约 10.68:1，不能消除后方文字透出；开启模糊也不宣称完全解决。**V15 已闭合**。**V16 开放（低-中）**：暂停选择器覆盖任意可见页内 listbox/dialog 等，常驻控件可能让页面模糊一直暂停，需现场复核。真实 DSH 当前运行上一版候选，尚未验证本轮 tooltip/暂停/面板 60/页面模糊默认开启；需重新安装/重启候选后现场确认，不能把自动化结果当作现场通过。

自动化结果（Chromium/Edge fixture）：t4（t6 修复后）/t7/t9/t11/t15/t19/t23 浏览器材质用例均为 **15/15 pass、0 skip**，全量 harness **150/150 pass、0 skip**，`readability.test.mjs` **21/21**，`console.test.mjs` **49/49**。完整命令、结果、跳过项与风险见[验证记录](../../docs/verification/2026-11-10-dsh-layered-material.md) §21（t23 方向移除/越上层越实复验）与 §24（t26 文档一致性修复/最终状态）；§19 为 t19 现场修复复验，§20 为 t20 历史记录，§22/§23 为 t24 文档同步与 t25 提交前审计。设计冻结见 [ADR 0011](../../docs/adr/0011-dsh-layered-material.md)。三个 fixture 已随上一提交纳入版本控制，当前 `git status` 无未跟踪 fixture；交付时仍请确认提交包含 `test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html`。

装好插件并运行 `dsh web` 后，打开「设置」，左侧导航里会多出一项「背景」：在 Windows 上点击图片或视频会打开系统文件选择器，选好后在页面内命名，背景立即应用并进入已保存主题；也可以清除、开关声音、切换或删除主题，进入全屏把浏览器的标签页和地址栏收起来，以及打开「皮肤中心」安装 `https://hnnulwh.cn` 上已审核的社区皮肤。本地导入只在 Node 端保存绝对路径，并通过带 Range 支持的回环媒体服务读取原文件，不复制用户选择的图片或整段视频主文件。Windows 强制使用本地引用；原生选择器不可用时会明确报错，不会静默上传或复制媒体。非 Windows 环境保留兼容上传，并明确提示该模式会保存托管副本。网页控制台没有摸鱼；浅色/深色跟 DSH 自己的外观走。下次打开会恢复上次背景。皮肤中心来源固定，不使用 `BEAUTICODE_SKIN_CENTER` 或 `skin-center.json` 改写生产目录。

插件也会注册对话工具（`beauticode_*`）和斜杠命令（`/bg`、`/bg-theme`、`/bg-clear`）。不需要托盘；托盘若已在跑则复用它。

beautiCode **不启动** DeepSeek Harness。请先自己运行 `dsh web`。

不需要 fork 仓库。一行安装：

```sh
npx beauticode-dsh
npx @deepseek-ai/dsh web
```

已有 pnpm 时也可以：

```sh
npx @deepseek-ai/dsh plugin --profile web add beauticode-dsh
npx @deepseek-ai/dsh web
```

在仓库根目录一键写入插件（不需要 pnpm）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-dsh-plugin.ps1
npx @deepseek-ai/dsh web
```

也可以手动（`dsh plugin add` 需要 pnpm）：

```sh
dsh plugin --profile web add file:%CD%/integrations/deepseek-harness
# 或
npx @deepseek-ai/dsh plugin --profile web add file:%CD%/integrations/deepseek-harness
npx @deepseek-ai/dsh web
```

手动接入时：

1. 修改 `cordis.patch.yml` 中的插件接入项；优先使用上面的安装命令自动完成接线。
2. 确保 DSH 和 beautiCode 使用相同的 `BEAUTICODE_DATA_ROOT`。
3. 自己运行 `dsh web`（或带 `--patch`）。
4. 打开页面后在「设置」里点「背景」，或输入 `/bg <本机绝对路径>`，或直接跟 AI 说把某个视频/图片设为背景。

安全边界：DSH Web 必须绑定本机回环地址；控制端点需要随机令牌；媒体 URL 仅允许带令牌的回环 HTTP 地址；浏览器回执只接受同源请求。

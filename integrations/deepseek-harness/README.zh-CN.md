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

「设置 → 背景」现在有两条独立材质通道。**页面材质**默认 30%，只作用于页面模式 MainPanel 布局列 `[data-global-panel]`（插件页、技能页、自动化任务等）；主会话没有该锚点，因此不铺页面材质。**页面通道默认是 alpha-only**：只加 30% 底色，**不加页面模糊**，不设置 `backdrop-filter`、`position`/`isolation`，也没有 `::before` 背板；页面强度仍作为面板模糊模型的尺度 `I`（默认 2.4px），但页面本身没有实际模糊，`getBlur().page` 默认 **0**（实际应用值），panel=3.69。**功能面板不透明**默认 100%，作用于 dialog / alertdialog / menu / listbox / tooltip、消息编辑栏 `[data-composer-card]` 和提问/计划审核/授权确认卡片。高级设置提供：材质档位间隔（透明度）默认 8%、材质档位间隔（模糊）默认 2px、最大模糊默认 8px、自动档位方向默认「越上层越实」（可切「越上层越透」），以及默认关闭的「页面模糊（实验）」。面板根 alpha 1.00，独立根只应用一次 `backdrop-filter`，默认页面下为 `blur(3.69px)`；嵌套层只按 alpha 档位变化、绝不加模糊；`[data-shell-overlay]`（`shell.overlay`）容器本身跳过，但其中标准 role 浮层仍按独立/嵌套处理；无标准 role 的第三方浮层不处理。

**页面模糊（实验）默认关闭、不推荐**：存储键 `beauticode-page-blur` 仅在字面 `"true"` 时开启，API 为 `getPageBlur()`/`setPageBlur(boolean)`。控制台行标注「默认关闭；开启后会启用页面背板，可能影响页面内 fixed/absolute/高层浮层；仅建议现场试验」。开启后 `data-bc-page-blur="true"`、页面根 `position:relative`/`isolation:isolate`、`::before` `blur(2.4px)`、页面 alpha 77/255、`getBlur().page=2.4`；fixed 仍 60/60、portal 40/40，但 V9 absolute 250、V10 high-outside、V11 滚动底部约 36px 失模糊会重新出现。页面 0% 时按钮/重置 disabled、显示「需要页面材质 >0」，存储选项保留，恢复 30% 后背板自动恢复。

**这是用户可见的设计变更**：默认页面不再有 2.4px 模糊，只剩 30% 底色；面板模糊保持原样。插件页不再完全透明：它和自动化任务等页面一样获得 30% 底色（不是 100% 实心板，默认也没有页面模糊），壁纸仍明显透出；页内说明文字与计数提升到宿主次要文字色，文字加一层随主题取色的柔和光晕（深色主题黑色、浅色主题白色）。图片、视频、背景阴影、磨砂和画窗模式都不会让插件页重新变成实色。

0% 语义：页面 0% 只关闭 30% 底色与插件页辅助；若实验开启，同时移除 `data-bc-page-blur`、背板/定位但保留实验存储，恢复 30% 后背板自动恢复。面板 0% 只关闭面板材质。两者回到 `client.js` 发布的半透明宿主外观（不是未经 beautiCode 处理的 DSH 原生实色）。旧键 `beauticode-readable-surfaces` 的 `"true"`/`"false"`/数字 0–100 语义保留，0 仍写 `"false"` 以方便回滚；页面与高级档位使用新键，旧包会忽略。选择即时生效并跨同源窗口同步；清除背景后恢复宿主样式，偏好保留。需要回滚时把页面/面板强度调到 0%，或恢复旧插件版本。

需要知道的取舍与风险：30% 页面底色不是「任意壁纸都 ≥ 4.5:1」的保证——深色主题适合偏暗壁纸、浅色主题适合偏亮壁纸；面板低于 100%、页面低于 30% 时壁纸和背景效果会更明显。**默认形态下 V3/V9/V10/V11/V12/V13 不出现**：页面内 fixed 开/关均 `(60,60)`、portal fixed 均 `(40,40)`，absolute 探针开/关均 `(10,12)`，高 z-index 探针开/关均 `high-inside`，滚动后 30% fill 仍覆盖底部；没有 `position`/`isolation`/`::before` 背板。**V14 开放（产品取舍）**：30% alpha 只能减弱、不能消除后方文字透出；高对比示例中后景文字对比度从 21:1 降到约 10.68:1，仍清晰可见。如果最初问题是会话/背景文字在页面后明显重叠，30% 不够，需要产品/Lead 确认；实验 blur 也不宣称解决 V14。**V15 默认消失**：默认页面根无 blur 标记/变量，`getBlur().page=0`；只有实验开启时才出现 2.4px 实际值。另有默认页面层无 filter（无整列模糊性能开销）、实验开启会恢复全列背板开销、嵌套层无独立模糊、多个独立浮层共用 `s2`（重叠时总模糊略高）等已知边界。真实 DSH 尚未现场验证，不能把自动化结果当作现场通过；开启实验后必须重新现场验收 V9–V13。

自动化结果（Chromium/Edge fixture）：t4（t6 修复后）/t7/t9/t11/t15 浏览器材质用例均为 **15/15 pass、0 skip**，全量 harness **149/149 pass、0 skip**，`readability.test.mjs` **21/21**，`console.test.mjs` **48/48**。完整命令、结果、跳过项与风险见[验证记录](../../docs/verification/2026-11-10-dsh-layered-material.md) §15（t11 alpha-only）、§16（t12 alpha-only 文档/历史）、§17（t15 实验页面模糊复验）与 §18（t16 文档/最终集成）；设计冻结见 [ADR 0011](../../docs/adr/0011-dsh-layered-material.md)。仓库交付时请一并提交 `test/fixtures/fake-dom.mjs`、`layered-material.mjs`、`backdrop-model.html`（V7），否则干净检出的浏览器用例会失败。

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

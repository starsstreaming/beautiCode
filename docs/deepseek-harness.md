# DeepSeek Harness 集成

beautiCode 通过 DeepSeek Harness 的 Cordis 插件接口接入（`beauticode-dsh`），不修改 DSH 源码，也不依赖 Chromium 调试端口。插件通过 DSH 的结构化页面注入同时支持 Web 和官方 Desktop；后者的页面地址是 `dsh-app://app/`，Host 默认端口是 `19387`。DSH 由你自己启动；beautiCode 只挂插件、不替代、不重启你的 DSH。Codex Desktop 仍由托盘按原路径拉起，与本节无关。

## 已实现能力

- 图片背景、MP4 视频背景与清除。首页（`data-phase="hero"`）壁纸保持原亮度；进入会话（`active` / `settling`）后才压暗。
- 网页控制台：插件装好后，打开 DSH 的「设置」，左侧导航多出一项「背景」。可从系统文件夹选择图片或 MP4、清除、开关声音、切换已保存主题、进入全屏。不需要托盘。网页控制台没有摸鱼。
- 对话工具与斜杠命令：在 DSH 里说「把某个本机 MP4 设成背景」，或输入 `/bg`、`/bg-theme`、`/bg-clear`。插件自己完成导入，不需要托盘。若托盘已经在跑，则复用托盘，避免两套写入打架。
- 视频默认静音；可请求开启声音。若浏览器自动播放策略阻止开启声音，会继续静音播放并返回 `blocked: true`。
- 视频播放位置随已保存主题记录；切换主题、重新应用与页面恢复时从最近位置继续。
- 摸鱼模式：隐藏 DSH 的 `#root`，背景舞台继续显示和播放；`Ctrl+Shift+Space` 可退出（托盘全局热键）。网页控制台不提供摸鱼。
- 外观浅色 / 深色跟随 DSH 自己的设置，插件不再改写 DSH 主题 DOM。
- 分层材质：「页面材质」默认 30%，只铺在页面模式的 MainPanel 布局列 `[data-global-panel]`；「功能面板不透明」默认 100%，作用于设置、弹层、菜单、消息编辑栏和提问窗口。两条通道互相独立，另有透明度档位、模糊档位、最大模糊、自动方向和默认关闭的「页面模糊（实验）」高级设置；0% 各自关闭并回退到原有半透明外观。详见[分层材质与设置](#分层材质与设置)与 [ADR 0011](adr/0011-dsh-layered-material.md)。
- 图片/视频主题的保存、切换和删除。
- 页面刷新或稍后打开时，会恢复当前背景。找不到 `#root` 时应用失败并回滚，不会静默画坏页。

同一个 beautiCode 数据目录一次只能运行一个宿主会话，避免 Codex 与 DSH 同时写入造成状态损坏。

## 分层材质与设置

背景启用后，「设置 → 背景」提供两条独立材质通道和一组高级档位：

| 设置行 | 默认 | 作用 |
|---|---:|---|
| 页面材质 | 30% | 页面模式 MainPanel 布局列 `[data-global-panel]` 的 30% 底色；**页面不加模糊**；主会话没有该锚点，不铺页面材质 |
| 功能面板不透明 | 100% | dialog / alertdialog / menu / listbox / tooltip、消息编辑栏 `[data-composer-card]`、提问/计划审核/授权确认卡片 |
| 材质档位间隔（透明度） | 8% | 嵌套层每深一层，alpha 增加/减少多少 |
| 材质档位间隔（模糊） | 2px | 每多一个独立面板层，模型总模糊增加多少 |
| 最大模糊 | 8px | 面板栈的模型总模糊上限，0–16px；页面强度只提供尺度 `I` |
| 自动档位方向 | 越上层越实 | 嵌套层逐级变实；可切换「越上层越透」 |
| 页面模糊（实验） | 关闭 | **默认关闭、不推荐**；开启后恢复页面 `::before` 背板 blur 2.4px，重新引入 V9/V10/V11 实验风险；仅建议 DSH 现场试验 |

插件页、技能页、自动化任务页都按页面通道处理；主会话不是页面，不铺页面材质。页面根默认 alpha 0.30，**只有底色**：`backdrop-filter:none`、`filter:none`、`position:static`、`isolation:auto`，没有 `::before` 背板。页面强度仍作为面板模糊模型的尺度 `I`（默认 `0.30 × 8 = 2.4px`）参与面板半径计算，但页面本身没有实际模糊；`getBlur().page` 默认是 **0**（实际应用值），不是模型值。面板根默认 alpha 1.00，作为独立覆盖层只应用一次 `backdrop-filter`；默认页面下为 `blur(3.69px)`，不因页面改为 alpha-only 而改变。嵌套层只按 alpha 档位变化，**不应用 `backdrop-filter`**。

「页面模糊（实验）」默认关闭：存储键 `beauticode-page-blur` 仅在字面 `"true"` 时开启；API 为 `getPageBlur()`/`setPageBlur(boolean)`。开启后 `html[data-bc-page-blur="true"]`、页面根 `position:relative`/`isolation:isolate`、`::before` `blur(2.4px)`、页面 alpha 仍 77/255；`getBlur().page=2.4`。控制台高级设置里标注「默认关闭；开启后会启用页面背板，可能影响页面内 fixed/absolute/高层浮层；仅建议现场试验」。页面材质 0% 时按钮/重置 disabled、显示「需要页面材质 >0」，存储选项保留，恢复 30% 后背板自动恢复。

**这是用户可见的设计变更**：页面不再有 2.4px 模糊，只剩 30% 底色；面板模糊保持原样。

判定只使用宿主语义锚点：页面只认 `[data-global-panel]`；面板标准 role、`[data-composer-card]` 和三个待交互面板的内层卡片；`[data-shell-overlay]`（`shell.overlay`）容器本身跳过，但其中的 role 浮层仍按独立/嵌套处理；无标准 role 的第三方浮层不处理。面板若在页面根内，按嵌套层处理；在页面根外（常见 portal）则是独立根。

0% 语义与旧偏好：

- 页面 0%：移除页面根、30% 底色和插件页文字辅助；若实验开启，同时移除 `data-bc-page-blur`、页面根、背板/定位，但保留 `beauticode-page-blur="true"` 存储选项，恢复页面强度 > 0 后背板自动恢复。页面回到 `client.js` 发布的半透明宿主外观；面板材质不受影响。
- 面板 0%：移除所有面板/嵌套层标记与模糊，role 面板、编辑栏、待交互卡片回到半透明；页面材质不受影响。
- 两者都 0%：没有材质标记，等同当前半透明宿主外观。
- 旧键 `beauticode-readable-surfaces` 保持兼容：`"true"` 读作 100、`"false"` 读作 0、数字按 0–100 夹取；0 仍写 `"false"`，方便回滚旧包。页面和高级档位使用新键，旧包忽略。
- 设置会即时生效并跨同源窗口同步；清除背景后恢复宿主样式，偏好保留。

已知风险与边界（详见 [ADR 0011 §4](adr/0011-dsh-layered-material.md#4-风险边界与取舍) 与[验证记录](verification/2026-11-10-dsh-layered-material.md)）：

- **默认形态 V3/V9/V10/V11/V12/V13 已关闭**：页面通道 alpha-only，不再直接带 `backdrop-filter`，也不使用 `position`/`isolation`/`::before` 背板。页面内 fixed 开/关均 `(60,60)`，portal fixed 均 `(40,40)`；absolute 探针开/关均 `(10,12)`；高 z-index 探针开/关均 `high-inside`；页面列滚动后 30% fill 仍覆盖底部（fixture max channel delta 67）。
- **页面模糊（实验）开启时**：恢复 v1 页面 `::before` 背板（blur 2.4px）。fixed 仍 60/60、portal 40/40（不重新引入 V3 fixed 偏移），但 V9 absolute 探针变为 250、V10 高 z-index 变 high-outside、V11 滚动底部约 36px 失去模糊（delta 1）。这些是 opt-in 的已知实验风险，不作为默认回归；开启后必须重新现场验收 V9–V13，不能把自动化结果当现场通过。
- **V14 开放（产品取舍）**：30% alpha 只能减弱、不能消除后方文字透出。高对比示例中，后景文字对比度从 21:1 降到约 **10.68:1**，仍清晰可见；如果最初问题是会话/背景文字在页面后明显重叠，30% 不够，需要产品/Lead 确认。页面前景文字可读性与“后方不重叠”不是同一件事；实验 blur 也不宣称解决 V14。
- **V15**：默认路径页面根无 blur 标记/变量、`getBlur().page=0`、panel=3.69，V15 消失；只有实验开启时才出现 blur 标记/变量与 2.4px 实际值。
- **性能**：默认页面层没有 `backdrop-filter`，没有整列页面模糊开销；实验开启会恢复全列背板模糊开销，需现场测量。面板、菜单、tooltip 的 filter 面积小。未做真实 DSH 视频帧测量。
- **嵌套层没有独立模糊**：嵌套层只做 alpha 档位；需要更强模糊时应让浮层成为独立 root（通常是 portal 到 body）。
- **多个独立浮层**：同一视觉栈里的多个独立面板共用 `s2`，重叠时总模糊可能略高；ADR 已明确接受。
- **对比度**：30% 页面底色不是「任意壁纸都 ≥ 4.5:1」的保证；插件页仍保留随主题取色的文字光晕和一级次级文字色提升，浅/深主题各有适用壁纸范围。

验证范围：t4（t6 修复后）/t7/t9/t11/t15 的浏览器材质用例在真实 Chromium/Edge fixture 上均为 **15/15 pass、0 skip**，全量 harness **149/149 pass、0 skip**，`readability.test.mjs` **21/21**、`console.test.mjs` **48/48**。这些是 fixture/真实浏览器联动结果，**不是真实 DSH 现场验收**。本机真实 DSH 仍运行旧插件且无渲染器 DOM 访问，设置页、插件页、技能页、审批卡片、菜单与视频性能均未现场验证；V14 是否满足最初产品目标、实验项是否值得保留，也需现场/产品确认。完整命令、结果、跳过项与风险见[验证记录](verification/2026-11-10-dsh-layered-material.md) §15（t11 alpha-only）、§16（t12 alpha-only 文档/历史）、§17（t15 实验页面模糊复验）与 §18（t16 文档/最终集成）。

## 官方 Desktop 安装

先启动 Desktop 一次以创建 `desktop` profile，再从应用菜单退出（关闭窗口通常只会隐藏）。发布包含本适配的插件版本后，在 Desktop 的「插件」页面安装 `beauticode-dsh`，或者用 **Desktop 安装的** `dsh` 命令：

```sh
dsh plugin --profile desktop add beauticode-dsh
```

要试当前仓库源码，先在仓库根目录执行 `npm run plugin:pack`，再将包名换成 `file:<仓库绝对路径>/artifacts/dsh-plugin`。

重新打开 Desktop，在「设置」里选择「背景」。Desktop profile 的插件安装由官方客户端管理；下面的 Windows 安装包和 `npx beauticode-dsh` 接线只针对 Web profile。若使用 beautiCode 托盘，启动时显式指定 Desktop Host 地址：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps\tray\start-tray.ps1 -TargetHost dsh -DshUrl http://127.0.0.1:19387
```

若 `webserver.config.port` 在 Desktop profile 中修改过，应使用修改后的端口。Desktop 主窗口关闭后通常仍保持运行；完全退出后桥接会断开。

## Web 安装插件

Windows 安装包会在安装结束时（以及选择 DeepSeek Harness 时）自动写入你的 DSH profile，**不需要 pnpm，也不需要再跑 `dsh plugin add`**。没有 DSH 也不影响安装；第一次运行 `dsh web` 会走 home 层补丁。

若改过安装目录，看安装文件夹里的 `集成说明.txt`，不要照抄默认路径。

不需要 fork 仓库。一行安装（不需要 pnpm）：

```sh
npx beauticode-dsh
npx @deepseek-ai/dsh web
```

已有 pnpm 时也可以：

```sh
npx @deepseek-ai/dsh plugin --profile web add beauticode-dsh
npx @deepseek-ai/dsh web
```

也可手动（`dsh plugin add` 需要本机有 pnpm）：

```sh
# 源码目录
dsh plugin --profile web add file:<beautiCode 路径>/integrations/deepseek-harness
npx @deepseek-ai/dsh plugin --profile web add file:<beautiCode 路径>/integrations/deepseek-harness

# Windows 安装包（默认目录；自定义安装时请替换路径）
dsh plugin --profile web add file:%LOCALAPPDATA%\Programs\beautiCode\integrations\deepseek-harness
npx @deepseek-ai/dsh plugin --profile web add file:%LOCALAPPDATA%\Programs\beautiCode\integrations\deepseek-harness
```

未把 `dsh` 装到 PATH 时，用上面的 `npx @deepseek-ai/dsh` 写法。

## 启用插件

把下面的条目加到 profile 自己的 patch 层（`~/.dsh/cordis.patch.yml` 或 profile 目录的 `cordis.patch.yml`），然后自己启动 `dsh web`：

```yaml
- insert:
    - id: beauticode-bridge
      name: 'beauticode-dsh'
      inject: [webServer]
```

插件的加载配置见 [`integrations/deepseek-harness/cordis.patch.yml`](../integrations/deepseek-harness/cordis.patch.yml)。

## 网页控制台

插件注入 `console.js`，它往 DSH 设置对话框的导航栏里加一个「背景」格，并在 `div[data-slot="settings.section"]`（React 渲染的那一栏）后面挂上自己的一页，选中时用 `data-bc-page` 把 React 那栏藏起来。设置对话框只在打开时存在，且类名是构建期 hash，所以识别只看 `role="dialog"` / `aria-modal` / 后代 `nav` / `[data-slot="settings.section"]` 这些结构特征，认不出就什么都不做。样式全部走 `--dsw-alias-*` / `--dsw-specific-*` token，跟设置页其他栏目同一套行结构。页面里的「全屏显示」调 Fullscreen API，用来隐藏浏览器自己的标签页和地址栏；请求同样必须留在用户手势的同步调用栈里，浏览器不支持时整行收起。同源 `POST /__beauticode/ui/*` 转到已有的 `createBeauticodeActions()`。页面连上 SSE 后会 `reapply` 上次背景。DSH 会话列表底部的 fade 在有壁纸时关掉，避免叠出一条暗影。

## 控制端

托盘可选。启动 beautiCode，在选择框里选 DeepSeek Harness（或直接 `start-tray.ps1 -TargetHost dsh`）。托盘只连接你正在运行的 DSH 网页：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps\tray\start-tray.ps1 -TargetHost dsh -DshUrl http://127.0.0.1:3080
```

CLI 单步：

```bash
npm run bc -- probe --port 3080
npm run bc -- apply-image .\fixtures\poster.png --port 3080
npm run bc -- apply-video .\fixtures\loop.mp4 --port 3080
npm run bc -- clear --port 3080
```

自定义数据目录时，控制端与插件必须使用同一个 `BEAUTICODE_DATA_ROOT`，否则令牌文件不一致。未设置时两边都默认 `%LOCALAPPDATA%\beautiCode`。

> beautiCode 不会自动启动 DSH。若 `dsh web` 未运行或未加载插件，托盘会提示你先启动 DSH 网页，而不是替你拉起进程。网页已开但关掉时，「应用或重新应用」只会重新打开页面。

### 对话导入与斜杠命令

插件在 DSH 的 `tools` / `commands` 服务出现后注册（不把它们写成硬依赖，以免没有 agent 的 webServer 组合挂不上桥）。

| 入口 | 作用 |
|---|---|
| `beauticode_apply_video` / `beauticode_apply_image` | 按本机绝对路径导入 |
| `beauticode_theme_list` / `beauticode_theme_use` | 列出或切换已保存主题 |
| `beauticode_clear` / `beauticode_status` | 清除或查看当前背景 |
| `beauticode_set_fish` / `beauticode_set_muted` | 摸鱼、背景声音 |
| `/bg <绝对路径>` | 按扩展名导入图片或 MP4 |
| `/bg-theme <名称>` | 切换已保存主题 |
| `/bg-clear` | 清除背景 |

没有托盘时，插件在 DSH 进程里启动同一套 `DshSession`（校验、拷贝、媒体服务、live verify）。托盘若已在跑，则继续走 `dsh-control.json`，避免抢同一把写入锁。页面必须已打开，否则 verify 会失败并回滚。

## 安全边界

- DSH 地址只接受 `http://127.0.0.1`、`http://localhost` 或 `http://[::1]`。
- 控制请求使用数据目录内的 256 位随机令牌；Web 浏览器回执只接受同源请求。Desktop 转发会移除浏览器 Origin 标头，因此其回执额外使用 Host 启动时生成、只注入到应用页面的随机密钥。
- 图片与 MP4 由随机端口的本机媒体服务提供，URL 带不可预测令牌，并只接受 DSH Web 回环来源或 `dsh-app://app` 来源。
- 只有浏览器真实加载/解码媒体并回执后，应用事务才成功；否则磁盘状态回滚。
- 自动化测试不能替代发布前的真实 DSH 页面可见性验收。

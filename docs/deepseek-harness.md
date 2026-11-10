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
- 分层材质：「页面材质」默认 30%，只铺在页面模式的 MainPanel 布局列 `[data-global-panel]`；「功能面板不透明」默认 60%，作用于设置、弹层、菜单、消息编辑栏和提问窗口。两条通道互相独立，另有透明度档位、模糊档位、最大模糊和默认开启的「页面模糊」；页内浮层出现时页面模糊暂停。0% 各自关闭并回退到原有半透明外观。详见[分层材质与设置](#分层材质与设置)与 [ADR 0011](adr/0011-dsh-layered-material.md)。
- 图片/视频主题的保存、切换和删除。
- 页面刷新或稍后打开时，会恢复当前背景。找不到 `#root` 时应用失败并回滚，不会静默画坏页。

同一个 beautiCode 数据目录一次只能运行一个宿主会话，避免 Codex 与 DSH 同时写入造成状态损坏。

## 分层材质与设置

背景启用后，「设置 → 背景」提供两条独立材质通道和一组高级档位：

| 设置行 | 默认 | 作用 |
|---|---:|---|
| 页面材质 | 30% | 页面模式 MainPanel 布局列 `[data-global-panel]` 的 30% 底色；主会话没有该锚点，不铺页面材质 |
| 功能面板不透明 | 60% | dialog / alertdialog / menu / listbox、消息编辑栏 `[data-composer-card]`、提问/计划审核/授权确认卡片；已有用户值保留、重置 60 |
| 材质档位间隔（透明度） | 8% | 嵌套层每深一层，alpha 增加多少（只增不减、越上层越实） |
| 材质档位间隔（模糊） | 2px | 每多一个独立面板层，模型总模糊增加多少 |
| 最大模糊 | 8px | 面板栈的模型总模糊上限，0–16px；页面强度只提供尺度 `I` |
| 页面模糊 | 开启 | 默认给页面加 2.4px 模糊；关闭后页面只保留 30% 底色。页面 0% 时按钮/重置禁用、提示「需要页面材质 >0」 |

嵌套 alpha 固定为 `根 alpha + (depth - 1) × alphaStep`，**越上层越实**，没有「越上层越透」选项。旧存储键 `beauticode-material-direction` 不再读取/写入，旧值保留但被忽略；`getMaterial()` 只返回 `{alphaStep, blurStep, maxBlur}`，`setMaterial()` 收到 `direction` 会静默忽略。高级设置只有三个档位滑杆加页面模糊开关。

插件页、技能页、自动化任务页都按页面通道处理；主会话不是页面，不铺页面材质。页面根默认 alpha 0.30，页面模糊默认开启：`html[data-bc-page-blur="true"]`、页面根 `position:relative`/`isolation:isolate`、`::before` `blur(2.4px)`；`getPageBlur()` 默认 true，`getBlur()` 默认 `{page:2.4, panel:3.69}`。面板根默认 alpha 0.60（153/255），独立覆盖层只应用一次 `backdrop-filter`；默认页面下为 `blur(3.69px)`。主会话 composer 同样为面板 60%、blur 2px，没有 page root。嵌套层只按 alpha 档位变化，**不应用 `backdrop-filter`**。

页面根内的标准 role 分两类：

- `tooltip` **不再材质化**：不是候选、不加 alpha/层，也不改写 `--dsw-alias-tooltip-bg`；保留宿主黑底白字、背景和定位（页内/页外都一样）。
- `menu` / `listbox` / `dialog` / `alertdialog` 按**面板材质** 60% 处理，`backdrop-filter:none`，不继承 page alpha/档位；它们不会因为页面根 isolation 而漂移。

**页面模糊暂停**：页面根内出现可见的 tooltip/menu/listbox/dialog/alertdialog 时，页面根加 `data-bc-page-blur-paused`，移除 `position`/`isolation`/`::before`，仅保留 30% 底色；`getBlur().page=0`，面板 blur 3.69 不变。关闭浮层后自动恢复 `relative/isolate` 与 `blur(2.4px)`。暂停是为了消除这些页内浮层在 V9/V10 下的现场漂移；**不是把 V9/V10 永久解决**：没有页内浮层时，页面根仍存在 V9 absolute 包含块（探测 250）和 V10 层叠（default-outside）。

判定只使用宿主语义锚点：页面只认 `[data-global-panel]`；面板标准 role、`[data-composer-card]` 和三个待交互面板的内层卡片；`[data-shell-overlay]`（`shell.overlay`）容器本身跳过，但其中的 role 浮层仍按独立/嵌套处理；无标准 role 的第三方浮层不处理。tooltip 不在材质候选里；页面根内的 menu/listbox/dialog/alertdialog 是面板材质，不是 page 嵌套层。

### 为什么侧栏和主会话不在页面材质内

- **左侧栏**是 DSH chrome，位于 `[data-global-panel]` 之外，不属于页面/面板材质根。它的半透明由 `client.js` 的 `--bc-surface-mix`（默认 36%，会话 active/settling 86%）与 `--dsw-specific-sidebar-fill` 决定，不随页面/面板强度滑杆或页面模糊变化。背景阴影/壁纸磨砂会改变透过侧栏看到的壁纸，但不是侧栏自身材质；页面/面板材质控制不改变它。
- **主会话**没有 `[data-global-panel]`，页面材质与页面模糊都不铺；会话页保持壁纸直出，只有 composer/待交互卡片等面板材质。若以后要“统一页面”，需要独立可选项并单独验收，不应默认扩到主会话。

0% 语义与旧偏好：

- 页面 0%：移除页面根、30% 底色、页面模糊/背板与插件页文字辅助；`beauticode-page-blur` 偏好保留，恢复页面强度 > 0 后自动恢复模糊。页面回到 `client.js` 发布的半透明宿主外观；面板材质不受影响。
- 面板 0%：移除所有面板/嵌套层标记与模糊，role 面板、编辑栏、待交互卡片回到半透明；页面材质不受影响。
- 两者都 0%：没有材质标记，等同当前半透明宿主外观。
- 旧键 `beauticode-readable-surfaces`：缺失或 `"true"` 读作 60、`"false"` 读作 0、数字原样保留（例如已存 35 仍是 35）、无效值回退 60；0 仍写 `"false"` 以兼容旧包。页面和高级档位使用新键，旧包忽略。
- 页面模糊键 `beauticode-page-blur`：仅字面 `"false"` 关闭；缺失/无效按 true。设置即时生效并跨同源窗口同步；清除背景后恢复宿主样式，偏好保留。

已知风险与边界（详见 [ADR 0011 §4](adr/0011-dsh-layered-material.md#4-风险边界与取舍) 与[验证记录](verification/2026-11-10-dsh-layered-material.md)）：

- **V3 fixed 已关闭**：页面根内 fixed 开/关均 `(60,60)`、portal `(40,40)`；页面根自身不持有 `backdrop-filter`，页面模糊由 `::before` 背板承担。
- **V9/V10 默认仍存在**：页面模糊默认开启且没有页内浮层时，absolute 探测为 250、页面内高 z-index 为 `default-outside`。只有页内 tooltip/menu/listbox/dialog/alertdialog 可见触发暂停时，才回到 absolute `(10,12)`、`high-inside`；暂停结束后恢复。不能写成 V9/V10 已解决。
- **V11 仍开放**：页面列自身滚动时，`absolute` 背板随内容滚动，底部一段（fixture `scrollTop=300` 后 bottom strip）失去模糊（delta 1）；暂停机制不解决该问题。
- **V13 仍开放**：页面模糊使用页面根 `::before`；宿主/第三方页面若占用该伪元素仍有覆盖风险，需现场复核。
- **V14 开放**：页面模糊关闭时，30% alpha 只能把高对比后景文字从 21:1 降到约 10.68:1，不能消除后方文字透出；页面模糊开启也不宣称完全解决。
- **V15 已闭合**：默认页面模糊开启时 blur 标记与 `::before` 一致；关闭/0% 后标记和变量移除，`getBlur().page=0`。
- **V16 低-中，开放**：暂停选择器覆盖任意可见的页内 listbox/dialog 等，常驻页内控件可能让页面模糊一直暂停；需真实 DSH/第三方页面现场复核。
- **面板 60% 取舍**：默认从 100% 降到 60%，会更明显地透出后景；设置页/添加插件弹窗在 35% 下已偏透，60% 是新的基线。用户可自行调高；已有 35 等保存值不会被强制迁移。
- **性能**：页面模糊默认开启，整列 `::before` 背板有每帧模糊开销；视频背景需现场测量。面板 filter 面积小。
- **对比度**：30% 页面底色不是「任意壁纸都 ≥ 4.5:1」的保证；插件页仍保留随主题取色的文字光晕和一级次级文字色提升，浅/深主题各有适用壁纸范围。

验证范围：t4（t6 修复后）/t7/t9/t11/t15/t19/t23 的浏览器材质用例在真实 Chromium/Edge fixture 上均为 **15/15 pass、0 skip**，全量 harness **150/150 pass、0 skip**，`readability.test.mjs` **21/21**、`console.test.mjs` **49/49**。这些是 fixture/真实浏览器联动结果，**不是真实 DSH 现场验收**。本机真实 DSH 当前运行上一版候选，未验证本轮 tooltip/暂停/面板 60/页面模糊默认开启/方向移除的现场效果；需要重新安装/重启候选后现场确认，不能宣称本轮现场通过。完整命令、结果、跳过项与风险见[验证记录](verification/2026-11-10-dsh-layered-material.md) §21（t23 方向移除/越上层越实复验）与 §24（t26 文档一致性修复/最终状态）；§19 为 t19 现场修复复验，§20 为 t20 历史记录，§22/§23 为 t24 文档同步与 t25 提交前审计。

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

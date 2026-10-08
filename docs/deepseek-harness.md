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
- 默认开启「功能面板不透明」，让设置、弹层、菜单、消息编辑栏与提问窗口（提问、计划审核、授权确认）遮住后方内容；可在「设置 → 背景」关闭并保存偏好。该选项独立于背景阴影、会话阶段和画窗模式。
- 图片/视频主题的保存、切换和删除。
- 页面刷新或稍后打开时，会恢复当前背景。找不到 `#root` 时应用失败并回滚，不会静默画坏页。

同一个 beautiCode 数据目录一次只能运行一个宿主会话，避免 Codex 与 DSH 同时写入造成状态损坏。

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

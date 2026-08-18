# DeepSeek Harness 集成

beautiCode 通过 DeepSeek Harness 的 Cordis 插件接口接入（`@beauticode/dsh-plugin`），不修改 DSH 源码，也不依赖 Chromium 调试端口。DSH 由你自己启动；beautiCode 只挂插件、不替代、不重启你的 DSH。Codex Desktop 仍由托盘按原路径拉起，与本节无关。

## 已实现能力

- 图片背景、MP4 视频背景与清除。首页（`data-phase="hero"`）壁纸保持原亮度；进入会话（`active` / `settling`）后才压暗。
- 网页控制台：插件装好后，DSH 侧栏「设置」上方出现「背景」。可从系统文件夹选择图片或 MP4、清除、开关声音、切换已保存主题。不需要托盘。网页控制台没有摸鱼。
- 对话工具与斜杠命令：在 DSH 里说「把某个本机 MP4 设成背景」，或输入 `/bg`、`/bg-theme`、`/bg-clear`。插件自己完成导入，不需要托盘。若托盘已经在跑，则复用托盘，避免两套写入打架。
- 视频默认静音；可请求开启声音。若浏览器自动播放策略阻止开启声音，会继续静音播放并返回 `blocked: true`。
- 视频播放位置随已保存主题记录；切换主题、重新应用与页面恢复时从最近位置继续。
- 摸鱼模式：隐藏 DSH 的 `#root`，背景舞台继续显示和播放；`Ctrl+Shift+Space` 可退出（托盘全局热键）。网页控制台不提供摸鱼。
- 外观浅色 / 深色跟随 DSH 自己的设置，插件不再改写 DSH 主题 DOM。
- 图片/视频主题的保存、切换和删除。
- 页面刷新或稍后打开时，会恢复当前背景。找不到 `#root` 时应用失败并回滚，不会静默画坏页。

同一个 beautiCode 数据目录一次只能运行一个宿主会话，避免 Codex 与 DSH 同时写入造成状态损坏。

## 安装插件

Windows 安装包会在安装结束时（以及选择 DeepSeek Harness 时）自动写入你的 DSH profile，**不需要 pnpm，也不需要再跑 `dsh plugin add`**。没有 DSH 也不影响安装；第一次运行 `dsh web` 会走 home 层补丁。

若改过安装目录，看安装文件夹里的 `集成说明.txt`，不要照抄默认路径。

不需要 fork 仓库。发布到 npm 之后，一行安装（不需要 pnpm）：

```sh
npx @beauticode/dsh-plugin
npx @deepseek-ai/dsh web
```

已有 pnpm 时也可以：

```sh
npx @deepseek-ai/dsh plugin --profile web add @beauticode/dsh-plugin
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
      name: '@beauticode/dsh-plugin'
      inject: [webServer]
```

也可以参考 [`integrations/deepseek-harness/cordis.patch.example.yml`](../integrations/deepseek-harness/cordis.patch.example.yml)。

## 网页控制台

插件注入 `console.js`，把「背景」插在侧栏「设置」同一格里（`display: contents`，不另铺底色）。点开后的面板挂在 `document.body` 上，用实色，避免吃半透明壁纸 token。同源 `POST /__beauticode/ui/*` 转到已有的 `createBeauticodeActions()`。页面连上 SSE 后会 `reapply` 上次背景。DSH 会话列表底部的 fade 在有壁纸时关掉，避免叠出一条暗影。

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
- 控制请求使用数据目录内的 256 位随机令牌；浏览器回执只接受同源请求。
- 图片与 MP4 由随机端口的本机媒体服务提供，URL 带不可预测令牌并校验 DSH 页面来源。
- 只有浏览器真实加载/解码媒体并回执后，应用事务才成功；否则磁盘状态回滚。
- 自动化测试不能替代发布前的真实 DSH 页面可见性验收。

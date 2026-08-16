# DeepSeek Harness 集成

beautiCode 通过 DeepSeek Harness 的 Cordis 插件接口接入（`@beauticode/dsh-plugin`），不修改 DSH 源码，也不依赖 Chromium 调试端口。DSH 由你自己启动；beautiCode 只挂插件、不替代、不重启你的 DSH。Codex Desktop 仍由托盘按原路径拉起，与本节无关。

## 已实现能力

- 图片背景、MP4 视频背景与清除。首页（`data-phase="hero"`）壁纸保持原亮度；进入会话（`active` / `settling`）后才压暗。
- 视频默认静音；可请求开启声音。若浏览器自动播放策略阻止开启声音，会继续静音播放并返回 `blocked: true`。
- 视频播放位置随已保存主题记录；切换主题、重新应用与页面恢复时从最近位置继续。
- 摸鱼模式：隐藏 DSH 的 `#root`，背景舞台继续显示和播放；`Ctrl+Shift+Space` 可退出。属于实验性能力。
- 深色、浅色、跟随系统三种背景色调。
- 图片/视频主题的保存、切换和删除。
- 页面刷新或稍后打开时，会恢复当前背景与模式。找不到 `#root` 时应用失败并回滚，不会静默画坏页。

同一个 beautiCode 数据目录一次只能运行一个宿主会话，避免 Codex 与 DSH 同时写入造成状态损坏。

## 安装插件

```sh
# 源码目录
dsh plugin --profile web add file:<beautiCode 路径>/integrations/deepseek-harness

# Windows 安装包
dsh plugin --profile web add file:%LOCALAPPDATA%\Programs\beautiCode\integrations\deepseek-harness
```

包尚未发布到 npm，请按路径安装。

## 启用插件

把下面的条目加到 profile 自己的 patch 层（`~/.dsh/cordis.patch.yml` 或 profile 目录的 `cordis.patch.yml`），然后重启 `dsh web`：

```yaml
- insert:
    - id: beauticode-bridge
      name: '@beauticode/dsh-plugin'
      inject: [webServer]
```

也可以参考 [`integrations/deepseek-harness/cordis.patch.example.yml`](../integrations/deepseek-harness/cordis.patch.example.yml)。

## 控制端

启动 beautiCode，在选择框里选 DeepSeek Harness（或直接 `start-tray.ps1 -TargetHost dsh`）。托盘连接你正在运行的 DSH 网页：

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

> beautiCode 不会自动启动 DSH。若 `dsh web` 未运行或未加载插件，托盘会提示你先启动 DSH 网页，而不是替你拉起进程。

## 安全边界

- DSH 地址只接受 `http://127.0.0.1`、`http://localhost` 或 `http://[::1]`。
- 控制请求使用数据目录内的 256 位随机令牌；浏览器回执只接受同源请求。
- 图片与 MP4 由随机端口的本机媒体服务提供，URL 带不可预测令牌并校验 DSH 页面来源。
- 只有浏览器真实加载/解码媒体并回执后，应用事务才成功；否则磁盘状态回滚。
- 自动化测试不能替代发布前的真实 DSH 页面可见性验收。

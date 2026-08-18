# DeepSeek Harness 桥接插件

该 Cordis 插件向 DSH Web 注入 beautiCode 浏览器客户端，并提供本机鉴权接口。支持图片、MP4、播放位置、静音、摸鱼模式以及清除背景。

装好插件并运行 `dsh web` 后，侧栏「设置」上方会出现「背景」：可从文件夹选图片或 MP4、清除、开关声音、切换已保存主题。网页控制台没有摸鱼；浅色/深色跟 DSH 自己的外观走。下次打开会恢复上次背景。

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

1. 修改 `cordis.patch.example.yml` 中的 `file:///.../index.mjs`。
2. 确保 DSH 和 beautiCode 使用相同的 `BEAUTICODE_DATA_ROOT`。
3. 自己运行 `dsh web`（或带 `--patch`）。
4. 打开页面后用侧栏「背景」，或输入 `/bg <本机绝对路径>`，或直接跟 AI 说把某个视频/图片设为背景。

安全边界：DSH Web 必须绑定本机回环地址；控制端点需要随机令牌；媒体 URL 仅允许带令牌的回环 HTTP 地址；浏览器回执只接受同源请求。

# DeepSeek Harness 桥接插件

该 Cordis 插件向 DSH Web 注入 beautiCode 浏览器客户端，并提供本机鉴权接口。支持图片、MP4、播放位置、静音、摸鱼模式、深浅色调以及清除背景。

插件会注册对话工具（`beauticode_*`）和斜杠命令（`/bg`、`/bg-theme`、`/bg-clear`），把本机文件导入为背景。不需要托盘；托盘若已在跑则复用它。

beautiCode **不启动** DeepSeek Harness。请先自己运行 `dsh web`，再打开 beautiCode 选择 DeepSeek Harness。

安装包和托盘会把插件写入你的 DSH profile。源码环境也可以手动：

```sh
dsh plugin --profile web add file:%CD%/integrations/deepseek-harness
dsh web
```

手动接入时：

1. 修改 `cordis.patch.example.yml` 中的 `file:///.../index.mjs`。
2. 确保 DSH 和 beautiCode 使用相同的 `BEAUTICODE_DATA_ROOT`。
3. 自己运行 `dsh web`（或带 `--patch`）。
4. 打开页面后输入 `/bg <本机绝对路径>`，或直接跟 AI 说把某个视频/图片设为背景。

安全边界：DSH Web 必须绑定本机回环地址；控制端点需要随机令牌；媒体 URL 仅允许带令牌的回环 HTTP 地址；浏览器回执只接受同源请求。

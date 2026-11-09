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

「设置 → 背景」的「功能面板不透明」默认 100%，保证设置、弹层、菜单、消息编辑栏与提问窗口（提问、计划审核、授权确认）遮住后方内容；可用滑杆按 0–100% 调节，0% 即关闭保护、恢复宿主原有半透明。Web 与官方 Desktop 的插件页是页面而不是面板，因此与「自动化任务」等页面一样保持透明：标题区、各分组、卡片、详情、配置和加载／空／错误状态都不铺底板，壁纸直接透出。为在小字密集处保住可读性，页内说明文字与计数提升到宿主次要文字色，并给页面文字加一层随主题取色的柔和光晕（深色主题黑色、浅色主题白色）；这两项辅助同样受此强度控制。图片、视频、背景阴影、磨砂和画窗模式都不会让插件页重新变成实色。需要知道的取舍：面板强度低于 100% 后，透过面板看到的壁纸（包括背景阴影与磨砂的效果）会逐级变多，面板后方的内容也更容易辨认；页面透明后文字对比度还取决于壁纸亮度——深色主题适合偏暗的背景、浅色主题适合偏亮的背景；若壁纸很亮（深色主题）或很暗（浅色主题），说明文字会不容易看清，此时可切换主题或调低背景亮度。拖到 0% 后，面板回到半透明，插件页也不再应用上述两项辅助；选择会保存在当前应用的本地偏好中，清除背景后恢复宿主样式。需要回滚时把强度调回 100% 或恢复旧插件版本即可。

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

# Cursor 与豆包桌面背景适配

本适配当前只支持 Windows，并且默认不启用。两款客户端各自安装、运行和卸载守护，主题及显示参数也分别保存在：

- `%LOCALAPPDATA%\beauticode\hosts\cursor\state.json`
- `%LOCALAPPDATA%\beauticode\hosts\doubao\state.json`

## 启用与卸载

在源码目录运行：

```powershell
npm run cursor:setup -- install
npm run cursor:setup -- status
npm run cursor:setup -- uninstall

npm run doubao:setup -- install
npm run doubao:setup -- status
npm run doubao:setup -- uninstall
```

Windows 安装包内可使用自带 Node.js 执行相同脚本：

```powershell
runtime\node.exe scripts\desktop-cdp-setup.mjs --host cursor install
runtime\node.exe scripts\desktop-cdp-setup.mjs --host doubao install
```

`install` 只注册所选宿主的登录启动守护。守护不会主动打开客户端：用户从原始图标启动后，如果检测到唯一、创建不到 10 秒且未带 CDP 参数的主进程，才进行一次受控重启。用户主动关闭客户端后，守护只等待，不会重新启动它。`uninstall` 会停止并移除守护，但保留主题状态和原始媒体文件。

## 已测量宿主契约

| 宿主 | 基准版本 | 默认端口 | 精确目标页 | 导航锚点 |
| --- | --- | ---: | --- | --- |
| Cursor | 3.18.9 | 9341 | `vscode-file://vscode-app/d:/cursor/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html` | `[data-action-id="marketplace"][data-sidebar-primary-action]`，标签 `Customize` |
| 豆包 | 2.29.12 | 9342 | `doubao://doubao-chat/chat` | `[data-testid="skill-page-item-more"]`，标签 `更多` |

锚点或标签不一致时注入会失败关闭，不会用模糊文本匹配插入其他页面。客户端升级后应先重新测量这些契约。

Cursor 的入口是 `background`，直接位于 `Customize` 后；所有面板文案为英文。豆包的入口是 `自定义背景`，直接位于 `更多` 后；面板文案为中文。

## 文件与安全边界

- CDP 仅绑定和访问 `127.0.0.1`，并验证 WebSocket 端口和精确目标页。
- 只在固定候选端口中选择端口；不会扫描任意网络地址。
- 导入由带 TopMost owner 的 Windows 原生选择器完成。
- Node.js 只校验文件路径和类型，再通过 `DOM.setFileInputFiles` 交给页面；不读取或复制图片、视频内容。页面使用 `blob:` URL，因此大视频不会按文件体积占用守护内存。
- 每次本地导入必须输入 1–80 字符的主题名；媒体加载成功后才写入主题状态。皮肤中心使用皮肤自带名称。
- 主题仅保存名称、类型和原始路径。原文件移动或删除后会提示不可用；“清除背景”不会删除已保存主题。

## 维护说明

共享实现位于 `packages/adapter-desktop-cdp`；宿主契约分别位于 `packages/adapter-cursor` 与 `packages/adapter-doubao`。`scripts/desktop-cdp-runner.mjs` 负责 CDP 会话、文件选择、状态和本地皮肤中心，`scripts/desktop-cdp-setup.mjs` 负责独立守护的安装与卸载。

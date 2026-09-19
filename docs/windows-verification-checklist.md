# WorkBuddy 适配层 Windows 验证清单

> 配套分支：`feat/workbuddy-background`（v8.2）。Windows 适配**部分完成**：代码路径已就位，但缺少真机验证与守护注册机制。本清单同时归档为 issue 内容。

## ❌ 缺失：守护注册机制

`scripts/wb-setup.mjs` 目前仅支持 macOS（LaunchAgent：RunAtLoad + KeepAlive + `launchctl setenv WORKBUDDY_REMOTE_DEBUGGING_PORT 9335`）。Windows 需要等价方案：

- [ ] 守护常驻：schtasks 计划任务或启动文件夹快捷方式（登录自启 + 崩溃拉起）
- [ ] CDP 端口注入：Windows 无 `launchctl setenv`，需确认 WorkBuddy（Electron）读取 `WORKBUDDY_REMOTE_DEBUGGING_PORT` 的途径（快捷方式命令行参数 / setx 系统环境变量 / 包装器启动器）
- [ ] 日志落盘路径（macOS 是 `~/Library/Logs/`，Windows 建议 `%LOCALAPPDATA%\beauticode\logs`）

## 🔬 待真机验证（代码已就位，逻辑上跨平台但未实测）

- [ ] 文件选择：`powershell.exe -NoProfile -STA` + `System.Windows.Forms.OpenFileDialog`（Windows 文件对话框硬性要求 STA）
- [ ] 导入背景路径回填：`filePathToUrl` 的 Windows 归一（`C:\foo` → `file:///C:/foo`）在 Chromium file:// 渲染层实际可加载
- [ ] 皮肤目录：`%APPDATA%\beauticode\skins` 上架流程（放文件 → 皮肤中心目录刷新 → 缩略图/应用）
- [ ] 皮肤中心本地服务：127.0.0.1:9337 是否触发 Windows 防火墙首次提示；Edge/Chrome 打开商城页的 fetch(CORS) 行为
- [ ] 字体栈：Segoe UI / 微软雅黑 下弹窗与浮窗排版
- [ ] 沉降幕/还原层/Monaco 文件视图在 Windows GPU 驱动下的表现（频闪回归测试）

## 环境

- 分支：`feat/workbuddy-background`（v8.2，16 文件 +3028 行）
- 涉及文件：`scripts/wb-cdp-runner.mjs`、`scripts/wb-setup.mjs`、`packages/adapter-workbuddy/src/background-bar.ts`

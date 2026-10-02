# WorkBuddy 适配层 Windows 验证清单

> 配套：`scripts/wb-setup.mjs` + `scripts/wb-cdp-runner.mjs`。Windows 安装路径已落地；下列勾选是真机回归，不是缺实现。

## 守护注册（代码已就位）

`wb-setup.mjs` 三平台都会装：

- [x] 守护常驻：Windows「启动」文件夹 VBS 拉起 `wb-cdp-runner.mjs --watchdog`（崩溃 3s 拉起）；macOS LaunchAgent KeepAlive；Linux autostart
- [x] CDP 端口：Windows `setx WORKBUDDY_REMOTE_DEBUGGING_PORT`；runner 只修复 10 秒内新启动且缺口的单一 WorkBuddy 主进程，进程不存在时等待用户启动，主动退出不会重开
- [x] 日志：Windows `%LOCALAPPDATA%\beauticode\logs\wb-runner.log`

## 待真机回归（逻辑已跨平台）

- [x] 文件选择：`powershell.exe -NoProfile -STA` + TopMost owner，且 stdout 固定为 UTF-8（中文文件名不损坏）
- [x] 已保存主题：导入后强制命名、自动写盘，面板可列出并切换图片/视频主题
- [ ] 导入背景路径回填：`filePathToUrl` 的 Windows 归一在 Chromium file:// 渲染层实际可加载
- [ ] 皮肤目录：`%APPDATA%\beauticode\skins` 上架流程
- [ ] 皮肤中心本地服务：127.0.0.1:9337 防火墙首次提示
- [ ] 字体栈：Segoe UI / 微软雅黑 下弹窗与浮窗排版
- [ ] 沉降幕/还原层/Monaco 文件视图在 Windows GPU 驱动下的表现

## 环境

- 涉及文件：`scripts/wb-cdp-runner.mjs`、`scripts/wb-setup.mjs`、`packages/adapter-workbuddy/src/launch.ts`

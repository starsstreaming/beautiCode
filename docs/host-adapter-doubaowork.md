# 豆包工作桌面背景适配

豆包工作是独立于普通豆包的 Windows 客户端。本适配针对 [Issue #99](https://github.com/starsstreaming/beautiCode/issues/99)，复用桌面 CDP（Chrome 调试协议）运行时，但使用独立的进程、端口和主题状态。

## 使用方式

源码工作区使用 `npm run doubaowork:setup -- install|status|uninstall`。安装后，在客户端退出时运行 `node scripts/quick-launch.mjs doubaowork`。打包后的 `beauticode-desktop` 提供 `doubaowork install|status|health|uninstall`，通过开始菜单中的「beautiCode DoubaoWork (背景)」快捷方式启动客户端。卸载守护程序会保留主题状态和原始媒体文件。

背景设置挂在豆包工作的「设置 → 外观设置」中，包含功能面板不透明、阴影、磨砂、声音、导入、已保存背景、皮肤中心、本地壁纸库和清除。功能面板默认保留宿主底色；用户可以选择让其透明。

图片与视频主题记录原文件路径，导入时默认使用不含扩展名的文件名。Wallpaper Engine 的视频项目可使用项目中的 MP4 或 MOV，`scene` 项目使用 JPG、PNG、WebP 或 AVIF 预览图。壁纸库从 Steam 配置发现目录，按标题排序和分页。浏览只读项目描述，选中时解析并校验媒体。以前保存的 `project.json` 主题路径可在恢复时重新解析。

## 运行边界

- 默认端口为 `9346`，另有固定候选端口 `9356`、`9366`、`9376`；调试连接仅使用本机回环地址。
- 目标仅限经过验证的 `doubaowork` 聊天页面，缺少宿主锚点时停止注入。多个候选页面存在时，运行时选择面积较大的页面。
- 快捷方式只在未发现正在运行的豆包工作主进程时启动客户端，守护程序只接入符合契约的 CDP 页面。已打开且没有 CDP 的客户端会保留，快捷方式返回 `already-running-without-cdp`。
- 窗口切换前保存待写入的主题和外观设置，再交给新窗口恢复。
- 主题与运行状态位于 `%LOCALAPPDATA%\beautiCode\hosts\doubaowork`，与普通豆包分开。壁纸项目描述中的视频路径必须留在该项目目录内，媒体仍需通过现有文件校验。

## 验证状态

外观页契约来自 #103 对豆包工作 2.36.15 的观测。当前分支的进程行为由测试替身覆盖，设置控件由独立浏览器夹具覆盖。受控快捷方式在真实客户端上的启动、登录态和壁纸显示仍需验收。

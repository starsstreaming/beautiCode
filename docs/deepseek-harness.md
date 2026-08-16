# DeepSeek Harness 集成

beautiCode 通过 DeepSeek Harness 的 `webServer` 插件接口接入，不修改 DSH 源码，也不依赖 Chromium 调试端口。当前实现按 npm `@deepseek-ai/dsh@0.1.0-rc.6` 的接口验证；DSH 升级后应重新执行真实页面验收。

## 已实现能力

- 图片背景、MP4 视频背景与清除。首页（`data-phase="hero"`）壁纸保持原亮度；进入会话（`active` / `settling`）后才压暗。
- 视频默认静音；可请求开启声音。若 Chromium 自动播放策略阻止开启声音，会继续静音播放并返回 `blocked: true`。
- 视频播放位置随已保存主题记录；切换主题、重新应用与页面恢复时从最近位置继续。
- 摸鱼模式：隐藏 DSH 的 `#root`，背景舞台继续显示和播放；`Ctrl+Shift+Space` 可退出。
- 深色、浅色、跟随系统三种背景色调。
- 图片/视频主题的保存、切换和删除。
- 页面刷新或稍后打开时，托盘会检测代际不一致并恢复当前背景与模式。

同一个 beautiCode 数据目录一次只能运行一个宿主会话，避免 Codex 与 DSH 同时写入造成状态损坏。

## 推荐启动方式

从开始菜单或桌面启动 beautiCode，在弹出的目标应用选择框中选择 DeepSeek Harness。也可以使用开始菜单中的“beautiCode · DeepSeek Harness”专用入口跳过选择框。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\WoRk\beautiCode\scripts\start-beauticode-dsh.ps1
```

第三阶段安装包已内置经完整性校验的 `@deepseek-ai/dsh@0.1.0-rc.6` 和 Node.js，用户不需要全局安装 Node/npm/DSH。源码环境没有兼容运行时时，启动器只会安装到 beautiCode 数据目录的 `dsh-runtime`，不会执行全局 npm 安装。

启动器会：

1. 校验本地 DSH 的 pinned current.json 与 CLI 路径（安装时已核对版本和 npm SHA-512）；点击启动时不再先跑一遍 `dsh --version`。
2. 将桥接按内容哈希发布到独立、不可变的版本目录；安装包升级后，下次启动会自动采用新插件。
3. 检查目标地址的桥接协议与内容版本；完全一致时复用现有 DSH，不会重启它。
4. 地址无人监听时启动 `dsh web`：托盘立即出现，桥接就绪后再打开页面。工作目录是数据目录下的 `dsh-workspace`，避免把安装包/仓库当成工作区扫一遍。选择框弹出时会在后台预热 DSH；托盘「应用或重新应用」在 DSH 未启动时会拉起它，网页已关掉时会重新打开页面。托盘已在运行但 DSH 已退出时，再次点击 beautiCode 会重新拉起 DSH，而不是只打开一个连不上的页面。
5. 同一时刻只允许一个启动器拉起 `dsh web`。端口已开但桥接还没就绪时会等待并复用，而不是立刻报失败或再起一个进程。启动失败若是端口冲突或配置文件被锁，会改等现有进程或重试一次。
6. 若端口已有旧桥接、或页面已能打开但始终没有当前 beautiCode 桥接，停止并给出错误；不会中断现有会话。用户关闭该 DSH 后再次启动即可加载新插件。
7. 每 24 小时最多查询一次 npm 最新版本。只提示新版本，不会把未经回归验证的 DSH 自动升级为兼容版本。该检查在页面打开之后才跑，不挡启动。Node 编译缓存在数据目录的 `node-compile-cache`，第二次冷启动会更快。

可选参数：

```powershell
# 使用其他本机端口和数据目录
.\scripts\start-beauticode-dsh.ps1 -DshUrl http://127.0.0.1:31880 -DataRoot C:\beautiCode-data

# 只确保桥接已启动，不打开浏览器和托盘（诊断/自动化）
.\scripts\start-beauticode-dsh.ps1 -NoBrowser -EnsureBridgeOnly

# 输出本地、兼容、npm 最新及正在运行的桥接版本（JSON）
.\scripts\start-beauticode-dsh.ps1 -VersionOnly

# 离线启动，不查询 npm 最新版本
.\scripts\start-beauticode-dsh.ps1 -NoVersionCheck
```

退出 beautiCode 托盘不会结束由启动器创建的 DSH 进程，避免中断 DSH 中的工作；再次运行启动器会复用它。

## 手动启动

如需自行管理 DSH，可参考 [`integrations/deepseek-harness/cordis.patch.example.yml`](../integrations/deepseek-harness/cordis.patch.example.yml)，把其中的文件 URL 改为本机 `index.mjs` 的绝对地址，再运行：

```powershell
dsh.cmd web --patch C:\完整路径\beauticode.patch.yml --port 3080
```

自定义 beautiCode 数据目录时，DSH 进程与托盘必须使用同一个 `BEAUTICODE_DATA_ROOT`，否则令牌文件不一致。

## 安全边界

- DSH 地址只接受 `http://127.0.0.1`、`http://localhost` 或 `http://[::1]`。
- 控制请求使用数据目录内的 256 位随机令牌；浏览器回执只接受同源请求。
- 图片与 MP4 由随机端口的本机媒体服务提供，URL 带不可预测令牌并校验 DSH 页面来源。
- 只有浏览器真实加载/解码媒体并回执后，应用事务才成功；否则磁盘状态回滚。
- 自动化测试不能替代发布前的真实 DSH 页面可见性验收。

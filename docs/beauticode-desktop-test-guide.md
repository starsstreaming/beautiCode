# beauticode-desktop 0.1.0-test.2 使用指南

这是一份面向 Windows 测试人员的本地测试包指南。内容以当前 test.2 包内的 CLI、运行时和宿主适配器实现为准；它不是公开发布说明，也不是签名安装器说明。

> **安全边界**
>
> status 是只读检查。npm install、install、uninstall 和版本切换会写入用户机器。操作某个宿主前，应先正常关闭该宿主及托盘窗口，并等待自己的 beautiCode runner 退出；不要手工强杀进程，不要改官方应用、app.asar、图标或快捷方式。第一次启动仍使用宿主原有图标，由用户主动启动。

## 1. 测试包信息

- 包名：beauticode-desktop
- 版本：0.1.0-test.2
- 平台：Windows only（package.json 的 os 为 win32）
- Node.js：>=22
- 绝对路径：
  C:\Users\29468\.codex\worktrees\cursor-doubao-backgrounds\beautiCode\artifacts\beauticode-desktop-0.1.0-test.2.tgz
- 文件大小：31,261,862 bytes
- SHA-256：5E0F109767C809AF6F6A7C2C1C8E627BD9FFD6DF24E474CE463712AD459B5030
- 打包记录：150 个文件，解包约 32.5 MB
- 发布状态：未公开发布，仅供本机本地测试。

聚合包自带 bin、src 和 DSH、Codex、WorkBuddy、Cursor、Doubao 五类运行时。使用已安装的 CLI 不需要仓库源码、workspace package 或临时 staging 目录。不要改写现有 tgz、版本或上述 SHA-256。

## 2. Windows/Node 前置条件

1. Windows 10/11，使用 PowerShell 或等价 Windows shell。
2. node --version 为 v22 或更高，npm --version 可用。
3. 要操作的宿主已经安装，并且当前用户可写其用户配置、启动项或 DSH 配置。
4. 预留一个可恢复的测试窗口。只运行 status 不要求关闭客户端；安装、卸载、升级和切换包前，按宿主单独正常关闭客户端与托盘窗口。
5. 包不会自动安装五个宿主、替换原图标/快捷方式或修改官方应用文件。DSH 仍由用户按其正常方式启动。

没有必要使用 pnpm，也不要从临时解包目录持久启动 runner。

## 3. 校验 SHA-256 与安装

先校验本地包。以下命令只读，不修改用户机器：

~~~powershell
$tgz = 'C:\Users\29468\.codex\worktrees\cursor-doubao-backgrounds\beautiCode\artifacts\beauticode-desktop-0.1.0-test.2.tgz'
(Get-FileHash -Algorithm SHA256 -LiteralPath $tgz).Hash
~~~

输出必须逐字等于：

~~~text
5E0F109767C809AF6F6A7C2C1C8E627BD9FFD6DF24E474CE463712AD459B5030
~~~

不一致时停止，不要安装；确认路径、文件完整性以及文件名是否确为 test.2。

校验通过后执行：

~~~powershell
npm install -g --ignore-scripts 'C:\Users\29468\.codex\worktrees\cursor-doubao-backgrounds\beautiCode\artifacts\beauticode-desktop-0.1.0-test.2.tgz'
~~~

此命令会写入 npm 全局 prefix，因而会修改用户机器。--ignore-scripts 只表示跳过 npm lifecycle scripts，不代表后续宿主接线是只读的。包本身没有依赖仓库源码的安装步骤。

安装后查看实际帮助：

~~~powershell
beauticode-desktop --help
~~~

如果命令未找到，检查 npm prefix -g 对应的全局 bin 是否在 PATH；不要为了绕过 PATH 下载另一个同名版本。

## 4. CLI 格式与五宿主差异

CLI 实际语法：

~~~text
beauticode-desktop <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall>
~~~

无参数、--help、-h 会显示帮助；未知宿主、未知命令或多余参数会报错并以非零退出。

| 宿主 | install 会做什么 | status | uninstall 会做什么 |
| --- | --- | --- | --- |
| dsh | 调用包内 DSH 接线，写入托管 plugin/profile wiring；不启动 DSH | 只查运行时和接线标记 | 移除托管接线，不以卸载为名删除媒体 |
| codex | 安装包内 Codex plugin、Windows 自启动 watcher 等接线 | 只查运行时和 plugin 标记 | 移除托管 watcher/自启动，不替换 Codex 应用 |
| workbuddy | 写入端口/环境配置、自启动和自己的 runner，并启动 runner | 查接线、runner/CDP 等状态 | 移除自己的 runner、自启动和托管端口，不启动或卸载 WorkBuddy |
| cursor | 写入自启动并启动自己的 runner，不主动启动 Cursor | 查接线、runner/CDP 等状态 | 停止/移除自己的 runner 和自启动，保留主题/媒体 |
| doubao | 写入自启动并启动自己的 runner，不主动启动 Doubao | 查接线、runner/CDP 等状态 | 停止/移除自己的 runner 和自启动，保留主题/媒体 |

聚合 status 不启动子进程。install/uninstall 调用已安装包内 route script，并设置包内运行时标记，不回退到源码 workspace。宿主 setup 可能写启动项、环境变量或 watcher，所以 install/uninstall 均是机器变更操作。

推荐逐宿主执行以下顺序：

~~~powershell
beauticode-desktop dsh status
beauticode-desktop codex status
beauticode-desktop workbuddy status
beauticode-desktop cursor status
beauticode-desktop doubao status
~~~

然后一次只处理一个宿主：正常退出它，执行 install，再执行 status，最后从原图标主动启动客户端并等待 runner 探测。结束测试时先正常退出客户端，再执行 uninstall。不要执行 taskkill /F、不要手工删除 PID 文件，也不要杀掉不确定归属的进程；setup 只应处理它识别出的自身 runner。

## 5. 各宿主实际命令和语义

### 5.1 DSH

聚合入口：

~~~powershell
beauticode-desktop dsh install
beauticode-desktop dsh status
beauticode-desktop dsh uninstall
~~~

DSH install 调用包内 DSH CLI 的托管接线，可能修改 DSH profile/plugin 文件，但不会替用户运行 dsh web。接线后由用户自行启动，例如：

~~~powershell
dsh web
~~~

仓库文档还记录 npx @deepseek-ai/dsh web 和 npx beauticode-dsh 等 DSH 自身入口；它们不是聚合包自动安装机制，是否可用取决于本机 DSH 版本。DSH status 只读；uninstall 只移除 beautiCode 托管接线，不应删除用户媒体和主题。

### 5.2 Codex

~~~powershell
beauticode-desktop codex install
beauticode-desktop codex status
beauticode-desktop codex uninstall
~~~

Codex 使用 loopback CDP，首选端口 9335，不绑定 LAN。target 必须是 Codex/ChatGPT 实际应用页面，不是任意网页。watcher 不会因为客户端不存在就自行启动 Codex；在原图标启动新的主进程、且短时间内没有 CDP 时，才可能按受控逻辑处理一次连接修复。用户主动关闭客户端后，watcher 应保持关闭，不替用户重启。

Codex install 会写入用户侧 plugin/自启动 watcher，是修改操作；status 只读。当前测试记录明确：Codex 活动运行态尚未热更新，不能把 test.2 安装成功误认为当前会话已载入新代码。需要验证 Codex 时，应安排独立、可接受重启的维护窗口，不要在有未保存工作的会话中直接安装接线。

### 5.3 WorkBuddy

聚合入口：

~~~powershell
beauticode-desktop workbuddy install
beauticode-desktop workbuddy status
beauticode-desktop workbuddy uninstall
~~~

仓库开发时的直接 setup 格式：

~~~powershell
node scripts/wb-setup.mjs install
node scripts/wb-setup.mjs status
node scripts/wb-setup.mjs uninstall
~~~

WorkBuddy 使用 WORKBUDDY_REMOTE_DEBUGGING_PORT。默认优先考虑 9335，端口冲突时使用受限本地候选（包括 9336）；以 status 和实际 CDP 探测结果为准。target 是测得的 WorkBuddy renderer 页面，不能只凭端口号认定身份。若发现明确 foreign CDP identity，runner 应跳过错误的 settling/reconnect 路径；用户关闭 WorkBuddy 且没有主进程时，不应把它重新打开。

Windows setup 管理自己的 Startup VBS 和 runner。uninstall 移除自己的接线和托管端口设置，但不卸载 WorkBuddy、不删除主题/媒体。只有客户端已正常关闭时才做安装、升级或卸载。

### 5.4 Cursor

聚合入口：

~~~powershell
beauticode-desktop cursor install
beauticode-desktop cursor status
beauticode-desktop cursor uninstall
~~~

仓库开发时的直接 setup 格式：

~~~powershell
npm run cursor:setup -- install
npm run cursor:setup -- status
npm run cursor:setup -- uninstall
~~~

Cursor 默认 CDP 端口 9341，受限候选为 9351、9361、9371。runner 会验证准确的 Cursor workbench target（测得的 vscode-file://...workbench.html 页面），不会仅凭通用浏览器页面注入。install 只注册/启动后台 runner，不主动打开 Cursor；用户从原图标启动后，如果是新主进程且短时间内没有 CDP，适配器才可能执行一次受控重启以补上 CDP。用户有意关闭 Cursor 后，runner 应等待而不重新启动它。

### 5.5 Doubao

聚合入口：

~~~powershell
beauticode-desktop doubao install
beauticode-desktop doubao status
beauticode-desktop doubao uninstall
~~~

仓库开发时的直接 setup 格式：

~~~powershell
npm run doubao:setup -- install
npm run doubao:setup -- status
npm run doubao:setup -- uninstall
~~~

Doubao 默认 CDP 端口 9342，受限候选为 9352、9362、9372。target 必须匹配 doubao://doubao-chat/chat，不是任意 Electron 页面。UI 锚点是“更多”中的“自定义背景”。安装和首次连接遵循 Cursor 的原图标启动、短窗口受控重启和主动关闭保持关闭语义。

## 6. UI 入口、导入、主题和皮肤中心

当前实现记录的入口如下：

- DSH：设置中的“背景”；仓库文档还记录 /bg、/bg-theme、/bg-clear。
- WorkBuddy：侧栏/背景区域的自定义背景入口，可导入图片或视频，保存主题并切换声音。
- Cursor：注入 workbench UI 提供 Background/背景入口，前提是准确 target 已连接。
- Doubao：点击“更多”进入“自定义背景”，前提是 doubao://doubao-chat/chat target 已连接。

### 6.1 媒体格式和主题名

本地图片实现识别 png、jpg/jpeg、webp、gif、bmp、avif；视频主要验证 mp4、mov，界面还识别 webm、m4v。扩展名被识别不等于宿主 WebView 一定支持该容器或编解码器。

Cursor/Doubao 本地主题名校验为 1–80 个字符。其他宿主也建议使用短、可读且不含控制字符的名称。媒体加载成功后才写入主题状态。已保存主题会记录名称、类型和原始路径；源文件移动/删除后应显示不可用，而不是静默制造副本。清除当前背景不会删除保存的主题或用户媒体。

### 6.2 hnnulwh 与皮肤中心

本地 UI 包含 beautiCode 皮肤中心相关入口。来自 hnnulwh 的皮肤保留来源标识，并使用皮肤自身名称，不强行改成本地文件名。皮肤中心资源是否可见取决于批准目录/资源的可访问性；测试包不保证外部目录长期可用，也不会把外部资源安装成官方宿主文件。

### 6.3 大视频、首帧和声音

视频使用 poster/首帧优先、再等待视频就绪的策略。大文件或冷启动时可能先看到 poster，不能承诺立即播放。加载失败、超时或过期事件会回退或保持原背景，避免半加载状态覆盖现有背景。视频默认遵循静音、循环、playsinline 等浏览器约束；声音需要用户在 UI 中打开，自动播放仍受宿主 WebView 策略影响。

文件仍会经过大小、容器和可播放性校验；大视频失败时先用小 MP4/MOV 复现并保留错误信息，不要改扩展名或替换官方资源。DSH 与各宿主的上限和编解码能力并不完全相同。

## 7. 状态、媒体路径和不删除用户数据原则

路径可能受 LOCALAPPDATA、APPDATA、DSH_HOME 或测试变量影响；排障时可用，分享前必须脱敏：

- DSH：DSH_HOME（未设置时通常是用户目录下的 .dsh）中的 profile/plugin wiring。
- Codex：%LOCALAPPDATA%\beautiCode\codex-plugin 及 watcher/lock 状态。
- WorkBuddy：%APPDATA%\beauticode\state.json、%APPDATA%\beauticode\themes，以及 WorkBuddy 端口/启动配置。
- Cursor：%LOCALAPPDATA%\beauticode\hosts\cursor\state.json 及其主题/runner 状态。
- Doubao：%LOCALAPPDATA%\beauticode\hosts\doubao\state.json 及其主题/runner 状态。
- Windows 启动项：%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup 下由 setup 管理的 beautiCode runner VBS。
- runner 日志：通常在 %LOCALAPPDATA%\beautiCode\logs 或对应 host 数据目录，具体以当前运行时和 status 为准。

媒体和主题按本地路径保存；安全边界是 loopback CDP、无 LAN 绑定、无媒体字节遥测。uninstall 只应移除 beautiCode 自己的接线、runner 和启动项，保留用户媒体、主题状态及官方宿主安装。不要手工删除上述目录来“清理”，也不要删除不确定归属的 VBS/PID 文件。

## 8. 排障

### 8.1 SHA 不一致或安装了旧测试包

停止安装，重算 SHA-256，确认文件名为 0.1.0-test.2.tgz。检查全局实际版本：

~~~powershell
npm list -g --depth=0 beauticode-desktop
~~~

确需切换时，先正常关闭受影响宿主和自己的 runner，再执行 npm uninstall -g beauticode-desktop，随后安装已校验的目标 tgz。这两个命令都会修改全局 npm 目录；不要让旧 test.1 的 CLI 路径和 test.2 混用。

### 8.2 端口被占用或 target 不匹配

先运行对应宿主 status，确认端口和 target。仅检查 loopback 监听可用：

~~~powershell
Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1
~~~

WorkBuddy/Cursor/Doubao 有各自受限候选端口；不能通过任意 LAN 地址解决冲突。Codex 与 WorkBuddy 可能竞争 9335，最终以明确 CDP identity 为准。不要手工 taskkill、删除 PID 文件或杀掉不确定归属的客户端；先正常退出客户端，再让对应 setup 处理自己的 runner。

### 8.3 UI 入口没有出现

确认 install 成功，随后同一宿主 status 没有报告缺少 runtime/接线；确认宿主从原图标启动并给 runner 足够探测时间；确认宿主版本仍提供对应页面/菜单。Cursor/Doubao 必须是准确 workbench/ doubao://doubao-chat/chat 页面；Codex 当前活动会话不应假设已经热更新。

### 8.4 runner 没有运行

先正常关闭目标宿主，重新执行对应 status；必要时在维护窗口执行该宿主 install，不要从临时目录复制启动脚本。只读查看本地 runner 日志；失败时保留退出码、脱敏 status、runner PID/端口和日志尾部给维护者，避免自行杀进程。

### 8.5 日志和反馈材料脱敏

删除或替换账号 URL、工作区路径、媒体绝对路径、token、cookie、Authorization 头、完整 CDP URL 和不必要的 PID。保留包版本/SHA、命令和退出码、status 的非敏感字段、宿主/端口、时间线、媒体扩展名与大致大小、脱敏后的最后 50–100 行错误文本。

## 9. 测试步骤与反馈

### 9.1 不启动宿主的 smoke test

~~~powershell
Get-FileHash -Algorithm SHA256 -LiteralPath $tgz
npm install -g --ignore-scripts $tgz
beauticode-desktop --help
beauticode-desktop dsh status
beauticode-desktop codex status
beauticode-desktop workbuddy status
beauticode-desktop cursor status
beauticode-desktop doubao status
~~~

哈希、help、五个 status 是只读；npm install 会改全局 npm 目录。要继续做宿主行为测试，先按宿主关闭客户端，一次只 install 一个宿主。

### 9.2 单宿主 UI smoke test

对目标宿主依次执行 install、status，从原图标启动并确认入口；导入小图片，再导入短 MP4/MOV，保存短主题名，切换后清除，再重新打开 UI 确认状态。测试结束先正常关闭客户端，再 uninstall，确认媒体和保存主题仍在。不要用有未保存工作的会话做强制重启测试。

### 9.3 已有验证证据

本 test.2 包已完成的仓库级验证：

- Codex、WorkBuddy、desktop-cdp、Cursor、Doubao 相关测试均通过。
- 全量 npm test：283 passed，0 failed，0 skipped。
- 聚合包测试：11/11 通过。
- npm run typecheck：通过。
- git diff --check：通过。

这些是源码/打包验证，不等同于五个宿主都在活动会话完成热更新。当前本机实际运行态覆盖了空闲 WorkBuddy、Cursor、Doubao；Codex 活动运行态尚未热更新。

## 10. 版本局限

- 仅 Windows，要求 Node.js >=22。
- 0.1.0-test.2 是本地未公开测试包，没有公开 registry 发布承诺，也不是签名安装器。
- 不自动安装 DSH、启动五个宿主、替换原图标/快捷方式或修改官方应用文件。
- status 只读；全局 npm 安装、宿主 install/uninstall 和版本切换会修改用户机器。
- CDP 仅限 loopback；端口号不是身份，必须同时验证准确 target。
- 宿主页面文案、target URI、WebView 编解码能力可能随宿主升级变化；皮肤中心资源也可能不可用。
- 大视频受媒体校验、容器/编解码和宿主播放策略影响，不能承诺所有格式、大小或机器立即播放。
- uninstall 以保留用户数据为设计边界，但测试前仍应备份重要主题和媒体。
- 当前空闲宿主部署证据不代表 Codex 活动会话已热更新；Codex 应安排独立维护窗口验证。

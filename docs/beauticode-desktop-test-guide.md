# beauticode-desktop 0.1.0-test.2 Windows 测试指南

本文对应测试包 beauticode-desktop@0.1.0-test.2。它是 Windows-only 的聚合测试包，内置 DSH、Codex Desktop、WorkBuddy、Cursor、豆包五套已编译运行时；安装后不需要 beautiCode 源码仓库、workspace package 或 pnpm。

这是测试版操作说明，不代表正式发布承诺。请先在非关键环境验证；宿主客户端升级后，DOM 锚点、CDP 行为或启动参数可能变化。

## 1. 包、路径与校验

从当前工作区取得的 tgz：

~~~text
C:\Users\29468\.codex\worktrees\cursor-doubao-backgrounds\beautiCode\artifacts\beauticode-desktop-0.1.0-test.2.tgz
~~~

SHA-256（应完全一致）：

~~~text
5E0F109767C809AF6F6A7C2C1C8E627BD9FFD6DF24E474CE463712AD459B5030
~~~

在 PowerShell 中核对（Get-FileHash 只读）：

~~~powershell
$pkg = 'C:\Users\29468\.codex\worktrees\cursor-doubao-backgrounds\beautiCode\artifacts\beauticode-desktop-0.1.0-test.2.tgz'
$expected = '5E0F109767C809AF6F6A7C2C1C8E627BD9FFD6DF24E474CE463712AD459B5030'
$actual = (Get-FileHash -LiteralPath $pkg -Algorithm SHA256).Hash
$actual
if ($actual -ne $expected) { throw "SHA256 不匹配：$actual" }
~~~

## 2. Windows / Node 前置条件

- Windows（包的 os 字段为 win32）。
- Node.js >=22，且 node、npm 在当前 PowerShell 的 PATH 中。
- 测试宿主客户端需由用户自己安装并能正常启动；DSH 还需要可运行自己的 dsh web。
- Cursor、豆包、WorkBuddy、Codex 的本地 CDP/客户端启动行为由宿主版本决定。已测量的 Cursor 基准为 3.18.9、豆包基准为 2.29.12；升级客户端后要把失败视为契约漂移，不要用模糊选择器强行注入。
- 网络只在皮肤中心下载已批准资源时需要；本地图片/视频导入不应依赖公网。

检查版本：

~~~powershell
node --version
npm --version
~~~

## 3. 安装测试版 CLI

npm install -g --ignore-scripts 会修改当前用户的 npm 全局目录（写入包文件和 beauticode-desktop 命令），因此这是有副作用的命令；不会修改宿主客户端安装目录。使用本地 tgz，不要把测试包误当成 registry 正式版本：

~~~powershell
npm install -g --ignore-scripts 'C:\Users\29468\.codex\worktrees\cursor-doubao-backgrounds\beautiCode\artifacts\beauticode-desktop-0.1.0-test.2.tgz'
~~~

确认命令解析到预期全局安装：

~~~powershell
Get-Command beauticode-desktop
beauticode-desktop --help
~~~

预期帮助文本只接受下面的二级命令，不要自行添加 --host、--port 等参数：

~~~text
beauticode-desktop <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall>
~~~

卸载 CLI 本身（可选，会修改 npm 全局目录；不会按宿主卸载后台接线）：

~~~powershell
npm uninstall -g beauticode-desktop
~~~

## 4. CLI 命令与副作用总览

~~~text
beauticode-desktop <host> install
beauticode-desktop <host> status
beauticode-desktop <host> uninstall
~~~

| 命令 | 是否修改系统 | 含义 |
| --- | --- | --- |
| status | 否（只读） | 读取包内运行时文件和宿主接线标记，输出 JSON；不会启动、重启、停止宿主或守护。它不等于 CDP 页面已连接。 |
| install | 是 | 调用对应包内 runtime，可能写用户配置/启动项、写状态目录并启动 beautiCode 守护；不修改官方宿主安装文件。 |
| uninstall | 是 | 调用对应 runtime 移除 beautiCode 自己的接线/启动项；不会删除用户原始媒体。由脚本管理的 beautiCode 守护会按宿主实现停止。 |

建议先逐宿主执行一次 status，保存原始 JSON；测试结束后对同一宿主执行 uninstall。不要用 taskkill /F、结束任务树或强杀官方客户端；如果需要关闭宿主，请从宿主自己的菜单或原始图标正常退出。

## 5. 五宿主测试矩阵

| 宿主 | 安装 | status 重点 | 卸载及保留内容 | 主要系统接线 |
| --- | --- | --- | --- | --- |
| DSH | beauticode-desktop dsh install | 聚合 CLI 的 runtimeReady、installed；不证明 DSH web 已加载插件 | beauticode-desktop dsh uninstall；移除插件/patch 接线，保留 beautiCode 数据 | 用户 DSH profile 的插件目录和 cordis.patch.yml |
| Codex | beauticode-desktop codex install | 检查 codex-plugin\codex-watchdog.mjs 标记；不证明当前 Codex 已连 CDP | beauticode-desktop codex uninstall；取消开机自动注入，保留常驻目录和用户数据 | HKCU Run\BeautiCodeCodex、Codex watcher 目录 |
| WorkBuddy | beauticode-desktop workbuddy install | 检查包内运行时和 beauticode-wb-runner.vbs 标记；不证明 CDP 在线 | beauticode-desktop workbuddy uninstall；移除守护、自启和用户 CDP 环境变量，保留数据 | WORKBUDDY_REMOTE_DEBUGGING_PORT、启动文件夹 VBS |
| Cursor | beauticode-desktop cursor install | 检查 beauticode-cursor-runner.vbs 标记；不证明目标页契约匹配 | beauticode-desktop cursor uninstall；停止受管理 runner、清理注入并删除自启，保留 state/媒体 | 启动文件夹 VBS |
| 豆包 | beauticode-desktop doubao install | 检查 beauticode-doubao-runner.vbs 标记；不证明目标页契约匹配 | beauticode-desktop doubao uninstall；停止受管理 runner、清理注入并删除自启，保留 state/媒体 | 启动文件夹 VBS |

逐项 smoke 命令（status 不会写入用户状态）：

~~~powershell
beauticode-desktop dsh status
beauticode-desktop codex status
beauticode-desktop workbuddy status
beauticode-desktop cursor status
beauticode-desktop doubao status
~~~

聚合状态 JSON 字段为 host、runtimeReady、missingRuntime、installed。只要 runtimeReady 为 false，先停止测试并重新安装同一个 tgz；不要从 installed=true 推断页面注入成功。

## 6. DSH 的特殊方式

DSH 是用户自主管理的宿主，不走 Chromium CDP。dsh install 调用包内 runtime\dsh\bin\beauticode-dsh 的默认安装流程：复制包内插件到 DSH profile，并写入 beautiCode bridge patch；不需要 pnpm，不需要另跑 dsh plugin add，也不会启动、重启或接管你的 DSH。

安装后按用户自己的方式启动：

~~~powershell
dsh web
~~~

如果 dsh 没在 PATH，使用用户已有的 npx @deepseek-ai/dsh web。在 DSH 设置中应出现「背景」页；也可以使用已实现的 /bg、/bg-theme、/bg-clear 或对应对话工具。网页未运行、插件未加载或 live verify 失败时，应用会失败并回滚，不要把托盘/CLI 的连接失败当成 DSH 安装损坏。

dsh uninstall 通过包内 CLI 的 --remove 只移除 beautiCode 自己写入的 bridge、插件目录和相关 web package 接线；不要手工编辑或删除整个 ~/.dsh。若 DSH web 正在运行，先从 DSH 正常退出并重新打开以确认页面状态。

## 7. 原图标启动、兜底重启与主动关闭语义

这些规则是本测试版的重要验收项：

1. install 注册的是 beautiCode 自己的登录守护；守护不会因为宿主不存在就无限拉起宿主。
2. 用户从 Cursor、豆包或 WorkBuddy 的原始图标启动后，守护只对“唯一、刚创建（约 10 秒内）、且没有 CDP 参数”的新主进程做一次受控修复重启，然后连接 loopback CDP。已有 CDP 参数的进程不会被二次重启。
3. Codex watcher 也只在原图标产生上述新主进程且缺少 loopback CDP 时做一次 repair；它不会因为 Codex 当前不在运行而主动打开 Codex。
4. 用户从宿主自己的菜单/原始窗口主动关闭后，守护进入等待，不会把宿主重新打开。请用正常关闭路径验收这一点。
5. DSH 不参与上述重启规则：beautiCode 永远不启动、不重启 DSH；DSH 必须由用户运行 dsh web。

验收建议：先正常安装并退出；再点击原始图标启动，等待注入；随后从宿主自己的关闭入口退出，观察它保持关闭。不要为了“加快测试”结束官方进程或使用强制杀进程命令。

## 8. 背景导入、主题与 hnnulwh 皮肤中心

以下是当前代码和既有宿主契约已确认的行为：

- Cursor 的入口是 background，紧跟 Customize；豆包的入口是 自定义背景，紧跟 更多；WorkBuddy 侧栏入口是「自定义背景」。DSH 在设置页提供「背景」页。
- Windows 桌面宿主使用带 TopMost owner 的原生文件选择器；当前过滤的本地格式为 png/jpg/jpeg/webp/gif/bmp/avif/mp4/mov/webm/m4v。单文件导入，文件对话框要求文件存在。
- 本地导入先检查扩展名、容器/媒体类型、普通文件和稳定文件身份；符号链接、替换中的文件、缺失路径或不支持格式应失败关闭。成功后才写主题状态。
- WorkBuddy、Cursor、豆包桌面 runner 将本地文件路径交给页面文件输入（DOM.setFileInputFiles），不会把整个大视频读进守护进程内存；浏览器负责解码。因此大视频仍可能受宿主解码能力、磁盘和页面加载时间影响，但不应以“守护进程把整个视频读入内存”作为预期。
- 桌面本地主题保存名称、类型和原始路径；不要在测试后移动或删除原文件。原文件移动/删除后，恢复或再次应用应报告不可用/失败，而不会伪造成功；清除背景不会删除已保存主题或原始媒体。
- DSH/Codex 的核心事务会对媒体做校验、阶段提交和 live verify；测试时以宿主页面“已加载/已回执”为成功条件，失败应回滚，不要仅凭磁盘上有 manifest 就判定成功。
- 皮肤中心的来源固定为 https://hnnulwh.cn。运行时不接受环境变量或配置把来源替换掉；只有具备安全 ID、名称、image/video 类型、可信来源修订标识且 status: approved 的条目才显示。目录读取或资源校验失败时应 fail-closed（空列表/错误），不要手工放宽来源校验。
- 选择皮肤后，桌面 runner 会将已批准资源下载到每个宿主的 beautiCode 数据目录再应用；皮肤名称和来源 provenance 随主题保存。不要把皮肤中心下载的临时目录当作用户原始媒体目录。

## 9. 状态、数据和日志位置

以下 %LOCALAPPDATA%、%APPDATA% 是当前 Windows 用户环境变量；实际路径以运行时输出为准。

| 宿主 | 状态/主题位置 | 日志/诊断 |
| --- | --- | --- |
| DSH | %LOCALAPPDATA%\beautiCode\hosts\dsh\（未设置 LOCALAPPDATA 时回退到包实现的用户目录）；active、saved、runtime-media、logs 等目录按核心数据布局管理 | %LOCALAPPDATA%\beautiCode\hosts\dsh\logs\，其中可见导入计时等日志；DSH 本身的终端输出仍由 dsh web 负责 |
| Codex | %LOCALAPPDATA%\beautiCode\hosts\codex\；常驻运行时代码在 %LOCALAPPDATA%\beautiCode\codex-plugin\ | %LOCALAPPDATA%\beautiCode\codex-plugin\watch.log |
| WorkBuddy | %APPDATA%\beautiCode\state.json、workbuddy-port.json；主题/背景状态由 runner 和适配器维护 | %LOCALAPPDATA%\beautiCode\logs\wb-runner.log |
| Cursor | %LOCALAPPDATA%\beautiCode\hosts\cursor\state.json、runner.pid | %LOCALAPPDATA%\beautiCode\hosts\cursor\runner.log |
| 豆包 | %LOCALAPPDATA%\beautiCode\hosts\doubao\state.json、runner.pid | %LOCALAPPDATA%\beautiCode\hosts\doubao\runner.log |

日志可能包含页面路径或错误上下文。反馈前只截取与复现步骤相关的几行，先脱敏用户名、绝对路径、账号标识、查询参数、token、端口和本地媒体文件名；不要上传整个数据目录、dsh-bridge.token、控制文件或原始媒体。

## 10. 排障顺序

### beauticode-desktop 找不到或版本不对

~~~powershell
Get-Command beauticode-desktop
npm prefix -g
node --version
~~~

重新用第 1 节的绝对路径核对 SHA-256，再执行 npm install -g --ignore-scripts <绝对 tgz 路径>。不要把 npm install 的 registry 缓存包当成这个本地测试包。

### runtimeReady=false

这表示包内文件缺失或安装不完整，不是宿主 CDP 问题。保留 status JSON，卸载并重新安装同一个 tgz；不需要删除 %LOCALAPPDATA%\beautiCode 用户媒体目录。

### installed=false 或安装后没有入口

先确认目标宿主已经正常启动一次，并查看对应自启/patch 文件是否由当前用户目录产生。Cursor/豆包/WorkBuddy 的入口要求目标页面契约匹配；宿主升级后可能 fail-closed。DSH 则检查 DSH profile 的 patch 与「设置 → 背景」，不要删除整个 DSH profile。

### CDP 离线、目标页不存在或页面未注入

确认宿主由原始图标启动、不是旧的手工调试实例；确认只绑定 127.0.0.1；正常关闭宿主后再从原始图标打开。对于 Codex，先看 watch.log 和 beauticode codex status；对于 Cursor/豆包，看各自 runner.log。不要把 CDP 端口开放到 0.0.0.0，也不要扫描任意 LAN 地址。

### 媒体导入失败、视频加载失败或主题不可用

先换一个小的本地 PNG 验证入口和页面，再验证 MP4。确认扩展名、文件确实存在、没有被同步软件替换，且导入期间不要移动/重命名原文件。大视频失败时保留错误时间点和脱敏后的相关日志；不要把原视频上传到反馈渠道。缺失原文件是预期的 fail-closed 场景，清除背景后重新选择有效文件即可。

### 皮肤中心为空或下载失败

确认可访问固定来源 https://hnnulwh.cn，记录脱敏错误；不要设置替代域名、改环境变量或绕过 approved/来源校验。先用本地媒体导入排除 CDP 与页面问题。

### 守护重复、锁冲突或卸载后仍有旧页面

同一宿主只保留一套 beautiCode watcher/runner。先退出托盘或其他 beautiCode 控制端，再通过对应 uninstall 清理自启接线，并用宿主原生 UI 正常关闭后重开。不要手动强杀进程；如果锁文件仍显示活动 owner，只在确认 owner 已经正常退出后，把脱敏的状态和日志交给维护者判断。

## 11. 测试版与 Codex 当前运行态限制

- 0.1.0-test.2 是本地 tgz 测试包；npm install -g 只更新 CLI 和包内运行时文件，不会把改动热注入已经运行的 Codex Desktop、其他宿主页面或已启动 watcher。
- Codex install 会把 watcher/runtime 复制到 %LOCALAPPDATA%\beautiCode\codex-plugin。已经运行的 watcher 可能继续使用旧的已加载代码；升级测试包后，应按正常流程执行 beauticode-desktop codex uninstall，安装新 tgz，再正常打开/关闭 Codex 或重新执行 beauticode-desktop codex install，用 watch.log 和页面入口确认新运行态。
- codex uninstall 的公开语义是取消开机自动注入；不要把它理解成强制终止当前 Codex 或删除所有用户数据。当前 Codex/旧 watcher 请通过正常应用退出路径结束。
- 当前运行的 Codex 页面不会因为 npm install 自动刷新 CSS、UI、皮肤中心或 adapter。需要验证新包时必须在正常宿主生命周期后重新观察，不要用强杀命令制造“已更新”的假象。

## 12. 脱敏反馈模板

~~~text
包版本：beauticode-desktop@0.1.0-test.2
Windows 版本：<仅填大版本/构建号，勿填用户名>
Node：<node --version>
宿主及版本：<dsh/Codex/WorkBuddy/Cursor/豆包 + 版本>
命令：<install/status/uninstall；省略用户路径和 token>
现象：<入口、是否 CDP 在线、是否主动关闭后保持关闭>
复现时间：<本地时间>
状态 JSON：<仅 host/runtimeReady/missingRuntime 数量/installed，移除绝对路径>
日志片段：<3–10 行，移除用户名、绝对路径、URL query、token、账号和媒体文件名>
~~~

本指南只覆盖测试包实际暴露的 dsh|codex|workbuddy|cursor|doubao 与 install|status|uninstall 合约；需要更底层的 runner 参数或源码开发流程时，请回到仓库内对应宿主文档，不要把未公开参数当作稳定 CLI 接口。

# Codex 守护恢复与健康检查设计

## 目标与范围

Windows 上，beautiCode 的 Codex 外层守护即使意外退出，也应在同一登录会话内由操作系统有界地恢复。`status` 继续只表示包文件与安装接线；新增只读的 `codex health`，让用户区分守护、宿主 CDP、主页面和背景入口的状态。Codex 原始图标、官方程序及其启动参数不改；主动关闭 Codex 后绝不将其重新打开。既有 10 秒新进程修复窗口不放宽。

本设计只处理 Codex，不扩展到其他宿主、不自动注入所有窗口、不把“已安装”重新定义为“已生效”。Windows 之外保持现有行为并明确返回不支持的健康检查结果。

## 已确认的故障边界

`cli.js` 当前写入 `HKCU Run` 并即时启动 `codex-watchdog.mjs`。watchdog 能以 1 秒间隔恢复内部 `watch-host.mjs`，但 watchdog 本身退出后没有同一会话的恢复机制。聚合包 `getHostStatus()` 只读运行时文件与安装标记。`launch.ts` 刻意只对年龄小于 10 秒的唯一新主进程进行 CDP 修复。主页面目标选择器目前只选一个得分最高的页面。因此，守护晚于 Codex 30 秒启动时，安全的结果应是“宿主运行中、CDP 缺失、需用户操作”，而非后台强制重启。

## 生命周期设计

安装器使用当前用户、最低权限的 Windows 计划任务作为唯一开机接线。任务只在登录时触发，不配置周期触发；`ExecutionTimeLimit` 为无限，`MultipleInstances` 为 `IgnoreNew`，进程意外失败时由任务自身按有界次数和间隔重启。任务 action 指向包安装后的稳定 launcher，由 launcher 等待外层 watchdog 退出，并将异常退出码传给任务；隐藏启动且不得弹出周期性控制台。内部 `watch-host` 仍由现有 watchdog 恢复，不让任务管理内部子进程。

外层 watchdog 使用 Codex 专属、带进程所有权验证的单实例租约。重复启动不生成第二条内部监视链；陈旧租约只能在确认拥有者不再存在后回收。计划任务恢复守护时，守护只重新监听和连接 CDP，不因恢复动作本身启动或关闭 Codex。新启动且无 CDP 的 Codex 仍须经过现有进程名、安装路径、主进程、年龄、唯一性和去重校验。已运行超过 10 秒的进程只报告问题，绝不自动结束。

升级按事务处理：先准备和验证稳定运行时及新任务定义，再移除旧 `HKCU Run` 接线；仅对经安装路径与命令行双重确认的旧 beautiCode 守护执行交接，不触碰 Codex 进程。如果任务无法注册或启动，安装报错并保留或恢复原接线，不输出“安装成功”。卸载只移除本产品任务、旧 Run 值和本产品守护接线；保留背景媒体与主题数据，不关闭 Codex。任务名称、主体和 action 必须精确匹配，不能误删用户的同名无关任务。

## 健康检查契约

聚合 CLI 增加 `beauticode-desktop codex health`；现有 `codex status` 及 `all status` 的字段和只读语义不变。`health` 同样只读、不启动任务/宿主、不滚动页面、不尝试注入或重启，设置总超时和响应大小上限。结果使用有界枚举，至少区分：

- `installation`: `missing` / `ready` / `incomplete`；包含本产品任务是否已注册。
- `guardian`: `running` / `stopped` / `unknown`；进程所有权需核对安装目录与命令行，不信任单独的 PID 文件。
- `host`: `closed` / `running` / `ambiguous`；无宿主时为正常空闲，不是故障。
- `cdp`: `connected` / `missing` / `wrong-host` / `unknown`；端口从已验证的主进程及受限候选端口判断，不假设固定为 9222 或 9335。
- `entry`: `visible` / `offscreen` / `not-mounted` / `not-checked`；先确认选中的 Codex 主页面，再检查节点、边界矩形和前景命中。滚出视口不误报为未注入。
- `action`: `none` / `wait-for-launch` / `manual-restart-available` / `inspect-guardian`；不执行该动作。

无法判断时报告 `unknown` 和不含账号信息的原因码，不推断“成功”。不输出完整 CDP URL、窗口标题、页面文本、媒体路径或任务用户标识。多窗口仅报告被选主页面的状态及候选主页面数量，暂不改变注入目标策略。

## 错误、验证与回滚

测试覆盖任务定义、非管理员安装失败与回滚、升级交接、重复启动、外层异常退出、内部子进程异常退出、任务重启上限、卸载清理、主动关闭宿主、10 秒边界、旧无 CDP 宿主、错误端口/错误页面、入口滚出视口。Windows 真机分别验证守护先于 Codex、晚 5 秒、晚 30 秒，以及 Codex 已运行数小时；后两种情形不得后台杀掉旧进程。运行中可通过卸载或停用任务回滚到“无自动注入”；用户媒体保持原样。

相关源码：`integrations/codex-desktop/{cli.js,codex-watchdog.mjs,watch-host.mjs,lifecycle.mjs}`、`packages/adapter-codex/src/{launch.ts,host-applier.ts}`、`packages/beauticode-desktop/src/index.mjs` 与相应测试。实施前需先做失败测试；不修改其它宿主的 CDP 启动方式。

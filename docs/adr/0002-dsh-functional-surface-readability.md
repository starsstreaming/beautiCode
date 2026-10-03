# ADR 0002：DSH 功能面板独立保证遮挡

- 状态：接受
- 日期：2026-10-03
- 关联问题：[#78](https://github.com/starsstreaming/beautiCode/issues/78)、[#79](https://github.com/starsstreaming/beautiCode/issues/79)

## 背景与证据

在官方 DSH Desktop 0.2.0-rc.2、beauticode-dsh 1.0.26 中，深色与浅色设置面板均透出后方会话文字。向上滚动长会话时，正文和代码块也透过固定消息编辑栏。设置是 body 下的 portal，面板使用 `--dsw-alias-bg-layer-2`；编辑栏使用 `--dsw-specific-input-major` 并带 `data-composer-card`。

原样式在 body 上改写宿主 token，部分采用混合比例，部分硬编码 alpha；会话阶段、背景阴影与画窗又覆盖这些值。将所有层级统一到一个比例仍无法保证浮动面板能遮住后方文字。

## 决定

新增独立 `readability.js`，拥有功能面板保护样式和布尔偏好。现有 `/__beauticode/client.js` 按顺序提供它和媒体客户端，保持页面注入协议及鉴权不变。背景控制台仅通过 `BeauticodeReadableSurfaces.get/set` 读取和修改偏好。

背景启用时，默认将 dialog、alertdialog、menu、listbox、tooltip 与 `data-composer-card` 的底色设为不透明，并在这些元素上独立声明所需表面 token。规则依赖角色和宿主语义属性，不使用构建生成的类名；局部声明不会被会话阶段、阴影或画窗的 body 规则覆盖。浅色和深色使用各自的宿主静态色板。

用户可在背景设置中关闭「功能面板不透明」，恢复原有透明效果。偏好使用独立 localStorage 项，只有明确的 `false` 关闭保护；无效值或存储失败默认保护。偏好变更通过事件同步当前控制台，同源窗口通过 storage 事件同步。背景未启用时不改变宿主表面。

## 验证与限制

- 浏览器回归脚本 `scripts/dsh-readability-smoke.mjs` 在修复前因设置底色 alpha 为 0.32 而失败；验证深浅主题、hero/active/settling/无匹配阶段、阴影偏好、画窗的 32 种组合及关闭开关后的透明效果。
- 单元测试覆盖默认值、显式关闭、无效输入、存储失败、跨窗口变更、重复加载与控制台开关。
- 必须在真实 Desktop 上复查设置和滚动会话编辑栏，自动化 fixture 不替代现场验收。
- 本次通过官方 Desktop 的插件管理命令安装本地修复包后验收：画窗背景、0% 阴影下，浅色与深色设置均遮住会话文字；关闭开关立即重现叠字，重新开启后消失；滚动长会话时消息编辑栏遮住后方正文。保留默认保护开启。
- 本机旧安装使用共享背景目录，而当前源码默认使用 DSH 宿主目录。现场测试在备份 Desktop profile patch 后，通过插件已有的 `tokenFile` 配置继续指向旧目录；重启确认原有 7 项背景恢复。此项只调整本机测试配置，不修改数据迁移逻辑，原目录内容未删除。
- 保护依赖当前 DSH 的角色及 `data-composer-card` 契约；宿主移除这些语义标记时须随适配更新，禁止用 hash 类名兜底。

## 回滚

用户关闭开关即可回到原有透明效果。版本回滚可移除脚本的拼接、打包项与控制台入口；独立偏好不会影响旧版背景客户端。不会改写 DSH 安装文件或原有背景状态。

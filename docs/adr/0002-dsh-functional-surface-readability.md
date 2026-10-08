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

### 补充：待交互面板（提问 / 计划审核 / 授权确认）

上述按角色枚举的保护漏掉了 DSH 的待交互面板。用户提问、计划审核与授权确认三者的卡片**都不带 dialog 角色**，且都以 `var(--dsw-specific-input-major)` 作为底色——正是本模块改写为半透明的那个 token，因此会话正文会透出提问卡片。

三者的 DOM 形状一致：外层是一个负责左右留白、自身透明的 flex frame，内层卡片才是绘制底色的元素。frame 上带稳定语义键 `data-question-key` / `data-plan-review-key` / `data-approval-key`，内层卡片分别是 `section`、`section`、`div`。因此保护选择器按「frame 的语义键 + 直接子元素」书写，即 `[data-question-key] > section` 等三条。

必须指向内层卡片而非 frame：若命中外层 frame，其左右内边距会被涂成一条实心横带。同样不使用类名——`mAtvLq_card`、`P2izSq_card`、`j_8BDW_card` 都是构建生成的哈希。三者都没有 dialog 角色，这既解释了漏网原因，也说明不能靠角色兜底，须随宿主新增待交互面板同步补齐。

用户可在背景设置中关闭「功能面板不透明」，恢复原有透明效果。偏好使用独立 localStorage 项，只有明确的 `false` 关闭保护；无效值或存储失败默认保护。偏好变更通过事件同步当前控制台，同源窗口通过 storage 事件同步。背景未启用时不改变宿主表面。

## 验证与限制

- 浏览器回归脚本 `scripts/dsh-readability-smoke.mjs` 在修复前因设置底色 alpha 为 0.32 而失败；验证深浅主题、hero/active/settling/无匹配阶段、阴影偏好、画窗的 32 种组合及关闭开关后的透明效果。
- 单元测试覆盖默认值、显式关闭、无效输入、存储失败、跨窗口变更、重复加载与控制台开关。
- 必须在真实 Desktop 上复查设置和滚动会话编辑栏，自动化 fixture 不替代现场验收。
- 本次通过官方 Desktop 的插件管理命令安装本地修复包后验收：画窗背景、0% 阴影下，浅色与深色设置均遮住会话文字；关闭开关立即重现叠字，重新开启后消失；滚动长会话时消息编辑栏遮住后方正文。保留默认保护开启。
- 本机旧安装使用共享背景目录，而当前源码默认使用 DSH 宿主目录。现场测试在备份 Desktop profile patch 后，通过插件已有的 `tokenFile` 配置继续指向旧目录；重启确认原有 7 项背景恢复。此项只调整本机测试配置，不修改数据迁移逻辑，原目录内容未删除。
- 保护依赖当前 DSH 的角色及 `data-composer-card` 契约；宿主移除这些语义标记时须随适配更新，禁止用 hash 类名兜底。

### 待交互面板补充验证

- 冒烟脚本 `scripts/dsh-readability-smoke.mjs` 的 fixture 增加提问、计划审核、授权确认三个面板（frame + 内层卡片），断言在原有 32 种深浅主题/阶段/阴影/画窗组合下，六类表面 alpha 均为 255；并断言三个 frame 自身保持 `rgba(0,0,0,0)`，防止误涂留白。
- 单元测试新增一例，断言三条子元素选择器存在、且不会命中外层 frame。
- 现场验收：官方 DSH Desktop，背景启用（画窗、0% 阴影）下打开提问窗口，卡片底色与会话输入框一致，正文不再透出；关闭「功能面板不透明」后立即恢复半透明，重新开启后再次遮挡。

## 回滚

用户关闭开关即可回到原有透明效果。版本回滚可移除脚本的拼接、打包项与控制台入口；独立偏好不会影响旧版背景客户端。不会改写 DSH 安装文件或原有背景状态。

## npm 1.0.27 发布基线

按用户要求以 registry 的 `beauticode-dsh@1.0.26` 实际 tarball 为基线。该包的 SHA-1 为 `856dac332b5a7d5f4840b65e7097871e1fce95ec`，SHA-512 integrity 为 `sha512-Rf0b/6n9MrAjHCEw2XNHDXGn3Xf5YqfSIz9etcWLIGiMz200WpoOiacLrw2nloy4msVmQ18s1q4MS2PlZUL6UQ==`；下载后核对 registry 完整性。

仓库已有其他尚未包含在 npm 1.0.26 中的改动，因此本次正式发布不直接发布完整源码重新打包的产物。只向旧包应用本修复在 `index.mjs`、`console.js`、`readability.js`、`package.json` 的 diff，并补充 README 的功能说明。版本升至 1.0.27，新增 `readability.js`；没有移除旧包文件。其余媒体资源、vendor、配置及背景数据目录行为保持 1.0.26 的内容。

1.0.26 的 `index.mjs` 和 `console.js` 与历史提交 `328d6675633f63a5f71f5af8bf88d93655f35b83` 一致。候选包使用该提交的控制台和插件路由测试，应用本修复的测试 diff，再加上新的偏好测试；避免以未发布的阴影默认值、重置箭头样式和 Host 检查契约判断旧包。仓库当前完整测试另行运行。

浏览器脚本第三个参数可指定解包目录，以验证实际发布文件。发布后再次核对精确版本的 registry tarball、完整性和关键文件，并比对候选包。

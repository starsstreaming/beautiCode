# PR #96：owner 实施与验收记录

日期：2026-10-24。基线 origin/main aea32209f02de0e14b7248ac870f5868e195d167；
来源 PR head d5f3252，经执行前在线复核未变。

实施位于附加 worktree 的 codex/pr96-owner-completion 分支。
原 E:/WoRk/beautiCode 工作区未修改；其 tracked patch 与 untracked 文件先复制后整合，
包括阴影恢复、空 composer 装饰层、相关浏览器测试及 ADR 0008。
其他复制的本地 DSH 文档/脚本不属于本次新增实现，不混入本次修复提交。
未发布、推送或合并，也未把新运行时安装到用户应用。

## 已实现

- 保留宿主圆角与普通 tooltip 配色；定位壳透明，菜单/浮层/peek 随宿主主题。
- 排除 beautiCode 自身 UI；保留输入框、普通卡片和无关 aside 底色。
- 按现场结构清理站点的三层外壳及资料库/站点的标题伪元素，不新增生成类名选择器。
- 媒体按职责拆分，修改后的主运行时及新增模块小于 500 行；既有大测试文件也按职责分拆。
- guest 按预期/实际地址和宿主插槽验证；支付、预热、认证、sandbox 与未知页面保持原生。
- 样式键替代内联修改和尺寸扫描；登记表管理事件、观察器和异步操作。
- 同代次复用、交接、完整清除、销毁、动态节点、导航期间延迟完成均有行为回归。
- 修正旧有图片等待取消及色调读取方法不一致，保留原公开方法。

架构与明确的允许/拒绝规则见 [ADR 0009](adr/0009-codex-wallpaper-surface-and-guest-lifecycle.md)。

## 实施过程与可复现证据

基线 Codex：74 通过、5 跳过、0 失败；显式浏览器基线 4 通过、0 跳过。
失败先于修复的记录保存在 artifacts/pr96/：

| 失败证据 | 检查内容 |
| --- | --- |
| red.log | 固定样式、未实现 guest 行为 |
| guest-readiness-red.log | about:blank 候选页面需要等待 dom-ready |
| handoff-error-red.log | 交接已结束后，永久视频错误不能继续 pending |
| navigation-race-red.log | 旧插入调用不能阻断新文档注入 |
| image-cancel-red.log | 已销毁的图片附件不能更新下一代 |
| guest-timer-red.log | 销毁必须释放插入超时计时器 |
| owned-ui-red.log | 自有 UI 的嵌套浮层也必须排除 |
| header-red.log / library-header-red.log | 清 h1 无效，且 Library 与 Sites 外壳不同 |
| tone-red.log | 通过已有公开方法恢复色调偏好 |

独立只读审查发现并复现 handoff 快照和 pending 导航收敛两项 Important；
均已按失败测试→修复→通过完成，未发现 Critical。
首次视频测试的 MediaRecorder 只产生文件头，原生 video 也无法解码；
补充真实帧录制后才用于运行时验收，没有通过放宽断言绕过失败。

## 自动化验收

| 检查 | 结果 / 原始日志 |
| --- | --- |
| 全仓类型检查 | 通过；typecheck.log |
| 全仓构建 | 通过；build.log |
| 全仓最终确认 | 435 通过、19 跳过、0 失败；full-test-confirmation.log |
| 最新 Codex 测试 | 106 通过、9 跳过、0 失败；adapter-final.log |
| 完整载荷 Edge 浏览器 | 8 通过、0 跳过；browser-final.log |
| 最终插件包内完整载荷 | 4 通过、0 跳过；packaged-browser.log |
| 打包模块加载/语法 | 进入必跑 Node 测试，未遗漏私有模块 |
| 空白与规模检查 | git diff --check；主入口及新运行时模块均不超过 500 行 |

浏览器回归直接执行 loadRendererSource/buildInjectionExpression 产生的真实载荷，
覆盖浅→深→浅、圆角、tooltip、peek、自有 UI、原生路由外壳及普通阅读卡片，
以及真实视频解码、交接、静音、定位、摸鱼、色调继承和清除。
包内验证通过 BEAUTICODE_RENDERER_PAYLOAD 指向 staged vendor/payload.js，
不是只检查源文件字符串或包文件清单。

全仓复跑曾在未修改的 DSH pack.test.mjs 出现一次 Node 测试器
“Unable to deserialize cloned data due to invalid or unsupported version”。
DSH 单独重跑 122 通过、10 跳过、0 失败，记录为 dsh-recheck.log；
该异常记录保留为 full-test-final.log，不将其抹掉或归因于已证实的业务缺陷。
最后一轮全仓确认 435 通过、19 跳过、0 失败，见 full-test-confirmation.log。

## 真实客户端与视觉边界

现场版本：Codex Desktop 26.1016.6573.0 / Windows，深色主题。
通过当前 9335 CDP 读取 DOM/静态资源、切换内容入口并临时替换壁纸 CSS；
finally 恢复原 CSS，并恢复本聊天，没有改动背景档案或安装包。

- Plugins、Library、Sites、Images 均实际打开并采集截图。
- Sites 的根外壳、内容容器、tabpanel 背景确认透明；普通卡片保留自身外观。
- 初次截图暴露 Library 标题仍不透明，随后增加独立结构样例及回归再修复。
- sandbox 未绑定旧式透明事件；定价预热保持排除。
- 外层 sidebar 在本版本原生值可为 0px；保留原生不是强制增加圆角。

截图：artifacts/pr96/live-route-0.png 至 live-route-3.png，
合成但真实渲染的主题对照：fixture-dark.png、fixture-light.png。
navigation-00.png 至 navigation-05.png 是实际切页采样；
navigation-sampled.webm 是这六帧的回放，不是连续录屏，不能证明采样间绝无闪烁。
原始无正文结构快照及结果为 live-*.json / live-css-results.json。
这些本地证据位于忽略目录，不随提交公开。

未宣称通过的范围：

- 用户应用的浅色主题：已在真实 Edge + 脱敏结构中覆盖，未现场更改用户主题设置。
- 允许的 Electron guest 现场：当前目标入口为原生页面，只有被排除的预热 guest；
  不能把 API 替身测试或方法存在当作此项现场验收。
- Plans/结算/认证等未验证页面：保留原生，不扩大透明范围。
- 未安装旧版客户端，没有将本版本结论推广至 PR 描述的旧版本。

## 复跑

从仓库根运行 npm run typecheck、npm test、npm run build。
浏览器测试使用现有 BEAUTICODE_PLAYWRIGHT_MODULE，Windows 下赋值为 file:/// 模块 URL，
运行 node --test packages/adapter-codex/test/appearance.browser.test.js
packages/adapter-codex/test/wallpaper.browser.test.js。
未配置该变量时浏览器测试会显式跳过，不能算视觉通过。

运行 node scripts/pack-codex-plugin.mjs --no-build 后，
将 BEAUTICODE_RENDERER_PAYLOAD 指向包内 vendor/adapter-codex/payload.js 的 file URL，
再运行 wallpaper.browser.test.js 即可验证最终载荷。

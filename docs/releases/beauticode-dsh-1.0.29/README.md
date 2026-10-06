# beauticode-dsh 1.0.29

基于 registry 的 1.0.28 修复 [#86](https://github.com/starsstreaming/beautiCode/issues/86)
和 [#87](https://github.com/starsstreaming/beautiCode/issues/87)，已发布至
[npm](https://www.npmjs.com/package/beauticode-dsh/v/1.0.29)，`latest` 指向 1.0.29。

画窗背景消费既有磨砂、阴影偏好；遮罩盖住水波，并随 DSH 深浅色切换。
删除两处误隐藏原生渐隐滚动 body 的规则，保留宿主布局和 mask，停止
ResizeObserver 在可见高度与零高度之间循环。

## 发布范围与复核

发布以精确 npm 1.0.28 tarball 为基线，按 `package-overlay.patch` 仅改动
`atmosphere.js`、`client.js`、README 与版本号；其余 45 个文件和所有文件权限
保持原样。没有用整个源码目录重新生成已发布包。

- `release-manifest.json`：基线、逐文件摘要、tarball 摘要和验收范围。
- `registry-verification.json`：重新下载精确 1.0.29 包，验证名称、版本、49 个文件、SHA-1 与 SHA-512。
- `dist-tags.json`：发布后的标签查询结果。
- `desktop-verification.json`：实测 CSS 摘要、180 帧长思考高度、磨砂与深浅色遮罩。
- `desktop-installation.json`：官方 Desktop 安装正式 npm 版本后的 49 个文件摘要比对结果。

远程 tarball 与实测 tarball 完全一致：

```text
SHA-1: bbf64619febf30e9b0407bbe39a88c64d8647a6d
SHA-512: OEg4anQHoLgmERrNaDa025/qQW3dCDM3MJcZTkxZ+mm2Dj8jpmQvYPDoYVoe3e8AyYdeITvWDA9mQQ+v0YMx8Q==
```

## 验证与限制

精确发布包的浏览器、全屏和可读性回归测试共 12 项通过，无失败或跳过。
浏览器测试使用现有 Playwright 与 Edge，未添加生产依赖。
在官方 Desktop 0.2.0-rc.2 中冷启动实测，实际加载 CSS 与包内 CSS 一致，
没有临时覆盖样式。已完成长思考连续 180 帧高度为 400px，无隐藏帧和高度跳变；
画窗磨砂、深浅色阴影及归零均生效。

这是已完成会话的短时验收，没有新建流式请求或长期压力测试。
安装正式包后执行了重启；用户按 Esc 停止界面检查，没有记录重启后的窗口验收。

## 升级与回滚

退出 Desktop 后使用它安装的 `dsh` 命令，再重新打开 Desktop：

```sh
dsh plugin --profile desktop add beauticode-dsh@1.0.29
```

不需要数据迁移。回滚时改为 `beauticode-dsh@1.0.28`，保留背景和偏好，
但会恢复本次修复的两个已知问题。源码边界决策见 ADR 0007。

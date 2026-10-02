# ADR 0001：通过 DSH 结构化页面注入支持官方 Desktop

- 状态：接受
- 日期：2026-09-29

## 背景

beautiCode 原先通过 `webServer.tapIndex()` 改写 DSH Web 的 HTML，加载背景脚本。官方 Desktop 使用 `dsh-app://app/` 的静态页面，Host 把 `collectIndexInjections()` 的结果交给页面启动器执行；HTML tap 不会经过该路径。Desktop 仍将非静态页面请求转发到同一 Web Host，默认端口为 19387。

## 决定

插件通过 `webserver/index-inject` 贡献有序的 `global` 与 `script-src` 行，Web 和 Desktop 共用背景脚本与桥接路由。Desktop 转发会移除 `Origin` 和 `Sec-Fetch-Site` 请求头，因此 Host 每次启动生成独立的随机页面密钥，通过注入表交给受控页面；Desktop 发往 beautiCode UI、回执与事件流的请求在自定义请求头中携带此密钥。事件流在 Desktop 使用可带请求头的 `fetch` 流式读取与有界退避重连；Web 继续使用浏览器原生 `EventSource`。控制端的独立 Bearer 令牌不交给页面。

本机媒体服务仅额外允许 `dsh-app://app` 来源，仍要求每个媒体 URL 的随机令牌。Desktop 插件安装通过官方 `desktop` profile 管理；Web 的既有安装器只管理 Web profile。

## 影响与验证

- 官方的结构化注入表保持脚本执行顺序；`transport.js` 必须先于背景和控制台脚本加载。缺失密钥时 Desktop 页面启动会显式失败。
- Host 重启会生成新密钥，旧页面请求不再通过验证；Desktop 自身在 Host 恢复时重新加载工作区。
- 测试覆盖注入表顺序、跨 Host 密钥拒绝、Desktop 请求头与 SSE 解析、真实桥接路由鉴权、`dsh-app://app` 媒体 CORS，以及插件打包文件清单。
- 本次未重启用户正在运行的 Desktop，也未修改其 profile；真实桌面可见性仍需在安装插件后验收。

## 回滚

若官方 Desktop 停止执行 Host 的结构化页面注入表，应停止将 Desktop 标记为受支持宿主，并移除 Desktop 请求密钥与 CORS 来源；Web 继续可使用结构化注入。不要回退到修改 Desktop 安装文件或调试端口注入，因为这会绕开官方插件生命周期与应用完整性边界。

## 依据

- [官方 Desktop 启动与请求转发](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)
- [官方页面注入协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/src/injections.ts)
- [官方页面端注入执行器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/web/src/apply-injections.ts)

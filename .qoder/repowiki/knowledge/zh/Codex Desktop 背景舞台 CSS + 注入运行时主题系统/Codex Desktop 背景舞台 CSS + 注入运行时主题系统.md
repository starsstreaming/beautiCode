---
kind: frontend_style
name: Codex Desktop 背景舞台 CSS + 注入运行时主题系统
category: frontend_style
scope:
    - '**'
source_files:
    - packages/adapter-codex/src/renderer/background.css
    - packages/adapter-codex/src/renderer/background-runtime.js
    - packages/core/src/apply-transaction.ts
    - integrations/deepseek-harness/client.js
    - integrations/deepseek-harness/atmosphere.js
    - assets/themes/internal-beyond/bg-canvas.png
    - assets/themes/internal-beyond/bg-canvas-4k.png
    - assets/themes/internal-beyond/bg-infernal.jpg
    - assets/themes/internal-beyond/bg-internal.jpg
---

## 1. 采用的样式体系

本仓库没有使用任何前端框架（React/Vue/Svelte）、CSS 框架（Tailwind/Bootstrap/AntD）或 CSS-in-JS 库。所有视觉表现集中在 `packages/adapter-codex/src/renderer/background.css` 一个原生 CSS 文件中，配合同目录的 `background-runtime.js` 通过 CDP 注入到 Codex Desktop 渲染进程，实现“全屏背景舞台”效果。

- **CSS 变量驱动的主题**：在 `:root` 中定义 `--bc-sidebar`、`--bc-main-edge`、`--bc-main-mid`、`--bc-main-far`、`--bc-video-filter`、`--bc-working-main` 等自定义属性；通过 `html[data-bc-tone="light"]` 与 `@media (prefers-color-scheme: light)` 切换暗/亮两套变量值，实现无 JS 重绘的主题切换。
- **属性选择器状态机**：所有 UI 状态通过 `<html>` 上的 `data-bc-*` 属性表达——`data-bc-active`（是否激活背景）、`data-bc-media`（image/video/video-pending）、`data-bc-video-ready`、`data-bc-generation`、`data-bc-working`（项目线程确认时右侧主列变暗）、`data-bc-fish`（摸鱼模式隐藏宿主 chrome）、`data-bc-tone`（dark/light/auto）。CSS 仅依赖这些属性选择器进行样式分支，运行时只负责写属性。
- **固定定位背景舞台**：`#beauticode-bg-stage` 使用 `position: fixed; inset: 0; z-index: 0; pointer-events: none` 覆盖整个窗口，内部 `<img>`（z-index: 1）和 `<video>`（z-index: 2, 默认 opacity: 0）以 `object-fit: cover` 铺满，视频就绪后由 CSS 规则将 opacity 切为 1 并隐藏 poster 图片。
- **毛玻璃侧栏与渐变主列**：左侧 `aside.app-shell-left-panel` 用 `backdrop-filter: blur(8px) saturate(112%)` 加半透明渐变；主列 `main` 用三段式 `linear-gradient(90deg, ...)` 从边缘到远端的透明度渐变，确认项目线程时替换为更深的 `--bc-working-main`。
- **摸鱼模式**：`[data-bc-fish="true"]` 下宿主 `#root` 被 `opacity: 0; visibility: hidden` 隐藏，背景舞台 z-index 提升到 `2147483000`，媒体以原始亮度播放（filter:none），用于纯壁纸展示。

## 2. 关键文件

- `packages/adapter-codex/src/renderer/background.css` — 全部样式定义（约 300 行），包含主题变量、状态分支、侧栏/主列/对话框层级、摸鱼模式。
- `packages/adapter-codex/src/renderer/background-runtime.js` — 注入运行时代码，维护 stage DOM、视频生命周期、跨代 handoff、防闪烁、工作态检测、静音/seek/tone/fish 模式 API，并通过 `window.__BEAUTICODE_BG__` 暴露接口给宿主。
- `packages/core/src/apply-transaction.ts` — 在服务端/交易层追加一段内联 CSS 片段（`html[data-bc-active="true"][data-bc-media="video"][data-bc-video-ready="true"] #beauticode-bg-stage video{opacity:1;}` 等），作为注入样式的补充。
- `integrations/deepseek-harness/client.js` 与 `atmosphere.js` — DSH 插件侧也注入了自己的背景舞台 CSS（`#beauticode-bg-stage`、`data-bc-gallery`、`data-bc-resolved-tone` 等），与 Codex 适配器风格一致但独立实现。
- `assets/themes/internal-beyond/` 与 `artifacts/dsh-plugin/themes/internal-beyond/` — 内置 Beyond 主题的背景图资源（`bg-canvas.png`、`bg-canvas-4k.png`、`bg-infernal.jpg`、`bg-internal.jpg`），由上层逻辑引用。

## 3. 架构与约定

- **注入式而非宿主修改**：不改动 Codex/Dream-Skin 源码，而是通过 CDP 注入 `<style id="beauticode-bg-style">` 与 `<div id="beauticode-bg-stage">`，利用 `!important` 覆盖宿主原有背景、边框、阴影。
- **状态单向流**：JS 运行时检测页面结构（如 `[data-testid="home-icon"]`、`.thread-scroll-container`、`aside.app-shell-left-panel [aria-current="page"]`）决定 `data-bc-working`；CSS 仅消费属性，不反向读 DOM。
- **跨代 handoff 防闪烁**：同一 generation 短路与跨代视频节点交接是核心约束——旧 `<video>` 必须保持可见直到新帧解码完成，避免 poster 闪烁（注释明确引用 PR #290 与 Dream Skin session 019fa31c）。
- **CSP 约束下的媒体来源**：注释声明 app:// CSP 不允许 `http://127.0.0.1`，因此媒体必须以 `data:` 或 `blob:` URL 传入，远程 URL 需经 token 头 `X-BeautiCode-Media-Token` 拉取后转 blob。
- **主题色与宿主解耦**：`data-bc-tone` 仅影响 beautiCode 叠加层的半透明玻璃色，不影响 Codex 原生应用主题或文字颜色（注释明确说明）。

## 4. 约定与约束

- **样式组织**：所有样式集中在单一 `background.css`，按区域（根变量 → 光/暗主题 → 清除宿主背景 → 舞台 → 侧栏 → 主列 → 摸鱼模式）顺序书写，不使用模块化 CSS。
- **主题切换**：只能通过设置 `html[data-bc-tone]` 为 `dark` / `light` / `auto`，禁止直接修改 CSS 变量；`auto` 时由 `@media (prefers-color-scheme: light)` 接管。
- **工作态判定**：仅在检测到已确认的项目/任务线程（含 `.thread-scroll-container`、`[data-message-author-role]`、`aside` 选中项且非空文本）时才设置 `data-bc-working`；首页/新建任务即使 agent 生成也不变暗。
- **视频就绪策略**：视频元素初始 `opacity: 0`，仅当 `data-bc-video-ready="true"` 时由 CSS 显示；pending 状态下保留 poster 图片可见。
- **摸鱼模式**：启用后宿主 UI 完全隐藏，背景媒体以原始亮度播放（filter:none），且隐藏 `#beauticode-video-input` 文件输入框。
- **z-index 层级**：stage 固定 z-index 0，对话框/portal 提升为 50，摸鱼模式下 stage 提升至 `2147483000` 确保最顶层。
- **运行时 API 契约**：`window.__BEAUTICODE_BG__` 暴露 `snapshot()`、`handoffVideo()`、`dispose()`、`isFishMode()`、`getBackgroundTone()`、`setMuted()`、`seekTo()`、`setBackgroundTone()` 等方法，供宿主或其他注入脚本调用。
- **DSH 插件一致性**：`integrations/deepseek-harness` 中的注入代码遵循相同命名空间（`#beauticode-bg-stage`、`data-bc-*` 属性），但拥有独立的 CSS 片段，不与 Codex 适配器共享样式文件。
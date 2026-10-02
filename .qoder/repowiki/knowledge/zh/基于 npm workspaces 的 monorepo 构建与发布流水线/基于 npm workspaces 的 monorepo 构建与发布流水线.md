---
kind: build_system
name: 基于 npm workspaces 的 monorepo 构建与发布流水线
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - scripts/build-windows-installer.ps1
    - scripts/pack-dsh-plugin.mjs
    - scripts/beauticode.mjs
    - installer/windows/beauticode.iss
    - .github/workflows/ci.yml
    - .github/workflows/publish-github-package.yml
    - scripts/test-runner.mjs
    - scripts/live-smoke.mjs
    - scripts/copy-renderer-assets.mjs
---

## 1. 使用的系统与工具

- **npm workspaces**：根 `package.json` 通过 `workspaces: ["packages/*", "apps/*"]` 聚合 `@beauticode/core`、`@beauticode/adapter-codex`、`@beauticode/adapter-dsh` 三个包以及 `apps/tray`，统一执行依赖安装与脚本编排。
- **Node.js ESM**：根声明 `"type": "module"`，所有构建/发布脚本（`scripts/*.mjs`）和 CLI（`scripts/beauticode.mjs`）均为 ESM；要求 Node ≥ 22（`engines.node` 与 CLI 内版本检查双重约束）。
- **TypeScript**：每个 package 拥有独立 `tsconfig.json`，构建产物输出到各自 `dist/`，由根 `build` 脚本顺序调用各包的 `build`。
- **Inno Setup 6**：Windows 安装包由 `installer/windows/beauticode.iss` 描述，通过 `ISCC.exe` 编译为自解压 `.exe`。
- **GitHub Actions**：`.github/workflows/ci.yml` 在 `windows-latest` 与 `ubuntu-latest` 上以 Node 22/24 矩阵运行；`publish-github-package.yml` 将已发布的 npm 包镜像到 GitHub Packages。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | workspace 定义、顶层 `build/test/typecheck/smoke:live/tray/installer:windows/plugin:pack/publish` 脚本入口 |
| `scripts/build-windows-installer.ps1` | 下载并校验固定版本 Node.js、拷贝源码与 dist、生成 `release-manifest.json`、调用 Inno Setup 产出 `artifacts/windows/installer/beautiCode-Setup-*.exe` |
| `scripts/pack-dsh-plugin.mjs` | 打包 `integrations/deepseek-harness` 为自包含 npm 插件（`artifacts/dsh-plugin`），可 `--publish` 到 npm |
| `scripts/beauticode.mjs` | 用户 CLI 入口（`npm run bc`），封装离线/CDP 注入命令 |
| `installer/windows/beauticode.iss` | Inno Setup 安装器脚本，定义安装目录、快捷方式、自动启动、卸载时清理 DSH 插件 |
| `.github/workflows/ci.yml` | CI：`npm ci → audit → typecheck → test → build → node --check → PowerShell 语法解析` |
| `.github/workflows/publish-github-package.yml` | 从 npm registry 拉取 `beauticode-dsh@<version>`，改名为 `@starsstreaming/beauticode-dsh` 并发布到 GitHub Packages |
| `scripts/test-runner.mjs` / `scripts/live-smoke.mjs` | 单元测试与真实浏览器冒烟测试驱动 |
| `scripts/copy-renderer-assets.mjs` | 渲染端资源复制辅助脚本 |

## 3. 架构与约定

### 构建阶段
- 根 `npm run build` 按顺序构建 `core → adapter-codex → adapter-dsh`，保证依赖顺序。
- Windows 安装包构建 (`npm run installer:windows`) 会先执行 `npm run build`，再进入 PowerShell 流程：
  1. 强制要求运行环境为 Windows（`$env:OS -ne "Windows_NT"` 抛错）。
  2. 从 `nodejs.org/dist/v24.18.0` 下载 `node-v24.18.0-win-x64.zip` 与官方 `SHASUMS256.txt`，用内置 SHA256 校验，并与仓库硬编码的 `PinnedNodeVersion` 哈希二次比对。
  3. 将 `apps/tray`、`assets`、`packages/*/dist`、`integrations/deepseek-harness`、`scripts`、`licenses/node/LICENSE` 等白名单文件复制到 `artifacts/windows/stage`。
  4. 写入 `release-manifest.json`（schema `beauticode.release/v1`，含 appVersion、nodeVersion、platform、commit、dirty、builtAtUtc）。
  5. 用 staged Node 动态 `import()` 探测 `adapter-codex`、`adapter-dsh`、`deepseek-harness/index.mjs` 是否可加载，失败即中止。
  6. 调用 `ISCC.exe` 传入 `/DMyAppVersion=... /DStageDir=... /DOutputDir=...` 生成安装包。

### 插件发布阶段
- `npm run plugin:pack` 调用 `scripts/pack-dsh-plugin.mjs`：先构建 `@beauticode/core` 与 `@beauticode/adapter-dsh`，再将它们的 `dist/` 以相对路径 `vendor/core`、`vendor/adapter-dsh` 形式拷入 `artifacts/dsh-plugin`，同时重写 `from "@beauticode/core"` 为 `from "../core/index.js"`，使插件脱离 npm 依赖也能运行。
- `npm run plugin:publish` 追加 `--publish`，将 staged 产物以 `beauticode-dsh`（或 `--name <pkg>` 指定）发布到 npm。
- `publish-github-package.yml` 则走另一条路径：从 npm registry 下载已验证包，改名 `@starsstreaming/beauticode-dsh` 并发布到 GitHub Packages。

### 测试与类型检查
- `npm run typecheck`：先 build core，再对两个 adapter 执行 typecheck。
- `npm test`：依次运行三个 workspace 的测试。
- CI 额外用 `node --check` 校验 `apps/tray/session-host.mjs`、`scripts/beauticode.mjs`、`scripts/live-smoke.mjs`、`packages/adapter-codex/src/renderer/background-runtime.js` 的语法。
- CI 在 Windows runner 上用 PowerShell `Parser::ParseFile` 解析全部 `.ps1` 启动脚本，确保无语法错误。

### 版本策略
- 应用版本号来自根 `package.json` 的 `version`（如 `1.0.1`），安装包名称格式为 `beautiCode-Setup-{appVersion}-win-x64.exe`。
- Node.js 运行时版本在构建脚本中硬编码为 `24.18.0`，并通过 SHASUM 锁定。
- 插件版本由 `integrations/deepseek-harness/package.json` 决定，打包时可被 `applyPublishName` 覆盖。

## 4. 约定与约束

- **Node 版本**：根 `engines.node >= 22`，CLI 入口处显式检查 `process.versions.node` 主版本 `< 22` 即退出；CI 矩阵使用 22 与 24。
- **工作区边界**：PowerShell 构建脚本对所有目标路径调用 `Assert-WorkspaceChild`，拒绝修改仓库根之外的路径。
- **安全下载**：Node.js 归档必须通过官方 `SHASUMS256.txt` 校验，且当版本等于 `PinnedNodeVersion` 时必须命中仓库内嵌的 SHA256。
- **安装器参数**：Inno Setup 脚本要求必须传入 `StageDir` 与 `OutputDir` 宏，否则编译报错。
- **安装器平台限制**：仅在 Windows 上构建（`$env:OS -ne "Windows_NT"` 抛错）。
- **适配器导出契约**：staged 产物必须暴露 `BeautiSession`（adapter-codex）、`DshSession`（adapter-dsh）函数，否则视为构建不完整。
- **插件自包含**：打包后的插件不依赖外部 npm 包，所有 `@beauticode/core` 引用被改写为相对路径，theme 资源随包分发。
- **CI 质量门禁**：`fail-fast: false`，审计级别 `high`，任何一步失败都会阻断合并。
- **发布分支**：`publish-github-package.yml` 仅监听 `main` 分支对该 workflow 文件的 push 或通过 `workflow_dispatch` 触发，需显式输入版本号。
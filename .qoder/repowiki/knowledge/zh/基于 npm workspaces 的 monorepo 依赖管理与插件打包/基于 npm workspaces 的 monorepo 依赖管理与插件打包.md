---
kind: dependency_management
name: 基于 npm workspaces 的 monorepo 依赖管理与插件打包
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - packages/core/package.json
    - packages/adapter-codex/package.json
    - packages/adapter-dsh/package.json
    - integrations/deepseek-harness/package.json
    - scripts/pack-dsh-plugin.mjs
---

## 1. 使用的系统/方法

仓库采用 npm workspaces 作为 monorepo 依赖管理核心，根 package.json 通过 workspaces: ["packages/*", "apps/*"] 聚合三个内部包：
- @beauticode/core（纯库，TypeScript 编译输出到 dist/）
- @beauticode/adapter-codex（依赖 core，额外引入运行时依赖 ws）
- @beauticode/adapter-dsh（依赖 core，无外部运行时依赖）

所有包均声明 type: module，统一使用 ESM。根工作区仅维护 package-lock.json（lockfileVersion 3），并通过 engines.node >= 22 强制 Node 版本。

对外发布的产物是独立 npm 包 beauticode-dsh（位于 integrations/deepseek-harness/package.json），它不直接依赖 workspace 中的 @beauticode/* 包，而是由构建脚本将已编译的 JS 源码与主题资源拷贝进发布目录，形成自包含的发布物。

## 2. 关键文件

- package.json：定义 workspaces、顶层脚本（build/test/typecheck/smoke/tray/installer/plugin:pack/publish）、Node 引擎约束。
- package-lock.json：锁定 workspace 内三个包的 link 关系及 devDependencies（typescript、@types/node、ws）。
- packages/*/package.json：各包的元数据、exports 字段（同时暴露 types 和 import）、scripts（tsc build / typecheck / test）。
- scripts/pack-dsh-plugin.mjs：核心打包脚本，负责构建 core + adapter-dsh、拷贝 JS 树到 artifacts/dsh-plugin/vendor/、重写 @beauticode/core 导入为相对路径、注入主题资源、可选重命名并发布到 npm。
- integrations/deepseek-harness/package.json：最终发布包 beauticode-dsh 的清单，声明 files 白名单、bin、dsh.bundle.patch、publishConfig.access: public。

## 3. 架构与约定

- 内部包之间通过 workspace 链接：adapter-codex 与 adapter-dsh 以 "@beauticode/core": "0.1.0" 引用 core，在本地开发时解析为 packages/core 的符号链接（见 lockfile 中 resolved: packages/core, link: true）。
- 发布物与源码解耦：beauticode-dsh 包本身不包含 node_modules，也不依赖 workspace；发布前由 pack-dsh-plugin.mjs 调用 npm run build -w @beauticode/core 与 -w @beauticode/adapter-dsh，再将 packages/*/dist 下的 .js 文件（排除 .map、.d.ts）复制到 vendor/core 与 vendor/adapter-dsh，并改写 import 语句从 from "@beauticode/core" 替换为 from "../core/index.js"，从而生成完全自包含的发布目录。
- 主题资源随包分发：assets/themes/internal-beyond 下的背景图与 NOTICE.md 被复制至发布目录的 themes/internal-beyond/，并在 files 白名单中显式列出。
- 测试隔离：每个包通过 scripts/test-runner.mjs 运行各自 test/**/*.test.js；adapter-dsh 还额外执行 integrations/deepseek-harness/test/*.test.mjs，表明测试与发布源共享同一份源码。
- 无私有 registry：未发现 .npmrc、NPM_TOKEN、GOPRIVATE 等配置；publishConfig.access: public 表明发布到公共 npm registry。

## 4. 约定与约束

- Node 版本约束：根与各包均声明 engines.node >= 22，确保一致的运行时环境。
- ESM 优先：所有包 type: module，依赖与导出均使用 ESM 语法；TypeScript 编译后输出 .js。
- workspace 内版本硬编码：adapter 对 core 的依赖写死为 "0.1.0"，而非 ^0.1.0 或 *，体现 monorepo 内同步升级的约定。
- 发布物必须包含 LICENSE：pack-dsh-plugin.mjs 在 stage 阶段检查仓库根 LICENSE 是否存在，缺失则抛错，强制发布包携带许可证。
- 插件入口固定：beauticode-dsh 的 bin 指向 bin/beauticode-dsh，CLI 命令名由此确定；发布脚本支持 --name 参数覆盖包名，但默认始终为 beauticode-dsh。
- 构建顺序受控：顶层 npm run build 按 core → adapter-codex → adapter-dsh 顺序执行，保证依赖先于消费者构建。
- 无 vendor 目录提交：integrations/deepseek-harness/vendor 不存在于源码树（工具报错找不到该目录），说明 vendor 内容仅在 artifacts/dsh-plugin 构建产物中生成，不被纳入版本控制。

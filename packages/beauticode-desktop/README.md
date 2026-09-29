# beauticode-desktop

[简体中文](#简体中文) | [English](#english)

## 简体中文

Windows 桌面宿主聚合包，需要 Node.js 22 或更新版本。

### 安装

推荐全局安装：

```sh
npm install -g beauticode-desktop --foreground-scripts
beauticode-desktop all install
```

`--foreground-scripts` 会显示安装提示。npm 7 及更新版本默认隐藏提示；`postinstall` 只显示说明，不会自动安装守护。`all install` 为当前 Windows 用户安装后台集成，并为已检测到的宿主创建开始菜单快捷方式；它不会启动客户端。

首次启用 CDP 时，请用后台快捷方式启动客户端。如果客户端已经运行但没有 CDP，请先正常关闭，再使用快捷方式启动。DSH 使用插件，不需要 CDP 快捷方式。

项目内安装：

```sh
npm install beauticode-desktop --foreground-scripts
npm exec -- beauticode-desktop all install
```

### 检查与单独管理

```sh
beauticode-desktop all status
beauticode-desktop all health
beauticode-desktop <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall|health>
```

`all status` 和 `all health` 都是只读命令；health 会检查守护、宿主进程、CDP 连接和背景注入状态。`all install` 会跳过未安装的宿主，并继续处理其他宿主；`installed` 表示插件或守护已通过检查，不代表客户端已启动。需要单独卸载时使用宿主命令，例如 `beauticode-desktop codex uninstall`。

守护只会对启动不足 10 秒且已确认身份的单个进程尝试一次受控重启；不会终止较旧或身份不明的进程，也不会无限重启。

**Codex MSIX：**本包使用程序包感知启动。MSIX 的 CDP 修复仍待原始图标重启测试验证，验证前请视为未经确认。

## English

Windows desktop host aggregate. Requires Node.js 22 or newer.

### Install

Global installation is recommended:

```sh
npm install -g beauticode-desktop --foreground-scripts
beauticode-desktop all install
```

`--foreground-scripts` shows the install reminder. npm 7 and newer hide lifecycle output by default. The `postinstall` hook only prints instructions; it does not install guardians. `all install` sets up background integrations for the current Windows user and creates Start Menu shortcuts for detected hosts. It does not launch clients.

For the first CDP launch, use a generated background shortcut. If a client is already running without CDP, close it normally and start it from the shortcut. DSH uses a plugin and does not need a CDP shortcut.

Project-local installation:

```sh
npm install beauticode-desktop --foreground-scripts
npm exec -- beauticode-desktop all install
```

### Check and manage hosts

```sh
beauticode-desktop all status
beauticode-desktop all health
beauticode-desktop <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall|health>
```

`all status` and `all health` are read-only. Health checks guardians, host processes, CDP connectivity, and background injection. `all install` skips missing hosts and continues if one host fails. `installed` means its plugin or guardian passed verification; it does not mean the client is running. Uninstall hosts individually, for example `beauticode-desktop codex uninstall`.

Guardians attempt one controlled restart only for a verified, single process started within the last 10 seconds. Older or unidentified processes are not terminated, and restart attempts do not loop.

**Codex MSIX:** This package uses package-aware activation. MSIX CDP repair still needs verification with an original-icon restart; treat it as unverified until then.

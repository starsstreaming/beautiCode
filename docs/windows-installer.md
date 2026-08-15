# Windows installer

## User experience

`beautiCode-Setup-<version>-win-x64.exe` installs per user into:

```text
%LOCALAPPDATA%\Programs\beautiCode
```

The package includes the compiled beautiCode runtime, a pinned Node.js x64
runtime, and a compatible DeepSeek Harness. The target machine does not need
Node.js, npm, TypeScript, DSH, or a source checkout. Codex Desktop is optional
and remains a separate prerequisite if you choose that host.

The installer creates a Start menu shortcut. Desktop and login-start shortcuts
are optional installer tasks. Uninstall removes program files and shortcuts but
preserves `%LOCALAPPDATA%\beautiCode`, which contains user media and themes.
Quit the beautiCode tray before an upgrade or uninstall so the bundled runtime
is not in use.

## Build

Prerequisites:

- Windows PowerShell 5.1
- Node.js 22 or newer for the build machine
- npm dependencies installed with `npm ci`
- Inno Setup 6

Build:

```powershell
npm run installer:windows
```

The build script:

1. compiles the TypeScript workspaces;
2. creates a minimal runtime staging directory;
3. downloads the pinned official Node.js Windows x64 ZIP;
4. verifies it against the release `SHASUMS256.txt`;
5. includes the Node.js license;
6. compiles the Inno Setup installer;
7. prints the final SHA-256 digest.

Generated files are under `artifacts\windows\` and are intentionally ignored by
Git.

## Release boundary

The current installer is unsigned. Windows may show a SmartScreen warning until
the final EXE is signed with a trusted code-signing certificate.

The locally installed Inno Setup 6.7.3 compiler identifies itself as
non-commercial-use-only. Review or replace that build-tool license before using
this pipeline for a commercial distribution.

The installer targets x64-compatible Windows. DeepSeek Harness is bundled and
is the recommended host. The installer does not patch Codex Desktop; that path
still depends on Codex exposing a healthy loopback CDP endpoint.

The current bundled Node.js runtime requires 64-bit Windows 10 version 1809
(build 17763) or newer. If you use Codex and it was already running without
loopback CDP, use the tray's “Apply or re-apply” action; it will restart Codex
only after the normal confirmation prompt.

Startup diagnostics are written to:

```text
%LOCALAPPDATA%\beautiCode\logs\engine-launcher.log
%LOCALAPPDATA%\beautiCode\logs\tray.log
```

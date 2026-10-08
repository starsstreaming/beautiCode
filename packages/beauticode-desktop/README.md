# beauticode-desktop

Windows-only aggregate package for the beautiCode desktop hosts. Requires Node.js 22 or newer.

The source workspace is private and can be installed on Linux for development
and CI. Build release packages with `npm run desktop:pack`; the staged package
under `artifacts/desktop-aggregate` is public and retains `os: ["win32"]`.
Do not publish the source workspace directly. Host install/uninstall commands
remain Windows-only; use `beauticode-dsh` separately for cross-platform DSH.

Codex MSIX safety notice: direct launching an executable inside WindowsApps
loses its package identity and can prevent Codex from starting. This package
uses package-aware activation and refuses the unsafe direct-launch route, but
the MSIX CDP repair path still needs a controlled original-icon restart test.
Treat Codex MSIX startup repair as unverified until that test passes; other
hosts are unaffected.

Install the package from npm:

```sh
npm install -g beauticode-desktop --foreground-scripts
```

`--foreground-scripts` makes npm show the package's postinstall reminder. npm
7 and newer hide lifecycle output by default. After installation, run the
printed command to install the background guardians and shortcuts:

```sh
beauticode-desktop all install
```

For a project-local install, use:

```sh
npm install beauticode-desktop --foreground-scripts
npm exec -- beauticode-desktop all install
```

The npm `postinstall` hook only prints this reminder; it does not change system
settings or install guardians by itself. If npm scripts are disabled, run the
command manually.

`all install` writes this Windows user's startup integration and Start Menu
shortcuts. It does not start the desktop clients. Use `all status` and
`all health` to inspect installation and live host state.

The command prepares supported clients already installed on the PC and creates
`beautiCode Codex (背景)`, `beautiCode WorkBuddy (背景)`, `beautiCode Cursor (背景)`
and `beautiCode Doubao (背景)` shortcuts in the current user's Start Menu for
installed hosts. Open one of these shortcuts to pass CDP at the first launch.
The installer does not start clients or change their original icons or binaries.
Node.js >=22 is required.

```text
beauticode-desktop dsh install|status|uninstall|health
beauticode-desktop codex install|status|uninstall|health
beauticode-desktop workbuddy install|status|uninstall|health
beauticode-desktop cursor install|status|uninstall|health
beauticode-desktop doubao install|status|uninstall|health
beauticode-desktop all install|status|health
```

`all install` detects supported clients already present on this Windows PC,
installs or updates their background integration one by one, and prints a
per-host result. `installed` means the plugin or guardian was verified, not
that a closed client's background is already visible. `skipped` means the
client was not detected, `conflict` means a user-owned DSH plugin Junction was
left untouched, and `failed` gives a specific reason. Missing clients are skipped; one failure does not prevent the
others from being attempted. It does not launch a missing client. A newly
started client from its original icon without CDP may be restarted once by its
installed guardian. DSH uses its plugin and does not need a CDP shortcut.
The new shortcuts point at the stable local runtime, so clearing an `npm exec`
cache does not break them. If a client is already running without CDP, its
background shortcut reports `already-running-without-cdp` in
`%LOCALAPPDATA%\beautiCode\hosts\<host>\quick-launch.json` and does not close
your session; close that client normally and open its background shortcut.
`all status` is read-only. Use a per-host command for custom installation
paths that detection cannot find, or to uninstall a host individually. Cursor
can also be discovered from a verified Windows uninstall registration (for
example, a non-default `D:\cursor` install).

`all health` is a read-only live snapshot. It reports installation and
guardian state, whether the host is open, loopback CDP connectivity, the host
navigation anchor, and the injected entry/style/stage where that adapter can
inspect them. `host-ui-updated`, `entry-missing`, `partial-injection`, and
`cdp-missing` identify different repair stages. DSH uses a plugin rather than
a CDP guardian, so its health result reports plugin presence only. WorkBuddy,
Cursor and Doubao runners also record health-state transitions and elapsed
startup-repair stages in their existing logs.

For Codex, WorkBuddy, Cursor and Doubao, only a single verified main process
younger than 10 seconds is eligible for one controlled CDP restart. A client
closed by its user stays closed. An older or ambiguous process is never
terminated; close it normally and reopen it to give the guardian a fresh
launch. A controlled relaunch that still lacks CDP will not be restarted in a
loop. `guardian: not-running` calls for checking the installed watchdog;
`state: waiting-for-launch` means the guardian is ready and the client is
closed. Upstream CDP refusal or UI changes are reported, not retried forever.

`status` is read-only. The package carries its own compiled adapters and
host runners; it does not require the beautiCode source repository or private
workspace packages at runtime.

`codex health` is also read-only, but reports runtime health rather than the
installation marker: owned scheduled task, outer guardian, Codex process,
loopback CDP, selected main page, and visible/offscreen background entry.
It never launches or restarts Codex. On Windows, Codex install uses a
current-user, limited-privilege logon task with bounded failure restart; an
already-running Codex without CDP after the 10-second repair window must be
reopened by the user. Uninstall removes only the owned task and legacy Run
value, preserving backgrounds and themes.

WorkBuddy creates its background stage as soon as its navigation is mounted.
Explicitly cleared state and saved media take precedence over the bundled
default wallpaper. Its runner writes a rotating log directly to
`%LOCALAPPDATA%\beauticode\logs\wb-runner.log`, including launches through
the hidden login VBS. `workbuddy status` reports the log's presence, writable
status and update time; a missing or empty log alone does not prove the
guardian has stopped. Theme-name diagnostics use per-process keyed hashes and
lengths only; they do not rewrite existing theme names.

On install, host runners are copied into the user-owned stable runtime under
`%LOCALAPPDATA%\\beautiCode\\runtime`. Startup entries invoke only the stable
launcher; they resolve an absolute Node.js >=22 at login and ignore
WorkBuddy-managed sandbox Node paths. A verified sandbox Node is copied into
that host runtime only as a recorded fallback. Moving or removing the npm
package after install therefore does not invalidate the runner. Uninstall
removes only beautiCode's startup wiring and preserves host state and media.

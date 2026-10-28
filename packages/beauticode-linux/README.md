# beauticode-linux

Local image and video backgrounds for desktop AI clients on **Linux (x64)**:
Codex (the ChatGPT desktop app), Cursor and WorkBuddy. Unofficial; MIT.

This is the Linux build of beautiCode. Windows users install
[`beauticode-desktop`](https://www.npmjs.com/package/beauticode-desktop) instead;
both packages share the same CLI and host runtimes from this repository.

## Requirements

- Linux x64 with a graphical session (X11 or XWayland), Node.js 22 or newer.
- `zenity` (GNOME/most desktops) or `kdialog` (KDE) for the in-app file picker,
  e.g. `sudo apt install zenity`.
- The client installed from its official Linux package:
  - Codex: `/usr/lib/chatgpt` (ChatGPT desktop app);
  - Cursor: `.deb`/`.rpm` in `/usr/share/cursor` or `/opt/Cursor`, or set
    `BEAUTICODE_CURSOR_EXECUTABLE`;
  - WorkBuddy: `/opt/WorkBuddy`.

## Install and use

```sh
npm install -g beauticode-linux --foreground-scripts
beauticode-linux all install        # guardians + "(背景)" launcher entries for all clients
beauticode-linux codex install      # or one client: codex | cursor | workbuddy
beauticode-linux all status
beauticode-linux cursor health      # CDP, host page and 背景 entry check
beauticode-linux codex uninstall    # per client; removes only beautiCode-owned files
```

Then open the client (from its normal icon or the `beautiCode <Client> (背景)`
entry) and use the injected **背景** entry: import an image (JPG/PNG/WebP/AVIF)
or a video (MP4/MOV), switch saved themes, adjust shadow/blur, open the skin
center (皮肤中心) to install themes, or clear the background. Themes persist
across client restarts.

What `install` writes for the current user (no root, no system files):

- a stable runtime under `~/.local/share/beautiCode` (`$XDG_DATA_HOME`) with a
  POSIX `launcher.sh` per client, plus logs and per-client state;
- an XDG autostart entry in `~/.config/autostart` marked
  `X-BeautiCode-Managed=true` that starts the guardian at login (and now);
- a `beautiCode <Client> (背景)` entry in `~/.local/share/applications` that
  starts the client with a loopback-only (127.0.0.1) debugging port;
- WorkBuddy also keeps its port in `~/.config/beauticode` and
  `~/.config/environment.d/beauticode-wb.conf`.

If a client is opened from its own icon without the debugging port, the
guardian restarts it once with the port (only within ~10 s of launch).
`uninstall` stops the guardian, restores open client windows and removes the
autostart and `(背景)` entries; entries beautiCode does not own are left alone.

## Known limitations

- No tray app on Linux; the built-in animated ambience themes (e.g. the rainy
  window) are tray/DSH-only and not available here.
- x64 only.
- Cursor: after the guardian's repair restart, only Cursor's default window
  reopens; a folder window you had opened by path is not restored (reopen it
  with `cursor <folder>`). The 背景 entry needs a workbench window.
- Cursor/WorkBuddy skin center opens in your default web browser.
- WorkBuddy: the 背景 entry lives in the signed-in sidebar; features were not
  verified while signed out.
- Doubao has no Linux client and is skipped.

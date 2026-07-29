# apps/tray

Windows system-tray entry for beautiCode.

## Design

- **No second Electron shell.** Uses PowerShell `NotifyIcon` + a compact,
  borderless WinForms control panel and a small Node session host
  (`session-host.mjs`) over a **loopback localhost HTTP** control channel with
  a random bearer token.
- The primary tray surface is the dark "ink console" panel. A native
  `ContextMenuStrip` remains available as a fail-soft fallback and provides
  the saved-theme submenu.
- Reuses `@beauticode/adapter-codex` `BeautiSession` (single injector lock,
  live verify, watch/reapply; Codex uses data/blob transport, not loopback
  media HTTP).
- Never binds off `127.0.0.1`. Never launches Codex with `0.0.0.0` debugging.

## Menu

Left-click or right-click the beautiCode tray icon to toggle the control panel.
The panel closes on focus loss or `Esc` and is clamped to the active monitor's
working area.

| Item | Action |
|---|---|
| Status (disabled) | Running/busy + current media type (+ 摸鱼 when on); no CDP / generation |
| Apply or re-apply | Ensure ChatGPT/Codex is running with loopback CDP; import the stored default (active) background |
| Change image… | OpenFileDialog → image apply + live verify |
| Change video… | MP4 dialog → video apply |
| Clear background | Clear + verify (also exits fish mode) |
| Fish mode / Fish mode ✓ | Toggle 摸鱼: hide host content chrome, full-bleed media at native brightness. Same as `Ctrl+Shift+Space`. Refuses without an active background. |
| Video sound / Video sound ✓ | Toggle background video audio. Default muted. Checked = sound on. Independent of fish mode. Not persisted. If unmute is blocked by autoplay policy, keeps playing muted and shows a tip. |
| Save current theme | Persist active image/video under a name (video also stores current playback position) |
| Saved themes | Restore a previously saved theme; video themes resume at last position (invalid → start) |
| Delete saved theme | Confirm, then remove one saved theme |
| Quit | Leave fish mode if needed, stop session host, unregister hotkey, remove tray icon |

### Fish mode (摸鱼)

- **Hotkey:** `Ctrl+Shift+Space` global toggle (enter + exit). Fail-soft if another app already owns the chord — tray menu still works.
- **Not persisted** across tray restarts.
- **Content area only** — window titlebar / taskbar stay as Codex/ChatGPT.
- Attribute-only (`data-bc-fish`); does not rebuild media or bump generation.
- Soft input guard: invisible + no pointer + blur; no global key swallow.

### Video progress on saved themes

- Progress is **bound to each saved video theme** (`theme.json` → `videoPositionSec`).
- While that theme is the active bound background, position is written continuously (~2s, throttled).
- Restoring the theme seeks to the stored position; invalid / past end → start at 0.
- Switching via Change image/video or Clear unbinds continuous writes (does not erase the theme's last position).

CDP discovery, CDP help, and standalone Start/Restart ChatGPT entries are
intentionally omitted — “Apply or re-apply” owns host launch/restart.

## Run

```bash
# from repo root (builds workspaces first)
npm run tray

# or directly
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File apps/tray/start-tray.ps1
```

Optional:

```powershell
.\apps\tray\start-tray.ps1 -Port 9335
.\apps\tray\start-tray.ps1 -DataRoot "$env:TEMP\bc-tray-test"
```

## Security notes

- Control server: `http://127.0.0.1:<ephemeral>` only
- Every mutating route requires `Authorization: Bearer <token>`
- Token is random per tray process, inherited through a child-only environment
  variable, removed from the child environment after startup, and never placed
  in process arguments
- File picks go through the OS dialog; paths are still validated by core media gates
- Apply failures surface the verify/rollback error — disk success is not claimed as UI success
- ChatGPT is only started with `--remote-debugging-address=127.0.0.1` (loopback)

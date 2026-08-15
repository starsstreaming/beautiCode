# Host adapter contract

## Principles

1. **Background-first and scoped.** The injected stage owns media. The adapter
   may make the known main/sidebar surfaces translucent while
   `data-bc-active="true"`, but must not restyle the composer, utility bar, or
   arbitrary token/class surfaces.
2. **No pointer capture.** Stage and media use `pointer-events: none`.
3. **No official binary patching.** Prefer loopback CDP against a user-started
   or adapter-started host that already exposes debugging.
4. **Generation-guarded runtime.** Every injected session carries a generation;
   stale async media callbacks are ignored.
5. **Fail closed on missing CDP.** If the host build dropped
   `--remote-debugging-port` support (upstream #235), report a clear error —
   do not spin forever or claim success.

## DOM contract (Codex Desktop)

Injected nodes (v1):

| Node | Role |
|---|---|
| `#beauticode-bg-stage` | Full-viewport stage, behind app chrome |
| `#beauticode-bg-stage > img` | Poster / static image |
| `#beauticode-bg-stage > video` | Optional MP4 layer |

Attributes on `html`:

| Attribute | Values |
|---|---|
| `data-bc-active` | `true` when a background is applied |
| `data-bc-media` | `image` \| `video` \| `video-pending` |
| `data-bc-video-ready` | `true` \| `false` |
| `data-bc-generation` | decimal generation string |
| `data-bc-working` | `true` while a project/task thread is confirmed open (background dim only) |
| `data-bc-fish` | `true` while fish mode (摸鱼) is on — content chrome hidden; media at native brightness |

## CSS contract

Allowed:

- positioning/stacking for `#beauticode-bg-stage` and its descendants
- visibility rules gated on `data-bc-media` / `data-bc-video-ready`
- optional dimming scrim **inside the stage** for text contrast — only while
  `data-bc-working="true"`. Home / just-imported media stays at source brightness
- exact `main.main-surface` / `aside.app-shell-left-panel` transparency needed
  to reveal the stage (gated on `data-bc-active`)
- a main-surface readability wash when `data-bc-working="true"`
- fish mode (`data-bc-fish="true"`): hide `#root` / dialogs via opacity+visibility
  (no DOM teardown), drop stage veil/filter, keep stage `pointer-events: none`

Focus/working dim detection (renderer-local, fail open):

- Only when a project/task thread is confirmed open (thread scroll, message
  roles, selected sidebar task) — **not** the home / new-task landing
  (`[data-testid="home-icon"]`)
- Agent generation on the landing does **not** dim
- Never captures pointer; detector errors leave the background bright

Forbidden:

- rewriting host composer radius/border/shadow
- clearing host token surface backgrounds globally
- forcing utility-bar `z-index` / transforms
- introducing horizontal document overflow

## CDP safety

- Connect only to `127.0.0.1`
- Cap `/json/list` and `/json/version` response bodies before JSON parse
  (upstream #280)
- Reject redirects off loopback
- Identity-check the browser target before injection
- Accept only exact `app://-/` page targets with a Codex/ChatGPT/OpenAI title
  in production; loopback HTTP pages require an explicit test-mode option
- Single watcher ownership — never start a second injector against the same
  session without stopping the first (upstream #222)

## Verify integration

Adapters implement:

```ts
interface HostVerifier {
  verify(expected: {
    generation: number;
    media: "image" | "video" | "clear";
  }, opts: { deadlineMs: number }): Promise<VerifyResult>;
}
```

`VerifyResult` distinguishes `pass` | `fail` | `inconclusive`. The verifier may
wait through transient inconclusive samples, but a transaction finalizes only
on `pass`; deadline-level inconclusive results roll back.

## Fish mode (摸鱼)

Process-local attribute toggle — **not persisted** across tray/process restarts.

| Rule | Behavior |
|---|---|
| Enter | Requires an active image/video background; otherwise refuse |
| Toggle | `html[data-bc-fish]` only — zero media rebuild, no generation bump |
| Exit paths | Tray menu, `Ctrl+Shift+Space` global hotkey, clear background, tray quit |
| Scope | Content area only (window titlebar / taskbar unchanged) |
| Input | Soft: hide + no pointer + blur active element (no global key swallow) |
| Watch/reapply | Desired fish state re-asserted after inject so it cannot be dropped |

Control plane: `POST /mode/fish { "enabled": true|false }` (Bearer token).

## Video mute / sound

Process-local preference — **default muted**, **not persisted** across tray restarts.
Independent of fish mode.

| Rule | Behavior |
|---|---|
| Cold start | Always begin muted so autoplay is not blocked, then apply preference |
| Toggle | `video.muted` only — zero media rebuild, no generation bump |
| Unmute blocked | Keep playing muted; report `blocked: true` (tray tip) |
| Watch/reapply | Preference re-asserted after inject / blob attach |
| Clear background | Mute preference kept (applies to the next video) |

Control plane: `POST /mode/muted { "muted": true|false }` (Bearer token).
`muted: true` = silent (default). `muted: false` = try to enable sound.

## Saved-theme video progress

Per-theme resume position stored in `saved/<id>/theme.json`:

| Field | Meaning |
|---|---|
| `videoPositionSec` | Last known `HTMLVideoElement.currentTime` (seconds) |
| `videoPositionUpdatedAt` | ISO timestamp of last write |

| Rule | Behavior |
|---|---|
| Binding | Set when user saves or restores that theme; cleared on manual image/video/clear apply |
| Continuous write | Watch loop (~2s throttle, skip &lt;0.5s deltas) while bound video theme is active |
| Restore | `video.startAt` on next inject; runtime seeks once metadata is ready |
| Invalid / past end | Seek to **0** (start over) |
| Image themes | No position field |

Runtime API: `getPlaybackPosition()` / `seekTo(seconds)` (no media rebuild).

## Out of scope for adapter-codex v1

- Full theme CSS packs
- DOM screenshot pipelines
- Non-Codex hosts (terminal adapters come later and share only `packages/core`)
- Renaming the host window title / taskbar icon for disguise
- Persisting fish mode across tray restarts

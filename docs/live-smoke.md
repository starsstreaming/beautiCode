# Live Codex smoke

Goal: prove the closed loop against a **real** Codex Desktop CDP endpoint without
touching the default user data root.

## Safety rules

1. **Loopback only.** Probe/apply talk to `127.0.0.1`.
2. **Isolated data root.** `scripts/live-smoke.mjs` defaults to a temp directory.
   It never writes under `%LOCALAPPDATA%\beautiCode` unless you pass
   `--data-root` yourself.
3. **Best-effort clear.** Smoke clears the injected background at the end
   (override with `--keep` only when you intend to leave it).
4. **Fail closed.** Missing CDP, junk MP4, dual injector lock, and verify failure
   are expected hard failures — not retries that claim success.
5. **No host binary patching.** Codex must already expose
   `--remote-debugging-port` (and preferably `--remote-debugging-address=127.0.0.1`).

## Prerequisites

- Node.js 22+
- Codex Desktop running with loopback CDP
- `ffmpeg` on `PATH` for the video step (image/reject steps still run without it)

### Finding the CDP port on Windows

Codex may pick a non-default port. Inspect the main process command line for
`--remote-debugging-port=N`, or probe candidates:

```bash
npm run bc -- probe --port 9335
```

A healthy probe lists at least one primary `app://-/index.html` page. Overlay
targets such as `initialRoute=%2Favatar-overlay` are ignored by the injector.

## Run

```bash
npm run smoke:live -- --port 9335
```

Options:

| Flag | Meaning |
|---|---|
| `--port <n>` | Required. Loopback CDP port |
| `--data-root <dir>` | Override isolated store root |
| `--skip-video` | Skip MP4 apply when ffmpeg is missing or you only want image |
| `--keep` | Do not clear the background after success |
| `--verify-ms <n>` | Live verify deadline (default 45000) |

## What it checks

1. CDP probe + primary `app://` shell present
2. Injector lock behavior (stale takeover / live reject)
3. Junk `.mp4` rejected (no host success claim)
4. Apply image → live verify → snapshot audit (`pointer-events: none`, no
   horizontal overflow, generation match, not overlay-only)
5. Apply video (if fixtures built) → live verify
6. Clear → empty manifest
7. Dead-port probe fails closed

## Manual one-shots

```bash
npm run bc -- probe --port 9335
npm run bc -- apply-image .\fixtures\poster.png --port 9335 --data-root %TEMP%\bc-smoke
npm run bc -- apply-video .\fixtures\poster.png .\fixtures\loop.mp4 --port 9335 --data-root %TEMP%\bc-smoke
npm run bc -- clear --port 9335 --data-root %TEMP%\bc-smoke
```

## Known host notes

- Current Windows Codex package may launch as `ChatGPT.exe` with
  `--remote-debugging-address=127.0.0.1 --remote-debugging-port=<n>`.
- Multiple page targets are normal; beautiCode ranks the primary shell and
  skips avatar/titlebar overlays.
- If CDP disappears after a host update (#235 class failure), probe/apply must
  error clearly — never report success from disk alone.

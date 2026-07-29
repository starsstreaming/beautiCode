# Media contract

Schema id: `beauticode.background/v1`

## Manifest shape

```json
{
  "schema": "beauticode.background/v1",
  "generation": 12,
  "background": {
    "type": "image",
    "image": "poster.jpg"
  },
  "updatedAt": "2026-07-28T00:00:00.000Z"
}
```

Video form:

```json
{
  "schema": "beauticode.background/v1",
  "generation": 13,
  "background": {
    "type": "video",
    "image": "poster.jpg",
    "video": "background.mp4"
  },
  "updatedAt": "2026-07-28T00:00:00.000Z"
}
```

Rules:

- `schema` must be exactly `beauticode.background/v1`
- `generation` is a monotonic integer owned by the store
- `background.image` is **always required** (poster while video is pending)
- `background.video` is optional; when present, `type` must be `"video"`
- Media names are **basenames only** inside the active/staging directory
  (`poster.jpg`, `background.mp4`). No absolute paths, no `..`, no separators.

## Image validation

| Check | Rule |
|---|---|
| Extension | `.jpg` / `.jpeg` / `.png` / `.webp` (case-insensitive) |
| Type | regular file after `lstat` + `realpath` |
| Symlink / reparse | rejected at the import boundary |
| Size | `1 byte … 18 MiB` (matches the current data-URL publish limit) |
| Magic | JPEG / PNG / WEBP signatures |

## Video validation

| Check | Rule |
|---|---|
| Extension | `.mp4` only |
| Type | regular file after `lstat` + `realpath` |
| Symlink / reparse | rejected |
| Size | `1 byte … 500 MiB` |
| Container | first ISO-BMFF box size sane and type `ftyp` |
| Companion image | required |

Codec guidance (not a hard gate): H.264/AVC video with AAC or no audio is the
practical target for Chromium-based hosts. Container validity ≠ decodability;
decode failure must fail live verification and roll the transaction back.

## Playback semantics

1. Image is painted as the poster while video is pending; video failure still
   fails verification and rolls the transaction back.
2. Video starts hidden (`opacity: 0`) until the first decoded frame.
3. Only after first frame: mark ready, reveal video, drop poster attribute.
4. On error / abort after retries: hide video and report `videoFailed`; the
   transaction restores the previous generation. Clear removes both layers.
5. Every apply increments `generation`. Stale video event handlers must no-op
   when their generation does not match the live generation.
6. Theme/background switches must pause, detach listeners, revoke object URLs,
   and hand off or dispose the previous `<video>` node to avoid double-decode
   and poster flash.
7. While a replacement video is loading, the **previous** visible background
   remains until the new one is ready or the operation fails.

## Transport modes

| Mode | When | Notes |
|---|---|---|
| `blob` | Preferred on Windows via CDP file input | Avoids CSP friction for local bytes |
| `server` | Loopback URL fallback | `http://127.0.0.1:<port>/media/<token>` |

Server mode requirements are defined with the media-server module: token header,
origin allowlist, Range/206, re-stat + identity check per request.

## Non-goals

- GIF/WebM/MOV
- Streaming remote URLs as backgrounds
- Theme ZIP packages (v1)

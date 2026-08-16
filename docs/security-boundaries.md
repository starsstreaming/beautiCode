# Security boundaries

## Hard rules

1. **Never modify** official host installs, `app.asar`, signatures, MSIX/AppX
   packages, or vendor-managed config that the host rewrites on launch.
2. **Never** silently write API base URLs, API keys, auth tokens, or model relay
   settings.
3. **Loopback only** for CDP and media serving (`127.0.0.1`). No LAN bind.
4. **No arbitrary filesystem exposure.** The media hub serves only explicitly
   validated staged assets behind per-file random token routes. Wrong token /
   wrong origin → 403.
5. **Path containment.** Active and staging trees live under the beautiCode data
   root. Imports are copied in; symlinks and reparse points are rejected at the
   trust boundary. A `.beauticode-root.json` ownership marker prevents an
   unrelated non-empty directory from being adopted as `--data-root`; empty
   roots and valid legacy beautiCode roots are adopted automatically.
6. **Content gates before serve/apply.**
   - Image: allowed extension, size cap, magic-byte sniff
   - Video: `.mp4`, size cap, non-empty, real `ftyp` box, regular file
7. **Bounded network reads.** CDP `/json/*` and any local HTTP body used for
   control-plane decisions are length-capped before JSON parse.
8. **Fail closed.** Missing CDP, failed verify, drifted media bytes, or broken
   generation → do not claim success; roll back when a snapshot exists.
9. **User media stays local.** No upload, no telemetry of image/video bytes.
10. **Background-only DOM.** Injected CSS/JS must not capture pointer events on
    host chrome and must not rewrite composer/sidebar layout ownership.

## Trust zones

| Zone | Trust | Notes |
|---|---|---|
| beautiCode data root | Owned | Explicit only: `BEAUTICODE_DATA_ROOT` or `--data-root`. No hidden default (tray defaults to `%LOCALAPPDATA%\beautiCode` and passes it explicitly) |
| Imported user media | Untrusted input | Validated then copied into data root |
| Loopback media server | Guarded | Token + origin + re-stat + identity hash |
| Host renderer | Untrusted peer | May navigate, hide, or drop nodes; generation guards required |
| Official host install | Read-only foreign | Detect version/CDP; never patch |

## Headers and tokens

- Media auth header: `X-BeautiCode-Media-Token`
- Media token: 128-bit+ entropy (`randomUUID` hex, no dashes)
- Tokens are single-route capabilities, not user passwords; still never logged
  in full

## Explicit non-goals (v1)

- Remote theme download / signature policy
- Multi-user shared media roots
- Serving anything except the currently staged/active background video

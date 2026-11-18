# Current host capabilities and acceptance scope

This matrix describes implemented behavior, not a claim that every host version
has completed live acceptance. Media extensions currently accepted by core are
JPG/JPEG/PNG/WebP/AVIF and MP4/MOV. File headers and size limits are validated;
adding an extension to a dialog does not add decoding support.

| Capability | Codex | DSH Web/Desktop integration | WorkBuddy | Cursor / Doubao |
| --- | --- | --- | --- | --- |
| Local image/video import and clear | Implemented | Implemented | Implemented | Implemented |
| Save and select themes | Implemented | Implemented | Implemented | Implemented |
| Delete saved theme records | Implemented | Implemented | Not exposed as an equivalent manager | Not exposed as an equivalent manager |
| Relocate a moved local source | No dedicated flow | No dedicated flow | No dedicated flow | No dedicated flow |
| Per-theme playback resume | Core-backed support | Backend-dependent; verify chosen backend | Not promised | Not implemented as an equivalent core contract |
| Audio preference | Implemented | Backend-dependent | Implemented | Implemented |
| Per-window audio evidence | Returned by CDP toggle; can be partial or unknown | Not promised as equivalent evidence | Not promised | Not promised |
| Cancel an online skin download and query receipt | Implemented in background panel | Implemented in background panel | Not yet equivalent to the panel protocol | Not yet equivalent to the panel protocol |
| Visibility evidence | Renderer verification | Plugin/client acknowledgement | Media and known-backdrop diagnostics | Media and known-backdrop diagnostics |

`muted` remains a saved preference for compatibility. `actualMuted` is an observed
boolean, or null when there is no video, observations disagree, or a window could
not be checked. It is not a promise about sound output devices or future playback.
Each `outcomes` record reports a window's result. `partial` means at least one
window failed even if another accepted the change.

DSH's aggregate `plugin-wired` state proves recognized files and wiring only.
The plugin UI's own client acknowledgement is a separate observation. The new
DSH `--status` command reads plugin files and explicitly reports
`wiring: not-verified` and `liveVerified: false`; it never launches DSH.

Online operation IDs are scoped to the running host service and retained for a
bounded period after completion. Reopening a renderer can recover its ID from
session storage. A host service restart or expired receipt yields an explicit
unknown result; check the current background before retrying. Downloads can be
cancelled. Once the atomic apply/save phase starts it completes or returns its
failure; closing the panel does not claim to undo that commit.

## Platform and release evidence

- Windows: automated logic, isolated Edge, temporary shortcut COM and package
  tests are covered. Real user registry/startup, live host updates and reboot
  acceptance remain separate.
- Linux: CI and temporary XDG-file tests are available; an actual desktop login,
  compositor/client behavior and autostart acceptance are not established by them.
- macOS: these changes do not establish live acceptance or parity with the
  Windows/Linux aggregate installers.
- Doubao and Doubao Work are distinct applications. Supporting the former does
  not imply support for the latter.
- Build manifests map each candidate to source and hashes. Historical npm
  desktop 1.0.1 / DSH 1.0.30 are separate artifacts; a local candidate does not
  update them. Linux remains source preview until its public package and live
  platform path are validated.

Before a release, record the exact OS, host version, source commit and artifact
hash for image/video import, cancel, clear, multi-window behavior, update,
uninstall, restart and recovery. Leave an untested combination marked unverified.

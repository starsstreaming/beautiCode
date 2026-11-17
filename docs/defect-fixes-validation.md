# Defect fixes and local validation

This branch contains targeted behavior fixes. It does not redesign the UI,
migrate theme schemas, rewrite adapters or replace the packaging architecture.
The earlier phase-one validation document remains a historical run record.

## Coverage

| Audit ID | Result in this branch |
| --- | --- |
| F01 | Both desktop and WorkBuddy catalog installs serialize the complete download, apply and rollback lifetime. Production-handler tests confirm the later success survives an earlier failure. |
| F02 | Catalog and media redirects are rejected before following; rejected bodies are cancelled. |
| F03 | Invalid HTTP targets return errors; async failures and stream errors are contained. |
| F04 | Help/version cannot install; invalid CLI arguments fail before writes. |
| F05 | New staged packages carry source SHA, dirty flag, version and per-file hashes. Linux public installation instructions were replaced with source-preview staging. Historical published/source differences remain a release-reconciliation task; no existing npm artifact was changed. |
| F06 | WorkBuddy's known 5.11.3 layout carrier is transparent. Health distinguishes absent, undecoded, hidden/known-occluded and presentation-unverified media. It does not infer visibility from node presence. |
| F07 | DSH installed status requires the plugin entry, package identity and active recognized wiring. |
| F08 | A new selection, clear or disposal invalidates pending media loads before they can commit. |
| F09 | Video catalog cards use lazy image covers; preview handlers request only images. An explicit apply still downloads the video. No cache/Range architecture rewrite is included. |
| F10 | Disposal cancels pending media, revokes URLs and releases video elements. Receipts are consumed by the runner and the fallback table is bounded. |
| F11 | Owned Windows port values are journaled and restored; later external changes are preserved. |
| F12 | Pickers and validators use core's supported extensions. Unsupported GIF/BMP/WebM/M4V are not advertised as working formats. |
| F13 | Browser CI requires its dependency and rejects skips. Final tarball import/entry tests and hash verification cover the generated output. Replacing source-string rewrites is deliberately deferred. |
| F14 | WorkBuddy install/status/uninstall use the XDG configuration root. Foreign autostart/environment files are preserved rather than overwritten. |
| F15 | Activated owned runtime versions are bounded, retaining current, previous and observed running versions. Unknown process liveness or unowned historical directories prevent deletion. Windows shortcut removal checks target, arguments and description. |
| F16 | WorkBuddy gallery callbacks settle instead of invoking undefined persistence code. |
| F17 | Gallery keyboard focus is contained and restored on close. |
| F18 | Failed operations display failure and retain disk rollback evidence. |
| F19 | Audio feedback retains blocked/session outcomes and labels preference separately from playback. |
| F20 | Outdated catalog responses cannot replace the current filter result or repaint a closed gallery. |
| F21 | Cursor injection and guardian checks accept verified label alternatives with the existing structural/host checks retained. Localized real-host acceptance remains pending. |

The observed reduced-motion defect is also fixed: the atmosphere animation stops
under reduced motion or a hidden document, resumes when allowed, and removes its
listeners when closed.

## Validation record

- Workspace build passed; typecheck passed during the implementation. Final build includes all TypeScript packages.
- Final serial non-browser run: 518 tests, 512 passed, 6 skipped, zero failures.
- Browser suite: 33 passed, zero skipped. The strengthened pending-disposal test also passed in the final four-case browser rerun.
- Production-handler fixtures exercise both concurrent rollback paths and prove that video previews request an image while explicit apply requests a video.
- Browser fixture runs 100 switches and checks URL/receipt cleanup, rapid selection, clear, disposal, localized anchors, known occlusion and motion preferences.
- Twenty staged runtime activations retain the current, previous and pinned-running versions; unknown liveness and foreign directories are preserved.
- Windows shortcut create/read/remove uses real COM only in a disposable temporary directory. Registry and real startup state are not modified.
- A final unpacked tarball verifies its source/asset manifest, read-only help, module imports and tamper detection.

The six skips cover non-Windows platform cases and the explicit Task Scheduler
opt-in. The real Windows Run-key deletion case was excluded by name. Browser and
targeted runs overlap with regression cases and must not be added as unique tests.
One prior assertion required a video element in catalog cards; it was updated to
the intended image-cover behavior, while actual video application remains tested.

## Limits and deferred work

- No real host was installed, closed, restarted or injected; no Windows user
  environment value was changed. WorkBuddy 5.11.3 and localized Cursor claims are
  limited to code/fixture evidence until live acceptance.
- The known WorkBuddy selector is consistent with upstream PR #104. This branch
  uses conservative media states and does not merge that PR or claim an arbitrary
  DOM occlusion heuristic proves visibility.
- Runtime cleanup deletes only marked activated versions. It preserves unmarked
  historical versions and skips cleanup when process discovery is incomplete.
- Existing Linux wiring without ownership markers is a conflict requiring
  inspection, not permission to overwrite it. Relative XDG values fall back to
  the standard absolute configuration directory.
- F05 and F13 are partially addressed engineering/release risks, not fully closed
  claims about historical public packages or a completed packaging redesign.
- T01's earlier copied-Node intermittent failure did not recur in serial runs;
  its original cause is unproven.
- Large refactors, shared service extraction, new host support, theme-manager
  redesign, performance promises and production publication remain out of scope.

## Review and rollback

Use a feature branch in the contributor's fork and an upstream pull request.
Local commits are independent review units; do not push directly to upstream.
Rollback code by reverting the relevant commit group, retaining ownership journals
and user themes. Candidate manifests describe source versions; they do not grant
permission to run installers against a live machine.

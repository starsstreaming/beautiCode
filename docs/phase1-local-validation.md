# Phase one reliability changes

This is the first-stage historical record of the companion repair series. Subsequent targeted fixes and current
remaining boundaries are documented in [defect-fixes-validation.md](defect-fixes-validation.md).

The background integration now rejects unintended CLI actions before installation,
contains local HTTP failures, rejects catalog redirects before following them,
and distinguishes configuration evidence from live background readiness.

## Included behavior changes

- DSH help and version are read-only; unknown, incomplete, or conflicting flags fail without installing.
- WorkBuddy gallery media callbacks settle on success and on persistence errors instead of calling an undefined function.
- Gallery HTTP endpoints return 400 for malformed targets and contain asynchronous failures. Media streams use pipeline cleanup and download cancellation on response closure.
- Catalog, metadata, and media requests reject redirects. Rejected and oversized response bodies are cancelled.
- WorkBuddy Windows environment changes keep an ownership journal before writing, preserve registry value type, verify writes, and restore the original value only while the installed value is still owned. Legacy installs without a journal and external edits are preserved.
- DSH status requires an actual plugin entry, package identity, and a supported active installer record. It reports `plugin-wired`, not live readiness. Unknown/custom wiring is deliberately unconfirmed.
- Failed applies keep rollback evidence and display failure rather than a waiting hint. Audio responses retain blocked/session information and distinguish a saved preference from confirmed playback.
- Codex and DSH galleries confine keyboard focus and restore it on close. Stale catalog results cannot replace a newer selection or repaint a closed gallery.
- A dedicated Windows browser CI job requires the browser runtime and rejects skipped browser tests. Final tarball tests exercise read-only CLI and packaged modules.
- Linux README instructions describe source preview staging rather than an unverified public install command.

## Validation

On Windows with Node 24.16.0:

- Workspace build and typecheck passed.
- Serial non-browser regression run: 511 tests, 505 passed, 6 platform/opt-in skips, zero failures. The real Windows Run-key removal test was explicitly excluded.
- Browser regression: 29 passed, zero skipped, using an isolated Edge process. This includes the previous 27 browser cases and two new gallery cases.
- Final targeted run after boundary and ownership review: 37 passed, zero skipped. It includes final-tarball extraction and import checks. Later changes to failure feedback and closed-response cancellation are covered by their targeted rerun.
- The previous copied-Node runtime test passed in the serial regression run; this does not establish the cause of its earlier intermittent failure.

These counts overlap and must not be added as distinct tests. No real client was
installed, closed, restarted, or injected. Registry writes were mocked. No npm
package or remote branch was published, and CI execution on GitHub is not claimed.

## Reproduce

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
# Set this to a file URL for an installed Playwright module (CI uses 1.65.1).
$env:BEAUTICODE_PLAYWRIGHT_MODULE = 'file:///absolute/path/to/playwright/index.mjs'
node scripts/test-browser.mjs
node --test packages/beauticode-desktop/test/phase1-package.test.mjs
```

Inspect installation tests before running the complete suite on a real machine.
The explicit Task Scheduler opt-in must remain disabled for isolated validation.

## Remaining boundaries

- File transaction concurrency, renderer generation/cleanup, full visibility diagnosis and WorkBuddy 5.11.3 compatibility are later work packages. This phase is not a release approval for every P1 item.
- The existing visibility PR must be reviewed separately rather than silently merged into this branch.
- Full release/source reconciliation, Linux/macOS real-host testing, Windows real registry/startup lifecycle, and long-running performance remain unverified.
- Custom DSH wiring outside the installer's recognized record format reports unconfirmed installation.
- A process terminated while holding the environment journal lock leaves the lock for explicit inspection; it is not automatically removed based only on age.
- Redirects are intentionally disallowed even within the same origin. If the catalog requires redirects in future, add explicit per-hop validation and tests before enabling them.

## References

- [Fetch redirect modes](https://developer.mozilla.org/en-US/docs/Web/API/Request/redirect)
- [HTML inert behavior](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert)

Rollback individual behavior groups with their local commits. No theme schema
migration is included. Do not discard the ownership journal while rolling back
an installation that used it.

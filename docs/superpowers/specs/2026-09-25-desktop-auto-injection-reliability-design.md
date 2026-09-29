# Five-host installation and CDP recovery reliability

Date: 2026-09-25
Status: Approved by user on 2026-09-25

## Goal and contract

One explicit `beauticode-desktop all install` command prepares the five supported Windows hosts. Installation waits for the user to launch each official client from its original icon; it must not alter shortcuts or start those clients itself. On a fresh launch, the corresponding background feature either appears automatically or produces a specific, actionable failure. No installer or watchdog may report success merely because files were written or a launcher was invoked.

The hosts are Codex, WorkBuddy, Cursor, Doubao, and DSH. DSH is a plugin installation, not a CDP host. The other four retain separate guardians because their launch mechanisms and target-page contracts differ. We will make their readiness and one-time recovery behavior consistent without replacing those host-specific mechanisms with a central process manager.

“Every launch” is a conditional operational guarantee: when a healthy guardian observes a single, verified main process during its first 10 seconds, it may perform at most one controlled CDP restart. A process already older than 10 seconds, an ambiguous process, an upstream client that refuses CDP, or a changed UI contract cannot safely be forced into success. These cases must be visible as diagnostics, never hidden by repeated restarts or a false `installed` state.

## Boundaries and responsibilities

The aggregate CLI detects installed hosts, invokes each host's installer, and reports one result per host. It does not own the clients' running processes. A host installer prepares a stable runtime outside the npm cache, wires its independent autostart mechanism, starts or verifies the guardian, then acknowledges readiness. A guardian observes process starts, proves process identity, probes its assigned loopback CDP endpoint, repairs an eligible fresh process once if needed, and injects the host-specific UI into an identified target page. The background runtime and persisted themes remain host-specific; this work does not migrate or overwrite theme data.

The dependency flow is CLI → host installer → stable runtime and guardian → verified host process → loopback CDP → host adapter → UI. Status reads each boundary independently. The installer must not infer the final UI outcome from a guardian PID: a client can be closed at install time, so `guardian-ready / awaiting-client` is a valid successful installation state, while `background-ready` requires a live target and entry check.

## Installation transaction

`all install` is explicit and sequential. For each detected host it prepares its runtime and startup wiring, starts the guardian, and waits for a bounded acknowledgement of the actual guardian process (identity, command line, and creation time). Cursor and Doubao must use a launcher that survives `npm exec` exit; invoking a detached child and immediately printing “installed” is insufficient. WorkBuddy and Codex keep their respective launcher and Task Scheduler strategies, but their installers also distinguish wiring from a living guardian. A failed acknowledgement rolls back only that host's newly created wiring/runtime pointer, preserving the previous working installation where possible; it must not remove another host or user-owned files. The aggregate continues with other hosts, prints installed, skipped, conflict, and failed results separately, and exits nonzero when any detected host fails.

Host discovery uses trusted Windows installation records and verifies the resolved executable's basename, existence, and canonical location before it becomes a launch or process-identity candidate. This covers non-default paths such as `D:\cursor` without accepting arbitrary process paths or unchecked registry strings. The same verified path is used for aggregate detection and the Cursor guardian, and is refreshed when the installation changes. Missing clients are reported as skipped, not installed. No `postinstall` side effects are introduced.

DSH's existing development Junction is a user-owned conflict. The installer must leave it untouched and report that the test-package DSH plugin was not installed. DSH package behavior is verified in an isolated clean profile rather than by replacing that link on this machine.

## Launch and repair state machine

Each guardian persists or derives enough information to de-duplicate by process PID plus creation time. A start event is eligible only when the exact main executable and verified installation path match, it has no Chromium `--type` child argument, there is exactly one relevant main process, and its age is less than 10 seconds. The guardian first checks whether the assigned loopback CDP endpoint belongs to that host. If yes, it connects and injects without restart. If CDP is missing, it records one repair attempt for that process generation, terminates only that verified process tree, relaunches with the bounded CDP arguments, and verifies the new process and endpoint. Transport polling and page reinjection may be bounded retries; they must not trigger a second client restart for the same launch generation.

CDP validation constrains address and port to loopback and the host's candidate range, applies response-size and time limits, and confirms the target page identity before injection. If CDP is live but the background entry is absent, retry target selection or UI injection within a deadline rather than restarting the client. If the structural anchors have drifted, fail closed and report a compatibility error without half-applied styles. Logs use safe host labels and reason codes; they do not contain full page URLs, account text, media paths, or CDP payloads.

When a user closes a client, the guardian waits; it never launches a client merely because none exists. If a guardian crashes, startup wiring restarts only that guardian. On late guardian startup, a host process older than 10 seconds is reported as needing a normal user restart, never force-terminated. An absent creation time, multiple main processes, identity mismatch, port collision, or failed CDP handshake also fails closed with a diagnostic. Existing user work takes priority over background recovery.

## Observability, rollback, and code shape

Each host exposes installation, guardian, host-process, CDP, target-page, and background-entry states separately, with a bounded health-probe deadline long enough for its Windows queries. A timeout identifies the stage that timed out. Installation output includes the exact next action for an old uninstrumented process or an upstream incompatibility. An uninstall removes only that host's owned wiring and runtime, not themes, media files, official binaries, shortcuts, or foreign Junctions. Re-running install is idempotent and should repair broken owned wiring.

The current shared desktop launch module exceeds the repository's 500-line file limit. If its repair path is changed, extract cohesive process observation/recovery responsibilities into a focused module while preserving the public adapter interface. Registry resolution is a shared Windows boundary because both aggregate detection and guardian identity need the same verified result; host-specific DOM selectors and CDP target identities remain in their adapters. Avoid a generalized framework for DSH, which has no CDP lifecycle.

## Verification

Tests cover non-default trusted install paths, invalid registry values, exact main-process identity, 10-second boundary, duplicate events, one controlled restart, user close, ambiguous/old processes, guardian crash, loopback and target identity, wrong-host page rejection, bounded health probes, installer acknowledgement and rollback, aggregate partial failure, and DSH Junction conflict. Test the packed tgz independently of the source checkout, including that its runtime survives `npm exec` exit and remains below 25 MB.

Windows acceptance starts each installed desktop client from its original icon twice and checks CDP, correct target, visible background entry, and no unintended restart after normal close for at least 30 seconds. Verify image/theme persistence and a large-video path without copying media into the guardian. Preserve the current DSH development link and use a clean profile for its package test. Do not close the user's current Codex window solely for this test; request a normal reopen when that host's live acceptance is needed.

The release is a new test package, not a claim of universal compatibility with future client versions. A refusal to expose CDP or a missing DOM contract is a reported incompatibility, not a reason for an unbounded restart loop.

## 2026-09-26 Codex MSIX compatibility amendment

Codex 26.924 revealed an unverified assumption in the approved repair state machine: directly spawning `ChatGPT.exe` inside `WindowsApps` drops the MSIX package identity. Codex then fails startup with “the process has no package identity.” A verified executable path and a free loopback port are not sufficient proof of a safe replacement launch. For an MSIX Codex process, the repair precondition must also include a package-aware activation route that forwards the CDP flags and has been demonstrated on the installed version. Until then, its guardian must not terminate or directly spawn Codex; it reports the incompatibility and leaves the user's original-icon launch intact. This is a safety correction to the original repair contract, not a compatibility shim. Remove the restriction only after a package-activation probe confirms both package identity and the expected loopback CDP target without a launch loop.

The Codex guardian's logon task must remain runnable on battery and must not be stopped when AC power is removed. Its only responsibility while the client is absent is to observe launches; this keeps the approved one-time repair available on laptops without launching Codex on its own.

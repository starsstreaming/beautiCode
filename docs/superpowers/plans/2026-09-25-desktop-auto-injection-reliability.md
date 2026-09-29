# Desktop Auto-Injection Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one explicit package command prepare all detected Windows hosts, with a live guardian and one safe CDP recovery attempt per fresh desktop launch.

**Architecture:** The aggregate installer reports each host independently. Cursor and Doubao share a verified Windows install record and a stable guardian launcher; desktop process recovery uses a single-attempt state machine, while Codex and WorkBuddy retain their existing independent wiring. Read-only health separates installed wiring, guardian, host, CDP, target, and entry.

**Tech Stack:** Node.js >=22, TypeScript 5.8, PowerShell/CIM, Windows Startup VBS and Codex Task Scheduler, Node test runner, npm tarball.

**Spec:** `docs/superpowers/specs/2026-09-25-desktop-auto-injection-reliability-design.md`

## Global Constraints

- Windows only; no official shortcut, installation binary, or client launch path modification.
- One explicit `beauticode-desktop all install`; no npm `postinstall` mutation and no auto-open of clients.
- Only one exact, unambiguous main process younger than 10 seconds may receive one controlled restart per PID and creation time.
- User close and guardian crash never start a client; old/ambiguous processes fail closed.
- DSH development Junction is not replaced, moved, or deleted; test package DSH in a clean isolated profile.
- Do not log full page URLs, account text, media paths, or CDP payloads.
- Preserve user theme state and unrelated dirty worktree files. Modified source files must remain at or below 500 lines.
- The packed test tgz must remain under 25 MB.

## Review Focus

- Registry `DisplayIcon` with a comma/icon index, quotes, or an unrelated executable must not become a launch candidate; Task 1 pins this.
- Guardian acknowledgement from a stale PID file or a process with the wrong creation time must fail; Task 2 pins this.
- An event and a snapshot for the same PID/creation pair must not cause two restarts after failure; Task 3 pins this.
- A live process older than 10 seconds while installation completes must be reported for manual reopen, not killed; Task 4 pins this.
- One host's installer failing after staging must leave other hosts installable and preserve the previously active runtime; Tasks 2 and 4 pin this.

---

## File map

| File | Responsibility |
| --- | --- |
| `scripts/windows-host-install.mjs` | Query and validate registered Cursor/Doubao executable paths; never launch them. |
| `scripts/desktop-cdp-setup.mjs` | Stage/activate runtime, write owned startup wiring, start via VBS, await owned guardian, rollback on failure. |
| `scripts/desktop-runner-identity.mjs` | Validate PID record against the live Windows process, used by setup and status. |
| `packages/adapter-cursor/src/spec.ts` | Add only verified custom Cursor executable from the installer-owned record. |
| `packages/adapter-desktop-cdp/src/launch.ts` | Keep exported API and process-list/launch primitives; move recovery controller and monitor out. |
| `packages/adapter-desktop-cdp/src/startup-repair.ts` | Own PID-generation de-duplication and at-most-one repair transaction. |
| `packages/beauticode-desktop/src/index.mjs` | Consume verified host detection and report per-host installation/guardian outcomes. |
| `integrations/codex-desktop/health.mjs` | Parallel, bounded stage probes with a useful timeout reason. |
| Existing package tests and `docs/beauticode-desktop-test-guide.md` | Contract, tgz, and operator verification. |

### Task 1: Verified custom Cursor installation path

**Files:** Create `scripts/windows-host-install.mjs`; modify `packages/beauticode-desktop/src/index.mjs`, `packages/adapter-cursor/src/spec.ts`, `scripts/desktop-cdp-setup.mjs`, `scripts/pack-desktop-aggregate.mjs`; test `packages/beauticode-desktop/test/all.test.mjs`, `packages/adapter-cursor/test/contract.test.js`.

**Interfaces:** Produce `resolveRegisteredExecutable(host, { query, exists, realpath }) -> string | null` and an installer-owned JSON record `{schema:'beauticode.host-executable/v1',host:'cursor',path:string}`. Aggregate detection and setup use the resolver; Cursor spec reads only that verified record plus conventional candidates.

- [ ] **Step 1: Write failing tests.** Inject registry query rows for `D:\cursor\Cursor.exe`, quoted `DisplayIcon` with `,0`, wrong basename, nonexistent file, and conflicting registrations. Assert only the unique canonical `Cursor.exe` is accepted and `all install` detects it. Assert the Cursor spec ignores a malformed or foreign-host record.

  ```js
  assert.equal(resolveRegisteredExecutable("cursor", {
    query: () => [{ InstallLocation: "D:\\cursor", DisplayIcon: '"D:\\cursor\\Cursor.exe",0' }],
    exists: (file) => file === "D:\\cursor\\Cursor.exe",
    realpath: (file) => file,
  }), "D:\\cursor\\Cursor.exe");
  assert.equal(resolveRegisteredExecutable("cursor", {
    query: () => [{ DisplayIcon: '"D:\\other\\Other.exe",0' }],
    exists: () => true, realpath: (file) => file,
  }), null);
  ```
- [ ] **Step 2: Verify red.** Run `node --test packages/beauticode-desktop/test/all.test.mjs` and `npm run test -w @beauticode/adapter-cursor`; expect the new custom-path assertions to fail.
- [ ] **Step 3: Implement the boundary.** Query HKCU/HKLM uninstall entries with bounded PowerShell/CIM output, parse `InstallLocation`/`DisplayIcon`, normalize and `realpath` the exact executable, require `Cursor.exe`, reject multiple distinct matches, then persist the owner-tagged record atomically during install. Copy the resolver into the packed aggregate runtime and read the record in `spec.ts` before freezing `executableCandidates`; do not accept process paths as registration evidence.

  ```js
  // Pure validation core; query() is the bounded Windows registry adapter.
  const candidates = rows.flatMap((row) => [
    path.win32.join(String(row.InstallLocation || ""), "Cursor.exe"),
    String(row.DisplayIcon || "").replace(/^"|",?\d*$/g, ""),
  ]);
  const verified = [...new Set(candidates.filter(path.win32.isAbsolute)
    .filter((file) => path.win32.basename(file).toLowerCase() === "cursor.exe")
    .filter(exists).map(realpath).map((file) => path.win32.normalize(file)))];
  return verified.length === 1 ? verified[0] : null;
  ```
- [ ] **Step 4: Verify green and package closure.** Run the two task tests, `npm run typecheck -w @beauticode/adapter-cursor`, and the aggregate pack test. Confirm the record-reading path exists inside the packed desktop runtime.
- [ ] **Step 5: Commit only Task 1 paths after reviewing the staged diff.** Example message: `fix: discover verified custom Cursor installations`.

### Task 2: Start-and-acknowledge Cursor/Doubao guardians

**Files:** Create `scripts/desktop-runner-identity.mjs`; modify `scripts/desktop-cdp-setup.mjs`, `scripts/pack-desktop-aggregate.mjs`; test `packages/adapter-desktop-cdp/test/desktop-cdp.test.js`, `packages/beauticode-desktop/test/portable-runtime.test.mjs`.

**Interfaces:** `startDesktopGuardian({startupVbs, pidFile, host, deadlineMs}) -> Promise<{pid:number,createdAtMs:number}>` launches through `wscript.exe //B` and acknowledges only a live owned `desktop-cdp-runner.mjs --watchdog --host <host>` whose PID and creation time match the fresh record. Failure returns a reason code and restores previous startup wiring/runtime pointer.

- [ ] **Step 1: Write failing tests.** Stub spawn, PID record, and process query: launcher exit without runner, stale PID record, wrong host, wrong creation time, and a fresh owned runner. Assert only the last case reports `running`; a failed upgrade retains the prior `current.json` and Startup VBS.

  ```js
  assert.equal(isManagedRunner({ host: "cursor", pid: 42, startedAtMs: 1000, runner: stableRunner, pidFile },
    { pid: 42, createdAtMs: 1000, image: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: `node ${stableRunner} --host cursor --watchdog --pid-file ${pidFile}` }), true);
  assert.equal(isManagedRunner({ host: "cursor", pid: 42, startedAtMs: 1000, runner: stableRunner, pidFile },
    { pid: 42, createdAtMs: 900000, image: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: `node ${stableRunner} --host cursor --watchdog --pid-file ${pidFile}` }), false);
  ```
- [ ] **Step 2: Verify red.** Run `node --test packages/adapter-desktop-cdp/test/desktop-cdp.test.js packages/beauticode-desktop/test/portable-runtime.test.mjs`; expect the new acknowledgement and rollback assertions to fail.
- [ ] **Step 3: Implement one transactional setup.** Stage runtime without activating, record previous pointer/wiring, stop only an owned old runner, activate and atomically wire Startup VBS, invoke `wscript.exe //B <exact startupVbs>` with `windowsHide:true`, then poll the owned PID record for a bounded deadline. On failure restore only owned prior pointer/wiring and discard the new version; never report the `wscript` PID as the guardian. Keep media/theme state intact.

  ```js
  const before = await snapshotOwnedWiring({ pointerPath, startupVbs });
  const staged = await syncStableRuntime({ sourceRoot: REPO, stableRoot, host, entrypoint, filter, activate: false });
  try {
    stopRunner();
    await activateStableRuntime(staged);
    await writeTextAtomic(startupVbs, renderWindowsStartupVbs({ launcher: staged.launcher, args: runnerArgs }));
    spawn("wscript.exe", ["//B", startupVbs], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    const owned = await waitForOwnedRunner({ host, pidFile, deadlineMs: 8000 });
    if (!owned) throw new Error("guardian-not-ready");
  } catch (error) {
    await restoreOwnedWiring(before);
    await discardStableRuntime(staged);
    await restartPreviousOwnedRunner(before);
    throw error;
  }
  ```
- [ ] **Step 4: Verify green and host status.** Run task tests and `cursor status`/`doubao status` in a test profile; `installed` alone must not imply `running`.
- [ ] **Step 5: Commit only Task 2 paths after staged-diff review.** Example message: `fix: acknowledge desktop guardians before install success`.

### Task 3: One controlled CDP repair per fresh process

**Files:** Create `packages/adapter-desktop-cdp/src/startup-repair.ts`; modify `packages/adapter-desktop-cdp/src/launch.ts`, `packages/adapter-desktop-cdp/src/index.ts`; test `packages/adapter-desktop-cdp/test/desktop-cdp.test.js`.

**Interfaces:** Preserve public `DesktopStartupRepairController`, `DesktopStartupSnapshotTracker`, `repairDesktopProcess`, and `startDesktopStartupRepairMonitor` exports. `observe(row)` returns `repaired`, `repair-failed`, `already-handled`, `wait-for-cdp`, or `ignore-stale`; no same-generation second call to `repairDesktopProcess` is permitted.

- [ ] **Step 1: Change the existing retry test to assert one attempt, and add a duplicate event/snapshot failure test.** Assert the second observation is `already-handled` and callback count remains one. Add absent creation time, two main processes, user close, and exact path mismatch cases.

  ```js
  const row = processRow(1000);
  let calls = 0;
  const controller = new DesktopStartupRepairController(async () => { calls++; return "failed"; }, () => 1001);
  assert.equal(await controller.observe(row), "repair-failed");
  assert.equal(await controller.observe(row), "already-handled");
  assert.equal(calls, 1);
  ```
- [ ] **Step 2: Verify red.** Run `npm run test -w @beauticode/adapter-desktop-cdp`; expect the one-attempt assertion to fail against the current two-attempt controller.
- [ ] **Step 3: Extract and implement the recovery module.** Move cohesive controller/snapshot/repair/monitor code out of the 700+ line `launch.ts`; mark a PID-generation handled before invoking its repair callback, leave bounded CDP polling inside the transaction, and never schedule another client kill after a failed transaction. Preserve the event monitor's immediate path and its snapshot fallback. Do not relaunch on an empty snapshot.

  ```ts
  const key = `${processInfo.pid}:${processInfo.createdAtMs}`;
  if (this.handled.has(key)) return "already-handled";
  this.handled.add(key); // set before callback so event and snapshot cannot repeat a kill
  const result = (await this.repair(processInfo)) ?? "verified";
  return result === "verified" ? "repaired" : "repair-failed";
  ```
- [ ] **Step 4: Verify green.** Run adapter build, typecheck, tests and `git diff --check`; confirm both changed TypeScript files are at most 500 lines.
- [ ] **Step 5: Commit only Task 3 paths after staged-diff review.** Example message: `fix: cap fresh desktop CDP recovery at one restart`.

### Task 4: Honest aggregate and Codex health states

**Files:** Modify `packages/beauticode-desktop/src/index.mjs`, `integrations/codex-desktop/health.mjs`, `scripts/wb-setup.mjs`, `integrations/codex-desktop/cli.js` only as required by their readiness checks; test `packages/beauticode-desktop/test/all.test.mjs`, `packages/beauticode-desktop/test/status.test.mjs`, `packages/adapter-codex/test/codex-health.test.js`, `packages/adapter-workbuddy/test/setup-scripts.test.js`.

**Interfaces:** `all install` returns one of `installed`, `skipped`, `conflict`, `failed` per host, with `guardian-ready/awaiting-client` separate from `background-ready`. Codex health returns a stage-specific reason rather than collapsing a slow but healthy Windows task query into a four-second global timeout.

- [ ] **Step 1: Write failing tests.** Simulate a child installer exiting zero while its guardian is absent; assert aggregate failure. Simulate one host conflict and a later successful host; assert continuation and final nonzero. Simulate a Codex task read taking 5 seconds and owned check taking 5 seconds while independent guardian/host probes finish; assert the result is not `probe-timeout`. Verify old blind host yields `manual-restart-available` without a terminate call.

  ```js
  const result = runAllInstall({ ...options, verifyHostInstall: (host) => host === "cursor"
    ? { ready: false, reason: "guardian-not-ready" } : { ready: true } });
  assert.equal(result.results.find((row) => row.host === "cursor")?.outcome, "failed");
  const health = await probeCodexHealth({ installation: async () => { await delay(5000); return ready(); },
    guardian, host: () => [] }, 12000);
  assert.notEqual(health.reason, "probe-timeout");
  ```
- [ ] **Step 2: Verify red.** Run `node --test packages/beauticode-desktop/test/all.test.mjs packages/beauticode-desktop/test/status.test.mjs` and `npm run test -w @beauticode/adapter-codex`; expect new readiness/timeout cases to fail.
- [ ] **Step 3: Implement truthful status.** Make aggregate consume explicit host-installer readiness output rather than subprocess exit alone; keep DSH foreign Junction as `conflict`; keep missing clients `skipped`. In Codex health, launch independent installation/guardian/host probes concurrently, give each a bounded deadline consistent with observed Windows query time, and return the name of the timed-out stage. Preserve safe redaction and no host launch on read-only checks.

  ```js
  const [installation, guardianState, hosts] = await Promise.all([
    bounded("installation", deps.installation(), 12000),
    bounded("guardian", deps.guardian(), 12000),
    bounded("host", deps.host(), 12000),
  ]);
  // Only probe CDP for exactly one host; record `timeout:<stage>` without raw process data.
  ```
- [ ] **Step 4: Verify green.** Run aggregate, Codex, and WorkBuddy tests. Confirm `all status` is still read-only and active Codex is not restarted by these probes.
- [ ] **Step 5: Commit only Task 4 paths after staged-diff review.** Example message: `fix: report real five-host readiness and bounded health`.

### Task 5: Packed test release and Windows acceptance

**Files:** Modify `packages/beauticode-desktop/package.json`, `packages/beauticode-desktop/README.md`, `docs/beauticode-desktop-test-guide.md`, package closure tests if required by new runtime files.

**Interfaces:** Produce `artifacts/beauticode-desktop-0.1.0-test.7.tgz` and its SHA-256; no npm registry publication or remote push without a separate request.

- [ ] **Step 1: Update package version and guide.** Document the exact `npm exec --yes --ignore-scripts --package=<absolute tgz> -- beauticode-desktop all install` form, per-host statuses, the 10-second old-process boundary, and DSH Junction conflict.

  ```powershell
  npm exec --yes --ignore-scripts --package="C:\\path\\beauticode-desktop-0.1.0-test.7.tgz" -- beauticode-desktop all install
  npm exec --yes --ignore-scripts --package="C:\\path\\beauticode-desktop-0.1.0-test.7.tgz" -- beauticode-desktop all status
  ```
- [ ] **Step 2: Run automated verification.** Run the aggregate, desktop CDP, Cursor, Doubao, Codex, WorkBuddy, and DSH package tests; run the pack-closure tests against the new tgz; inspect `npm pack --dry-run` and confirm archive <25 MB.
- [ ] **Step 3: Test the tgz independently.** From a directory outside the repository, run `all status` and `all install` in an isolated profile. After `npm exec` returns, verify owned guardian processes remain alive and no official client was launched.
- [ ] **Step 4: Run in-scope local acceptance.** Preserve the existing DSH development Junction, and verify DSH with a clean profile. For clients the user can safely close, test original-icon launch twice, correct CDP target and visible entry, and 30 seconds with no relaunch after normal close. Do not terminate the current Codex window; request user-driven normal reopen if needed. Report any upstream CDP/DOM incompatibility honestly.
- [ ] **Step 5: Verify artifact and handoff.** Record size and SHA-256, inspect `git status` for unrelated changes, and give the user the tgz link plus a per-host measured matrix. Do not claim all five pass if any live acceptance remains untested.

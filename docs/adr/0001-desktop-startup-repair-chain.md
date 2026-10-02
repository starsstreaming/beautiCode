# ADR 0001: Desktop CDP startup repair budget

Status: accepted (2026-09-28)

Implementation scope clarified on 2026-10-02: the shared repair chain is
currently used by Cursor and Doubao. Codex deduplicates process generations
in its controller; WorkBuddy applies its own fresh-process checks. Unused
MSIX repair and generic Windows termination modules were removed after
the active launch paths stopped calling them.

## Context

Codex, WorkBuddy, Cursor and Doubao each have an independent guardian because
their startup and renderer contracts differ. An official-icon launch may omit
CDP. A controlled relaunch can itself create another main process without CDP;
deduplicating only the original PID does not prevent a restart loop. A stale
PID file also does not prove that a guardian is alive.

## Decision

- Keep the official launch path and per-host guardian. A guardian never starts
  a client merely because no client is running.
- Repair only one verified main process with a known creation time less than
  10 seconds old. Each host uses its own process identity checks; the removed
  generic termination helper does not provide a cross-host guarantee.
- Share `StartupRepairChain` across Cursor and Doubao. Once a repair is
  attempted, its replacement cannot be repaired again. A verified host CDP
  endpoint releases the budget; a subsequently observed user close releases
  it for the next icon launch. If no replacement appears, the budget expires
  after 30 seconds. A PID/creation pair remains handled for five minutes.
- Check guardian liveness separately from installation wiring. WorkBuddy now
  records the watchdog PID, command, runtime path and creation-time envelope;
  Codex and the desktop-CDP guardians retain their existing owned identities.
  The aggregate reports `host`, `client`, `guardian`, `cdp`, `entry` and
  `state` consistently.
- DSH is a plugin, not a CDP host. Its guardian remains `not-applicable` and
  a foreign development Junction is not replaced.

## Consequences and rollback

An upstream client that rejects CDP flags can still start without a background;
we report that condition instead of repeatedly restarting it. A very fast
user close/reopen during an unverified 30-second repair may be conservatively
suppressed; normal close after an observed replacement releases the budget.
To roll back, reinstall the previous aggregate package; installed client files
and saved themes are not modified by this policy.

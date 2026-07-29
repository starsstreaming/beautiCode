# Apply transaction

Goal: **disk write success is never user-visible success.** A background change
is committed only after a live host window confirms it (or after an explicit
offline-stage mode used by unit tests).

## State machine

```text
idle
  → snapshot
  → stage (write staging tree)
  → commit-disk (atomic promote staging → active)
  → publish-media (stage media server; keep previous server)
  → apply-host (inject payload with generation)
  → live-verify
        ├─ pass → finalize (media commit, drop snapshot)
        └─ fail → rollback (restore snapshot, abort staged media, re-apply old)
```

## Snapshot

A snapshot captures:

- active manifest JSON
- active image bytes path (hard-linked when supported, otherwise copied, under
  a snapshot dir inside the data root)
- optional active video bytes path
- current generation

Snapshots **never** leave the beautiCode data root. Rollback refuses paths
outside that root.

## Staging and commit-disk

1. Build a complete staging directory: manifest + image [+ video].
2. Validate the staged tree as a whole.
3. Promote with an exclusive commit marker / directory swap so readers never see
   a mixed image/video/json set (lesson from upstream PR #291 / issue #223).
4. Readers that observe an in-progress marker must refuse the load (fail closed)
   unless the marker is stale beyond `COMMIT_MARKER_STALE_MS` (default 120s).

## Publish-media

- If the new background has video, `MediaServerController.stage(newVideo)`.
- Previous server stays alive until finalize or rollback.
- On rollback: `abort(staged)` and keep the previous server.
- On success: `commit(staged)` which closes the previous server.

## Apply-host

Payload to the renderer includes:

- CSS text (background-only)
- image data URL or blob handoff reference
- video config (`mode`, optional diagnostic URL, local blob attachment)
- `generation` integer

Old generation handlers must ignore events (lesson from video flash / stale
error races in #290 renderer work).

## Live verify

Verify is evaluated on a **visible** host target when possible.

Minimum pass signals for v1:

| Kind | Pass condition |
|---|---|
| Image | background stage present, poster/img visible, no horizontal overflow from our layer |
| Video | above, plus a playable source and `videoReady` for the current generation |

Hard failures (trigger rollback when snapshot exists):

- payload generation mismatch that persists past deadline
- any target reports `videoFailed`
- injector offline when online apply was requested
- our layer introduces horizontal document overflow

Inconclusive signals (retry within the bounded deadline):

- transient native-window binding gaps (upstream #267)
- temporary hidden targets during bring-up (bounded defer only)
- single transient `Runtime.evaluate` blip inside the deadline (#294)

Verify loops are **deadline-bounded** with retries (upstream #222). One-shot
verify racing first paint is a bug. A transaction finalizes only on `pass`; if
the deadline ends inconclusive, it rolls back.

## Rollback

1. Restore snapshot files via the same commit-disk path (re-validation included).
2. Abort any non-active staged media server.
3. Re-publish previous media if video.
4. Re-apply host payload for the restored generation.
5. Clear the temporary snapshot directory only when it is a validated,
   non-link `snap-*` child of the snapshots root.

## Concurrency

- Only one apply transaction runs at a time (mutex).
- Nested apply attempts fail fast with a busy error (upstream tray recursion
  lesson from #292 `$Action` shadowing — we use an explicit mutex instead).

## API sketch

```ts
type ApplyInput =
  | { type: "image"; imagePath: string }
  | { type: "video"; imagePath?: string; videoPath: string; startAt?: number }
  | { type: "clear" };

type ApplyResult =
  | { ok: true; generation: number; mode: "image" | "video" | "clear" }
  | { ok: false; error: string; rolledBack: boolean };
```

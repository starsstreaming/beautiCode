# beautiCode

Unofficial local tool that applies an **image or MP4 video background** to
supported coding hosts. v1 targets **Codex Desktop** via loopback CDP.

> Not affiliated with OpenAI, Anthropic, or any host vendor.
> See [NOTICE.md](./NOTICE.md) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Status

Early rewrite. The first milestone is the closed loop:

**choose image/video → validate → recoverable directory swap → host apply →
live verify → finalize or rollback**

Theme shops, ZIP packs, Safe CSS, and full chrome restyling are **out of scope**.

## Layout

```text
packages/core/            validation, store, apply transaction, media server
packages/adapter-codex/   background-only renderer + CDP helpers
apps/tray/                Windows tray + authenticated loopback control plane
docs/                     behavior contracts
```

## Contracts

- [docs/media-contract.md](./docs/media-contract.md)
- [docs/apply-transaction.md](./docs/apply-transaction.md)
- [docs/host-adapter.md](./docs/host-adapter.md)
- [docs/security-boundaries.md](./docs/security-boundaries.md)
- [docs/upstream-reference.md](./docs/upstream-reference.md)
- [docs/live-smoke.md](./docs/live-smoke.md)
- [docs/codex-cdp-setup.md](./docs/codex-cdp-setup.md)

## Develop

```bash
npm install
npm test
npm run build
```

Requires Node.js 22+ (the CDP adapter uses the built-in `WebSocket`).

### CLI

```bash
# Offline: validate + atomic store only
npm run bc -- apply-image ./wall.png
npm run bc -- apply-video ./poster.jpg ./loop.mp4
npm run bc -- status
npm run bc -- clear

# Live Codex Desktop (host must expose --remote-debugging-port)
npm run bc -- probe --port 9222
npm run bc -- apply-image ./wall.png --port 9222
npm run bc -- apply-video ./poster.jpg ./loop.mp4 --port 9222
npm run bc -- watch --port 9222
```

Live apply runs the full transaction: snapshot → stage/commit → inject →
`__BEAUTICODE_BG__.snapshot()` verify → finalize or rollback. A second injector
is rejected via `injector.lock` (stale dead-pid locks are taken over).

### Find Codex CDP / tray

```bash
npm run bc -- discover
npm run bc -- how-to-cdp
npm run tray
```

See [docs/codex-cdp-setup.md](./docs/codex-cdp-setup.md) and
[apps/tray/README.md](./apps/tray/README.md).

### Live smoke (real Codex)

```bash
# Find --remote-debugging-port on the Codex/ChatGPT main process, then:
npm run smoke:live -- --port 9335
```

Uses an isolated temp data root, rejects junk MP4, applies image/video, audits
`pointer-events` / overflow / generation, then clears. See
[docs/live-smoke.md](./docs/live-smoke.md).

## Security highlights

- Loopback-only control plane + random token kept out of process arguments
- MP4 `ftyp` / image magic gates, size caps, symlink rejection
- Cross-process leases + journaled active-directory swap/recovery
- Apply transaction rolls back when live verify fails
- Background CSS does not restyle the composer or arbitrary token classes
- CDP JSON responses are stream-capped before allocation/parse

## License

MIT — [LICENSE](./LICENSE)

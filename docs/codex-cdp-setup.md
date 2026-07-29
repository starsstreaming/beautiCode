# Codex Desktop + loopback CDP

beautiCode attaches to Codex Desktop over **Chrome DevTools Protocol (CDP)** on
**loopback only**. It never patches the Codex binary and never claims success
from disk alone when CDP is missing.

## Safety rules

1. Connect only to `127.0.0.1` (CLI discovery + injector both enforce this).
2. Prefer hosts that already set `--remote-debugging-address=127.0.0.1`.
3. **Never** use `--remote-debugging-address=0.0.0.0` or a LAN bind.
4. If CDP is gone after a host update, operations **fail closed** with a clear
   error (upstream lesson #235).
5. Only one beautiCode injector may own a host (`injector.lock`).

## Quick path (current Windows Codex package)

Recent Windows Store / AppX builds (process name may show as `ChatGPT.exe`)
often self-enable loopback debugging, commonly on port **9335**:

```text
ChatGPT.exe --remote-debugging-address=127.0.0.1 --remote-debugging-port=9335 …
```

### Discover

```bash
npm run bc -- discover
npm run bc -- how-to-cdp
npm run bc -- probe --port 9335
```

`discover` will:

1. Parse same-user process command lines for `--remote-debugging-port` (Windows)
2. Probe a **bounded** candidate port list on `127.0.0.1` only
3. Keep endpoints that expose a primary `app://` shell (skips avatar overlays)

### Apply once CDP is known

```bash
npm run bc -- apply-image .\wall.png --port 9335
# or auto-pick:
npm run bc -- apply-image .\wall.png --discover
```

### Tray

```bash
npm run tray
```

The tray auto-discovers a healthy loopback endpoint unless you pass `-Port`.

## If discover finds nothing

1. Confirm Codex Desktop is running and a main window exists.
2. On Windows, inspect the main process command line for
   `--remote-debugging-port` (Task Manager → Details → command line, or
   `Get-CimInstance Win32_Process`).
3. Probe that port: `npm run bc -- probe --port <n>`.
4. If the flag is absent entirely, this host build may have dropped remote
   debugging — beautiCode will not invent a private inject path.

### Preferred flags (when you control launch)

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9335
```

**Microsoft Store / AppX** packages may ignore custom CLI arguments. Prefer the
host’s own loopback CDP when present rather than forcing a relaunch.

Windows AppX AppId observed in the field:

```text
OpenAI.Codex_2p2nqsd0c76g0!App
```

Starting via `shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App` opens the app;
it does **not** guarantee custom debugging flags.

## What beautiCode injects

Only a background stage (`#beauticode-bg-stage`) plus generation-guarded
runtime. No composer/sidebar chrome takeover. See
[host-adapter.md](./host-adapter.md).

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `discover` count 0 | Codex closed or CDP removed | Open Codex; re-check process flags |
| `probe` connection refused | Wrong port | `discover` or inspect process cmdline |
| `Another injector is running` | Dual tray/CLI | Quit the other; remove stale `injector.lock` if pid dead |
| `identity changed` | Host relaunched | Retry; watch/tray reconnects |
| Verify fail + rollback | Inject rejected / overflow / gen mismatch | Check `status`; clear; retry image first |
| Windows `UV_HANDLE_CLOSING` on old CLI | Hard `process.exit` during WS teardown | Use current CLI (soft exit) |

## Related

- [live-smoke.md](./live-smoke.md)
- [security-boundaries.md](./security-boundaries.md)
- [host-adapter.md](./host-adapter.md)

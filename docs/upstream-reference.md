# Upstream reference

beautiCode treats [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin)
as a **behavior specification and failure log**, not as a scaffold to fork.

No upstream git history is imported. No cherry-picks of PR branches are
performed. Only independently useful modules may be adapted under MIT with
attribution (see `THIRD_PARTY_NOTICES.md`).

## Referenced commits

| Topic | Commit | Role in beautiCode |
|---|---|---|
| Baseline around video work | `611c101` | Context only |
| MP4 video backgrounds (PR #290) | `865b906` | Media contract, media-server lineage, renderer lifecycle lessons |
| Atomic active-theme writes (PR #291) | `7702162` | Store commit exclusivity / no half-written active tree |
| Verified tray rollback (PR #292) | `a090577` | Apply transaction: snapshot → write → live verify → rollback |
| CSS narrow native chrome (PR #293) | `f196381` | Host adapter rule: background layer only |

## Issues that shape our contracts

These upstream reports are treated as non-negotiable design constraints:

| Issue | Lesson encoded here |
|---|---|
| #235 CDP flag removed by owl runtime | Adapter must detect missing CDP and fail closed; never assume a fixed debug port always exists |
| #200 injector dies after Codex relaunch | Watcher/injector lifecycle must survive host restart or clearly report offline |
| #222 slow machine / dueling watchers | Verify is deadline-bounded and retried; never leave two injectors fighting |
| #223 non-atomic deploy leaves mixed tree | All installs/writes stage then rename; no mid-copy active tree |
| #244 host DOM selectors drift | Background layer must not depend on fragile chrome selectors to stay visible |
| #267 native-window check false rollback | Distinguish hard render failure from inconclusive host signals |
| #294 readiness accepts non-visible nodes | Verify requires real visibility, not just a nonzero DOM box |
| #298 horizontal overflow | Background CSS must not create horizontal document overflow |
| #280 unbounded CDP JSON | All loopback JSON reads are size-capped before parse |
| #277 readiness contract drift | One shared readiness assessment in core/adapter, not duplicated ad hoc |

## What we deliberately do **not** copy

- Theme ZIP / Safe CSS / community gallery / Studio
- Full Dream Skin chrome restyling
- Dual Windows/macOS script copies of the same module
- Brand protocol names (`dreamskin://`, `data-dream-*`, `CodexDreamSkin`)
- Installers that touch official app trees

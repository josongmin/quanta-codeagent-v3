# ADR-0379 — `/session-registry cleanup` slash

Status: Accepted
Date: 2026-05-28

## Context

ADR-0369 wires a 60-second periodic auto-sweep, which is great for
steady-state retention but useless when an operator is investigating
an issue and wants to force an immediate sweep + see the result NOW.
The closest existing UX is `/session-registry stats` (read-only, no
mutation) — operators currently have to wait up to 60s for the next
periodic sweep or restart the process.

The natural fix: a manual-trigger sub-command that runs one sweep,
prints the post-sweep stats, and exits.

## Decision

Add `cleanup` to the `/session-registry` sub-command set:

```
/session-registry cleanup
```

Behaviour:

1. Call `startAutoSweep()` (delegates env-var detection to ADR-0369).
2. `await handle.sweepNow()` — fire-and-await so post-sweep state is
   visible in the rendered output.
3. **`handle.stop()` in `finally`** — critical: we MUST NOT leak a
   periodic timer per slash invocation. The handle's `stop()` is
   NO-THROW + idempotent per ADR-0369, safe to call in every path.
4. Render `formatRegistryStats(await inspectGlobalRegistry())` + the
   string `Sweep complete.` for an unambiguous "operator-requested
   sweep ran successfully" marker.

## Why include stats in the cleanup output

The whole point of the manual trigger is to see what changed. A bare
"Sweep complete" message tells the operator nothing about whether the
sweep evicted anything. Folding stats into the output makes the
slash self-contained — no need to chain `cleanup; stats`.

## Why no `--dry-run` (yet)

ADR-0369 / ADR-0348 / ADR-0361 do not separate "what would be evicted"
from "what is evicted" — `sweepDiskRegistry` + `sweepSqliteRegistry`
commit immediately. Adding `--dry-run` would require either:
- A separate `countCandidatesForSweep(cfg)` function per backend; or
- A `dry` flag threaded through every sweep path.

Both are larger than this slash needs. `--dry-run` is a sibling ADR
candidate when an operator actually asks for it.

## Why no confirmation prompt

`cleanup` is observable, idempotent, and bounded by the existing TTL +
size caps. Unlike `evict <id>` (which can permanently lose a specific
session's events on a typo), `cleanup` only deletes what the periodic
auto-sweep would have deleted anyway. No confirm needed.

## Non-goals

- `--dry-run` (above).
- `--force` (no-op — cleanup is always non-destructive of in-window data).
- Per-backend cleanup (cleanup always runs both backends — same as
  ADR-0369's auto-sweep).

## Files

- `src/apps/cli/session-registry-cmd.ts` — `SUBCOMMANDS` extended,
  new `renderCleanup` function, help menu line added.
- `tests/unit/session-registry-slash.test.ts` — 4 new hellgate cases
  [18-21]: cleanup is known sub-command / output contains stats +
  marker / help lists cleanup / unknown-sub error mentions cleanup.

## Hellgate

`bun test tests/unit/session-registry-slash.test.ts` ⇒ 21/0 fail
(17 retained + 4 new).

## References

- ADR-0345 — `SessionResourceRegistry` closed port (used by
  `inspectGlobalRegistry`)
- ADR-0369 — auto-sweep (the function `cleanup` delegates to)
- ADR-0370 — inspector + `/session-registry stats` (the formatter +
  baseline slash)
- ADR-0374 — `/session-registry evict <id>` (sibling sub-command)
- ADR-0376 — help discovery (the menu this ADR extends)

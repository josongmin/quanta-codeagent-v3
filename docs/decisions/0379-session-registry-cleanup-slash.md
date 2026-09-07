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

1. Call `sweepGlobalSessionResourceRegistryNow()`. The global lifecycle owns
   the mounted registry, frozen sweep config, and periodic handle; cleanup does
   not re-read config or mint a second timer.
2. `await handle.sweepNow()` inside that owner — fire-and-await so post-sweep state is
   visible in the rendered output.
3. Render `formatRegistryStats(await inspectGlobalRegistry())`.
4. Render `Sweep complete.` only when a durable backend was actually swept.
   An in-memory-only process instead renders
   `No durable backend configured — nothing swept.`; handle initialization
   failure is explicit and exits non-zero. Backend sweep outcomes are retained:
   all-failed and partial-success runs also exit non-zero and never print the
   success marker.

## Why include stats in the cleanup output

The whole point of the manual trigger is to see what changed. A bare
"Sweep complete" message tells the operator nothing about whether the
sweep evicted anything. Folding stats into the output makes the
slash self-contained — no need to chain `cleanup; stats`.

## Follow-up: `--dry-run`

ADR-0387 subsequently added `cleanup --dry-run` using backend-specific
candidate counters. It shares the global lifecycle's frozen path snapshot and
does not call the mutating sweep path.

## Why no confirmation prompt

`cleanup` is observable, idempotent, and bounded by the existing TTL +
size caps. Unlike `evict <id>` (which can permanently lose a specific
session's events on a typo), `cleanup` only deletes what the periodic
auto-sweep would have deleted anyway. No confirm needed.

## Non-goals

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

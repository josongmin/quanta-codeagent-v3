# ADR-0284: fork-session-wire composition root

- Status: Accepted
- Date: 2026-06-09
- Related: ADR-0201 (`SessionForker`), ADR-0226 (`ForkSessionPort`)

## Context

ADR-0226 introduced the richer `ForkSessionPort`, but the port alone was not
enough. Without a composed base `SessionForker` plus a concrete
`ConversationCheckpointStore`, the rich fork surface was reachable yet every
real fork collapsed to `fork-not-configured`.

The missing piece was a composition-root wire that:

1. creates or accepts a checkpoint store,
2. adapts it into the base `SessionForker`, and
3. injects the resulting rich `ForkSessionPort` only on surfaces that opt in.

This had to remain default-OFF. Bench/headless/other non-REPL surfaces must not
silently allocate fork state or expose a misleading fork surface.

## Decision

Add `src/agent/fork-session-wire/` as the owning slice for this composition.

- `default-checkpoint-base.ts` constructs the concrete bundle:
  `ConversationCheckpointStore -> SessionForker -> ForkSessionPort`
- `index.ts` exports the wire surface.
- `src/host/runtime/agent-arg-builder.ts` owns the gate:
  `resolveForkSession(enable)` wires the bundle only when the per-surface
  `forkSession` request flag is true.
- CLI REPL is the activating surface through
  `src/apps/cli/repl/slash-surface.ts` `maybeForkSession(args)`.

There is no `QUANTA_FORK_SESSION` env knob. The gate is the surface request
flag, not global process configuration.

## Consequences

- `/fork-checkpoint` can now fork from a real checkpoint base instead of
  surfacing `fork-not-configured`.
- Default-OFF remains intact for surfaces that do not opt in.
- The feature catalog may cite ADR-0284 as the hold-closing wire that made the
  richer fork port live in the CLI REPL.

# ADR-0303 — Thin surfaces, headless core, and the surface-coupling ratchet

Status: Accepted (2026-05-26)
Track: surface governance / future Web-native portability
Slice: cross-cutting architecture rule + `tests/unit/surface-coupling-ratchet.test.ts`

## Context

The repository already has the right long-term direction in parts:

- `@/runner/orchestrate` owns host-neutral turn execution (`runOnce`,
  `runInteractive`).
- `@/runner/assemble` owns host-neutral collaborator assembly.
- `@/agent` owns loop semantics, admissibility, budgeting, and tool dispatch.

But the current interactive/product path still lets the CLI surface own
too much engine work, and some runtime paths still cross-import between
surfaces:

- `src/apps/agent/index.ts` imports CLI helpers (`../cli/dotenv`,
  `../cli/sandbox-wire`).
- `src/apps/agent/mode-presets/interactive.ts` delegates runtime
  ownership to `../../cli/repl`.
- `src/apps/cli/internal.ts` imports `../agent/search-pipeline-wire`.

That shape is survivable today, but it is the exact failure mode that
makes a terminal surface get "fatter" over time: one-off host logic
turns into reusable runtime logic, then new features pile onto the same
surface because it already owns too much.

This ADR sets the rule BEFORE more Web / native / daemon work lands.

## Decision

### 1. Thin-surface invariant

`src/apps/*` surfaces exist to ADAPT a host, not to own reusable agent
semantics.

Surfaces MAY own:

- host input/output boundaries (`argv`, HTTP body, IPC payload,
  `stdin`/`stdout`/`stderr`, TTY, browser UI, native UI),
- host-specific rendering (terminal chrome, web widgets, desktop panes),
- composition-root projection from host config into typed inputs,
- host-owned ports whose meaning is inherently surface-specific
  (`UserInputPort`, `PlanExitPort`, OAuth callback handling, browser
  automation glue, OS sandbox installation).

Surfaces MUST NOT own:

- reusable prompt/turn/session semantics,
- reusable resume/persist/orchestrate flow,
- reusable tool or permission policy,
- reusable feature wiring that another surface would need unchanged,
- runtime state that the engine must later consult to decide behavior.

If the logic could be reused by CLI + Web + native with only a different
transport or renderer, it belongs below `src/apps/`.

### 2. No new cross-surface runtime imports

No new runtime import may be added from one app surface to another app
surface.

Examples:

- `src/apps/agent/** -> src/apps/cli/**` is forbidden for new code.
- `src/apps/cli/** -> src/apps/agent/**` is forbidden for new code.
- The same rule applies to future `src/apps/web/**`, `src/apps/native/**`,
  or any new surface.

Type-only imports are not the target here. The rule is about runtime
coupling and ownership drift.

Current debt is frozen, not blessed. The ratchet test documents the only
remaining allowed edges and blocks new ones. Debt reduction is allowed at
any time.

### 3. Single-owner state rule

If a state change can affect ANY of the following on a later turn:

- `AgentConfig`,
- tool policy,
- prompt contents,
- loop behavior,
- admissibility or confirmation posture,
- persistence or replay output,

then that state must have ONE authoritative owner on the engine-wired
path.

Allowed authority homes:

- `AgentConfig` / `SessionDeps`,
- a typed host port injected into the engine,
- a host-owned mutable cell that is directly read by the assembler or the
  loop on the next turn.

Disallowed shape:

- a slash/UI adapter mutates its own private state cell,
- the engine continues reading an older disconnected state source,
- both appear "wired" from the UI, but only one actually changes runtime
  behavior.

Surface mirrors are acceptable only when they are projections of an
authoritative engine-wired state, never the sole source of truth.

### 4. No terminal defaults in engine/core

Terminal concerns belong to surfaces.

Outside `src/apps/**`, new code must not default to:

- `process.stdin`,
- `process.stdout`,
- `process.stderr`,
- `readline`,
- raw TTY mode,
- `process.exit(...)`.

Core/runtime code may accept a sink, callback, or port. It must not bake
terminal ownership into its default path. A missing sink should degrade
to a typed no-op or a host-supplied logger, not silently assume a
terminal.

Existing exceptions are debt and should be reduced, not copied.

`tests/unit/terminal-defaults-ratchet.test.ts` freezes the current debt
ceiling and blocks new non-surface stdio/exit defaults.

### 5. ADR gate for new surface features

Any change that does ONE or more of the following must update an existing
ADR or add a new one:

- introduces a new host port,
- introduces new mutable surface-owned state,
- introduces a new cross-surface dependency,
- moves logic from engine/core into a surface,
- adds a host-specific fallback/default inside engine/core.

The ADR must answer:

1. What is the authority owner for the state?
2. Why is the logic surface-specific instead of engine-level?
3. Could Web/native reuse this unchanged?
4. What invariant prevents a second source of truth?
5. What proof rail or ratchet keeps the decision from drifting?

## Architecture rules

### Placement rule

When adding a feature, choose exactly one home:

- `@/runner/orchestrate` — transport-neutral turn/session execution.
- `@/runner/assemble` — transport-neutral collaborator assembly.
- `@/agent` / lower slices — reusable runtime semantics.
- `src/apps/<surface>` — host I/O, host rendering, host-owned ports only.

If a change spans two homes, split it.

### Surface checklist

Before merging a surface change, answer all of these:

1. Can the logic run without a terminal?
2. If not, is the non-portable part isolated to `src/apps/<surface>`?
3. Does any new mutable state have an engine-visible authoritative path?
4. Did this add a new runtime import from one surface to another?
5. Is there a ratchet or test that prevents the same coupling from
   growing silently?

If any answer is "no" or "unclear", the placement is wrong.

## Ratchet

`tests/unit/surface-coupling-ratchet.test.ts` freezes the current
cross-surface runtime-dependency debt ceiling.

The test blocks:

- any new `src/apps/<a> -> src/apps/<b>` runtime import,
- any widening of the current debt set,
- any "temporary" cross-surface helper import that is not explicitly
  reviewed and documented.

The test intentionally permits debt reduction.

## Current frozen debt

As of this ADR, the only allowed cross-surface runtime imports are:

- `src/apps/agent/index.ts -> ../cli/dotenv`
- `src/apps/agent/index.ts -> ../cli/sandbox-wire`
- `src/apps/agent/mode-presets/batch.ts -> ../../bench/corpus`
- `src/apps/agent/mode-presets/batch.ts -> ../../bench/eval`
- `src/apps/agent/mode-presets/batch.ts -> ../../bench/report`
- `src/apps/agent/mode-presets/interactive.ts -> ../../cli/repl`
- `src/apps/cli/internal.ts -> ../agent/search-pipeline-wire`

These are migration targets, not precedents.

## Consequences

- New surface features have a stricter placement bar.
- CLI can still evolve, but only as a host adapter and terminal renderer.
- Web/native expansion gets a stable rule: prefer reusing headless engine
  seams, never re-implementing CLI-owned semantics.
- Architecture review becomes simpler because the allowed surface budget is
  explicit.

## Out of scope

- Immediate deletion of the four frozen cross-surface imports.
- Refactoring every existing terminal default out of engine/core in this
  change.
- Rewriting all existing REPL slash/state wiring today.

Those are follow-up migrations. ADR-0303 only fixes the governance rule
and adds a ratchet so the problem stops growing.

## Negative invariants

- Do not add a new surface command that mutates private adapter state when
  the engine keeps reading a different state source.
- Do not move reusable orchestration from `@/runner/*` back into
  `src/apps/cli/**`.
- Do not add new `src/apps/* -> src/apps/*` runtime imports as a shortcut
  around proper ports.
- Do not add a terminal default sink in engine/core just because the CLI
  currently exists.

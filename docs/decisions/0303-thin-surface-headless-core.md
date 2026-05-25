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

At ADR creation time, the interactive/product path still let the CLI
surface own too much engine work, and some runtime paths still
cross-imported between surfaces:

- `src/apps/agent/index.ts` imports CLI helpers (`../cli/dotenv`,
  `../cli/sandbox-wire`).
- `src/apps/agent/mode-presets/interactive.ts` delegates runtime
  ownership to `../../cli/repl`.
- `src/apps/cli/internal.ts` imports `../agent/search-pipeline-wire`.

That pre-migration shape was survivable in the short term, but it was
the exact failure mode that makes a terminal surface get "fatter" over
time: one-off host logic turns into reusable runtime logic, then new
features pile onto the same surface because it already owns too much.

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

### 1.1 Thin does not mean render-only

This ADR defines the repo's required bar as **thin surface**, not
**render-only surface**.

A surface is still considered thin when it owns host-specific adapter work
such as:

- terminal prompt UX,
- slash/UI dispatch,
- status chrome,
- browser/native view glue,
- `stdin`/`stdout` binding,
- argv/HTTP/IPC parsing.

That is allowed because it is host-specific.

What thin forbids is letting those host adapters become an alternate home
for reusable runtime semantics.

A **render-only** surface is stricter: the surface would only transport
events/commands and render results, while almost all interaction policy
would live below `src/apps/**`. That is a possible future target, but it
is NOT the acceptance bar defined by ADR-0303.

### 1.2 Thin acceptance criteria

A surface may be called **thin** only when ALL of the following are true:

1. sibling app-surface runtime imports are zero,
2. non-surface terminal defaults are zero,
3. reusable interactive/session/batch semantics run through host-neutral
   contracts below `src/apps/**`,
4. mutable state that can affect a later turn is engine-owned
   (`SessionDeps`, `AgentConfig`, or a typed host port),
5. the surface owns host adaptation and rendering only,
6. the ratchet/lint rails that enforce the above are green.

If any item fails, the surface is not thin, even if the code "looks small".

### 1.3 Ownership examples

Allowed surface ownership:

- `stdin`/TTY prompt reader,
- terminal/web/native status rendering,
- slash/router dispatch,
- argv/HTTP/IPC parsing,
- host-specific persistence locations,
- host-specific OAuth/browser/native glue.

Not allowed surface ownership:

- the canonical session bootstrap contract,
- reusable batch execution contract,
- prompt variant policy reused by multiple surfaces,
- tool-profile policy reused by multiple surfaces,
- slash-local state that changes behavior while the engine reads something
  else,
- a "helper" import from another app surface because it is convenient.

Rule of thumb:

- if replacing terminal/web/native I/O would keep the logic unchanged, it is
  not a surface concern,
- if removing the host UI would make the logic meaningless, it may be a
  surface concern.

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

Current debt is not blessed. The ratchet blocks new edges, and the target
state is exact zero.

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

`tests/unit/terminal-defaults-ratchet.test.ts` enforces exact zero for
new non-surface stdio/exit defaults.

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

### 5.1 Exception bar

ADR-0303 does not permit silent exceptions.

If a change appears to require one of the following:

- a cross-surface runtime import,
- a non-surface terminal default,
- a private surface-owned state cell that changes later-turn behavior,
- reusable runtime logic inside `src/apps/**`,

then the change must do one of these:

1. move the logic below `src/apps/**`,
2. introduce a typed host port and keep the logic reusable,
3. supersede/update the governing ADR explicitly.

"Temporary" is not enough by itself. A shortcut is not allowed unless the
architecture decision is changed in writing and its new proof rail is
documented.

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

### Merge gate

A surface-affecting change is ready to merge only when all of these are true:

1. `typecheck` is green,
2. applicable `biome` fences are green,
3. `surface-coupling-ratchet` is green,
4. `terminal-defaults-ratchet` is green,
5. any state-authority hellgate for the feature is green,
6. the ADR/architecture text still describes the live code truth.

Failing any of these means the change is not architecture-closed.

## Ratchet

`tests/unit/surface-coupling-ratchet.test.ts` is the structural guard for
cross-surface runtime coupling.

The test blocks:

- any `src/apps/<a> -> src/apps/<b>` runtime import,
- any reintroduction of cross-surface runtime debt,
- any "temporary" cross-surface helper import that is not explicitly
  reviewed and documented.

The target and current enforced state are exact zero.

## Current enforced state

As of the current closeout:

- cross-surface runtime-import debt is `0`,
- non-surface terminal-default debt is `0`,
- interactive reusable runtime ownership is below `src/apps/**`,
- reusable batch core is below `src/apps/**`,
- slash-visible runtime state must be engine-owned rather than slash-local.

This is the baseline future changes must preserve.

Proof rails that currently enforce that baseline:

- `tests/unit/surface-coupling-ratchet.test.ts`
- `tests/unit/terminal-defaults-ratchet.test.ts`
- `tests/unit/apps/cli/repl-thin-surface-ownership-hellgate.test.ts`
- `tests/unit/slash-state-ssot-hellgate.test.ts`
- targeted host/headless/interactive/batch wiring hellgates

## Consequences

- New surface features have a stricter placement bar.
- CLI can still evolve, but only as a host adapter and terminal renderer.
- Calling the CLI "thin" does NOT mean it is "dumb terminal only". Host UX
  work is allowed; reusable runtime ownership is not.
- Web/native expansion gets a stable rule: prefer reusing headless engine
  seams, never re-implementing CLI-owned semantics.
- Architecture review becomes simpler because the allowed surface budget is
  explicit.

## Out of scope

- Pushing every host concern out of `src/apps/**` until the surface becomes
  render-only.
- Re-arguing whether terminal prompt UX or slash rendering may live in a
  surface. They may.
- Rewriting every surface adapter into a generic transport layer today.

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
- Do not call a surface "thin" while any thin acceptance criterion is red.

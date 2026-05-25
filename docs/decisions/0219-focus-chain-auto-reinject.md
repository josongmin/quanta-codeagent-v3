# ADR-0219: Focus Chain (automatic N-turn todo-list re-injection)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0045 (progress-audit skill — user-invocable
  counterpart; this slice is the AUTOMATIC version)
- **References**:
  `src/agent/focus-chain/{port,default-tracker,todo-injector,drift-detector,index}.ts`,
  `tests/unit/focus-chain-hellgate.test.ts`

## Research grounding

Per Cline's published agent loop: every N turns (Cline default: 6) the
runtime splices the current todo list back into the model context. Without
this re-injection, todos decided early in a long session get pushed out
of the active context window and silently dropped — the model "forgets"
its multi-step plan. Cline pairs this with a drift detector that warns
when N consecutive turns elapse with zero todo progress.

This is a single-vendor signal (Cline). We absorb it anyway because:
(a) the operational logic is shaped by attention-window mechanics that
apply to every model in our matrix; (b) it composes additively with
ADR-0045 (user-invocable progress-audit) rather than overlapping; (c)
the implementation is small and default-OFF — the cost of being wrong
is one slice's worth of code.

## Context

ADR-0045 (`progress-audit` skill) lets the operator say `/progress-audit`
and the model re-reads its todos. That's the USER-INVOCABLE path. The
gap: long autonomous runs without operator interaction lose the todos
when they age out of context. Cline's Focus Chain plugs that gap by
splicing automatically every N turns.

Two concerns must be separated:

1. **Re-injection** — at turn N, 2N, 3N, ..., splice the current todo
   list into the next prompt as a `## Focus Chain — Todos` block.
2. **Drift detection** — when N consecutive turns elapse with zero
   todo state change (no `markDone` / no `setTodos`), surface a
   one-line warning the host may add to the next `<system-reminder>`.

Combined, they make a stale model self-correct: the re-injection brings
the todos back into attention, and the drift warning explicitly says
"you have not progressed — re-read or replan".

## Decision

Add a closed-port slice `src/agent/focus-chain/` with two responsibilities:

- **`FocusChainPort`** — `setTodos`, `tickTurn`, `getInjection` (consuming),
  `peekInjection` (non-consuming), `getDriftWarning`, `markDone`,
  `snapshotTodos`, `currentTurn`. NO-THROW on every method; bad input
  (negative tick, NaN, malformed todo) is a no-op.
- **`defaultFocusChainTracker(opts)`** — in-memory state machine.
  `reinjectEveryN` (default 6, the Cline operational value),
  `driftWindowTurns` (default 5).
- **`renderTodos()`** — pure stringifier; renders to a `## Focus Chain —
  Todos\n- [ ] / - [~] / - [x] …` markdown block. Empty/all-malformed list
  returns null so the host never splices an empty heading.
- **`isDrifting()` + `formatDriftWarning()`** — pure predicates over a
  `DriftState` struct; null-safe on non-finite inputs.

### Invariants

1. **NO-THROW** on every public method. The tracker is observability-grade
   infra — it MUST NOT take down the loop.
2. **Default-OFF** — the loop never constructs a tracker; the host
   wires one explicitly and reads `getInjection()` at its prompt-assembly
   site. Absent host wire ⇒ byte-identical prompt bytes.
3. **PURE STATE** — in-memory only. No persistence (Phase 2 if needed).
4. **EXACT-OPTIONAL** — optional fields are OMITTED, never `undefined`-set.
5. **First injection NEVER on turn 0** — the model just saw the todos at
   session start; we wait one full cycle before re-injecting.

### Knob: `reinjectEveryN`

- Default 6 (Cline operational value).
- `0` is an EXPLICIT "disable" signal — injection always returns null
  but `tickTurn` / `setTodos` / `markDone` still mutate state.
- Negative / NaN / Infinity ⇒ fallback to default 6 (operator-typo
  defends to safe behaviour).

### Knob: `driftWindowTurns`

- Default 5 (Cline operational value).
- Same null-on-bad-input rule.
- Drift on an empty todo list returns null (not actionable).

## Why this is distinct from ADR-0045 (progress-audit skill)

| Axis              | ADR-0045 (progress-audit)    | ADR-0219 (Focus Chain)        |
|-------------------|------------------------------|-------------------------------|
| Trigger           | user types `/progress-audit` | every N turns automatically   |
| Persistence       | skill body in `.system/`     | in-memory tracker             |
| State             | stateless (re-reads on call) | stateful (todos + counters)   |
| Drift detection   | N/A                          | yes (configurable window)     |
| Output            | skill prompt addendum        | markdown block in prompt      |

They are COMPLEMENTARY, not redundant. ADR-0045 covers operator-driven
re-orientation; ADR-0219 covers autonomous-run re-orientation.

## Default-OFF posture

The loop never constructs a tracker. The host wires it through
`AgentConfig` (slot added by a future CLI command — out of scope for
this slice). Until wired, prompt assembly is byte-identical. Same
voice as ADR-0130 and ADR-0218 — types + factory the host composes.

## Slice isolation

- Pure types + a factory; no `@/agent/loop` / `@/agent/dispatch` /
  `@/llm` / `@/tool` / `@/skill` imports.
- The `FocusTodo` shape is local to this slice — the host maps its
  own todo-list state (working memory, plan-queue, etc.) into this
  shape at the wiring site.
- Output is plain markdown; the host decides whether to splice into
  the system prompt, a `<system-reminder>` user message, or anywhere
  else.

## Validation

- **Hellgate**: `tests/unit/focus-chain-hellgate.test.ts` — 25 cases
  covering empty-todos / N-tick boundary / drift detection / drift
  reset / byte-identical when OFF / bad-input no-throw / peek vs get
  / markDone out-of-range / snapshot freeze / output format stability
  / 0-disable / negative-fallback / hostile-input sanitization.
- **TSC**: 0 errors introduced by this slice.
- **Biome**: 0 errors on this slice.

## Limits + follow-ups

- Persistence: tracker state is lost on process restart. Phase 2 could
  add a `serialize/hydrate` pair voiced like ADR-0130. Out of scope
  here.
- Multi-session sharing: the tracker is single-session. A shared
  tracker across forked subagents would corrupt the counter; the
  docstring forbids this.
- The host is responsible for the splice site (system prompt vs
  per-turn reminder). The slice intentionally does NOT prescribe
  where the markdown block lands.
- No tool registration — same as ADR-0218, the host wires the
  tracker through `AgentConfig` and decides whether to surface
  `mark_done` / `set_todos` as tools.

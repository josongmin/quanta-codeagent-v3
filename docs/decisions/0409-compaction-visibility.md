# ADR-0409 — Compaction visibility (RecoveryReason + microcompact + post_compact)

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/recovery-reason/` (new: `types.ts` + `index.ts`) +
`src/agent/microcompact/` (new: `types.ts` + `compactor.ts` + `index.ts`) +
surgical edits to `src/agent/hooks.ts` and `src/agent/compaction.ts` + 3
hellgate files.
**Default-OFF:** Yes — the new `RecoveryReason` enum is pure types, the
microcompact slice has no in-tree consumer, and the `post_compact` event +
Objective wire on `compactIfNeeded` are opt-in callbacks. With no
`postCompactEmit` and no `objectiveSetNextActions`, the existing compaction
path is byte-identical (no allocation, no extra `await`).

## Context

User: **"왜 잊었는지가 안 보이면 신뢰가 깨집니다."** Compaction is currently a
silent internal optimization — when the agent's transcript is folded the
operator has no record of WHY (token threshold? PTL recovery? operator
override?) or WHERE TO RESUME. Three concrete gaps:

1. There is no typed enum for "why did the compaction happen?". The two
   call sites (`compactIfNeeded` proactive + `reactiveCompact` PTL) emit a
   free-form `detail` string into the trajectory event; consumers cannot
   discriminate `drift_breaker` from `manual` without parsing strings.
2. The compaction options are binary — full reset (`compactIfNeeded`) or
   PTL-driven aggressive reset (`reactiveCompact`). There is no partial-drop
   alternative for "the transcript is getting big but we don't need to fold
   everything yet."
3. The per-thread Objective (ADR-0394) tracks blockers + nextActions but has
   no way to see a compaction event — so an operator picking up a thread
   the next day sees nothing in `Objective.nextActions` about the fact that
   the agent "forgot" earlier work.

This ADR closes all three.

## Decision

Three additive slices, all default-OFF, all NO-THROW on their public APIs.

### 1. `RecoveryReason` closed enum + provenance shape

`src/agent/recovery-reason/` is a LEAF — zero runtime deps. Exports:

```ts
type RecoveryReason =
  | "token_budget_exceeded"   // primary trigger — token threshold
  | "ptl_reactive"             // PTL mid-stream recovery
  | "drift_breaker"            // CompactionBreaker thrash guard fired
  | "manual"                   // operator/agent requested
  | "context_change"           // ADR-0321 detector
  | "fork_branch"              // session fork created new compaction point
  | "microcompact"             // partial drop instead of full reset

interface RecoveryProvenance {
  readonly reason: RecoveryReason
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly turnsDropped: number
  readonly turnsKept: number
  readonly summaryRef?: string
  readonly resumeStep?: string
  readonly compactedAt: number
}
```

`RECOVERY_REASONS` is a frozen tuple of every arm + `isRecoveryReason` is the
runtime guard. The enum is consumed exhaustively by `post_compact` consumers
and metric emitters — adding a new arm is a contract change (hellgate +
ADR update required).

### 2. `MicroCompactPort` (partial-drop alternative)

`src/agent/microcompact/` is a sibling leaf that imports ONLY
`@/agent/recovery-reason` (types). Pure function `createMicroCompactor` —
NO LLM, no IO, no `@/llm` import.

Semantics (pinned in `microcompact-hellgate.test.ts`):

- Drops the OLDEST `floor(messages.length * dropRatio)` messages.
- `preserveSystem` (default `true`) — `role:"system"` messages NEVER drop.
- `preserveRecentTurns` (default 6, parity with
  `compaction.ts#DEFAULT_KEEP_TURNS`) — the protected suffix is the LAST N
  messages, never dropped.
- `dropRatio` outside [0,1] ⇒ clamped (NaN ⇒ 0).
- Malformed input (non-array `messages`, null entry, missing `role`) ⇒
  returns input unchanged + provenance with `turnsDropped:0`. NO-THROW.
- `provenance.reason` is always `"microcompact"`.

### 3. `post_compact` hook event + Objective wire on `compactIfNeeded`

New event variant added to `HookEvent`:

```ts
| {
    type: "post_compact"
    threadId: string
    provenance: RecoveryProvenance
  }
```

`compactIfNeeded` accepts four new optional fields:

- `postCompactEmit(provenance)` — fires ONCE per successful compaction.
- `threadId` — carried into provenance + objective wire.
- `objectiveSetNextActions(threadId, actions)` — minimal callback that the
  loop wire can construct from `config.objective.setNextActions`. Typed as
  a closure (NOT the full `ObjectivePort`) to keep the slice fence intact —
  `compaction.ts` does NOT import `@/agent/objective`.
- `recoveryReason` — explicit override (default `"token_budget_exceeded"`).

When neither emit callback is set, the legacy path is byte-identical (no
allocation, no extra await). Both seams are NO-THROW: a misbehaving emitter
NEVER aborts the compaction itself.

### Slice fence

- `src/agent/recovery-reason/` — zero imports. Pure types + frozen tuple.
- `src/agent/microcompact/` — imports ONLY `@/agent/recovery-reason` (types).
  NO `@/llm`, NO `@/agent/loop`, NO `@/agent/dispatch`, NO `@/agent/compaction.ts`.
  Microcompact is the slice; compaction.ts CONSUMES it (the dependency is
  inverted: compaction.ts may call into microcompact in a future wire, but
  microcompact never reaches up).
- `src/agent/compaction.ts` adds a type-only import of `RecoveryProvenance`
  + `RecoveryReason` from the recovery-reason sibling. NO new
  cross-slice runtime coupling.
- `src/agent/hooks.ts` adds a type-only import of `RecoveryProvenance`.

## Consequences

- **+** Compaction becomes a USER-VISIBLE RESUME CONTRACT. A surface that
  wants to render "the agent compacted: reason X — resuming at step Y" reads
  one typed event (`post_compact`) and one typed object's `nextActions`.
- **+** Partial-drop alternative exists for the "growing but not exploding"
  case where full reset is overkill.
- **+** Closed enum forces every future trigger to come through the ADR
  process — no silent string-typed reasons leaking into the trajectory.
- **+** Slice is fully default-OFF: 9 new files + 13-line addition to
  `hooks.ts` + 39-line addition to `compaction.ts`. Existing compaction
  tests (57 cases / 214 expects) byte-identical, zero regression.
- **−** Wiring into the loop (`loop.ts` calling `compactIfNeeded` with the
  new fields populated from `config.objective` + a HookBus.emit subscriber)
  is **deferred** to a follow-up. This wave ships the contract.

## Tests

- `tests/unit/recovery-reason-hellgate.test.ts` — 13 cases / 23 expects.
  Pins: every enum arm round-trips through the guard; the frozen tuple
  rejects mutation; prototype-pollution attempt returns false;
  exhaustiveness check via never-fallthrough switch over the union.
- `tests/unit/microcompact-hellgate.test.ts` — 15 cases / 47 expects. Pins:
  dropRatio=0 ⇒ unchanged; dropRatio=1 + preserveRecentTurns ⇒ exactly the
  protected suffix kept; system messages preserved when flagged; malformed
  input (non-array / null entry / missing role) ⇒ NO-THROW + turnsDropped:0;
  out-of-range dropRatio clamped; NaN ⇒ 0; injected `now` clock seam
  deterministic.
- `tests/unit/compaction-post-event-hellgate.test.ts` — 15 cases / 39
  expects. Pins: emit fires exactly once per success; explicit
  `recoveryReason` honored verbatim; objective wire builds the correct
  `actions[0]` string + receives the right threadId; under-threshold ⇒
  emit NEVER fires; preCompactHook abort ⇒ emit NEVER fires; preflight
  defer ⇒ emit NEVER fires; emit throws ⇒ compaction still succeeds;
  objective throws ⇒ compaction still succeeds; `turnsDropped + turnsKept
  === messages.length`; every enum arm round-trips through the override.

## Alternatives considered

- **Encode the reason as a free-form string in the trajectory event.**
  Rejected — that is the current state, and it leaves consumers parsing
  strings to discriminate. The closed enum is the contract.
- **Make microcompact mutate the compaction.ts breaker counter.** Rejected —
  would couple the slice to `compaction-breaker.ts` and violate the leaf
  invariant. The breaker observes the result via the existing
  before/after token comparison.
- **Wire `config.objective: ObjectivePort` directly into `CompactInput`.**
  Rejected — would force `compaction.ts` to import `@/agent/objective`,
  coupling two slices. A callback closure is the minimum-coupling wire
  (the loop already has the port; it constructs the closure at the
  call-site).

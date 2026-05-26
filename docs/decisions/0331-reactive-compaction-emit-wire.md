# ADR-0331 — Reactive (mid-turn) compaction emit wire

Status: accepted
Date: 2026-05-27

> **Numbering note.** Drafted as `0331`; latest occupant in the 03xx
> range at landing is `0328-image-sanitization-retry-wire.md`. User
> in-flight slots reconciled per
> `memory/adr-collision-policy-2026-05-25.md`.

## Context

- ADR-0324 introduced `compaction_event` as the 6th `TypedHistoryEvent`
  variant (`src/memory/typed-event/types.ts:120`).
- Commit `a2490eb8` ("feat(loop): ADR-0324 compaction emit wire (typed
  history event)") added `AgentConfig.compactionEventEmit?: (event:
  CompactionEventVariant) => void` (`src/agent/types.ts:1461`) and an
  emit at the **proactive** site
  (`src/agent/loop.ts:780` inside `maybeCompact`'s `if (result.compacted)`
  branch). Trigger is fixed to `"pre_sampling"`.
- The same commit message explicitly defers the **reactive** site:
  > "Reactive (mid-turn / PTL-driven) compaction is a separate call-site
  > and gets its own emit in a follow-up wire."

The reactive site lives in `src/agent/loop.ts:1128` inside
`applyNonSuccessRecoveryAction`'s `action.do === "compact"` branch. It
runs when `decideOnStreamError` (`src/agent/loop.ts`) routes a
prompt-too-long (PTL) `LLMError` to `{ do: "compact" }`. Without an
emit here, consumers reading the typed-history side channel see only
proactive compactions, while the model itself can recover via reactive
compaction many times per session — leaving a narrative gap.

### Fact-find (verbatim citations)

- Call site (file:line):
  ```
  src/agent/loop.ts:1128:  const compacted = await reactiveCompact({
  ```
- Result shape (`src/agent/compaction.ts:304-306`):
  ```ts
  export type ReactiveCompactResult =
    | { ok: true; messages: Message[]; summaryTokens: number }
    | { ok: false; reason: string }
  ```
  `ok:false` means **no emit** (we mirror the proactive site's
  `if (result.compacted)` shape: emit ONLY on success).
- The site already has `snapshot` (pre-compact wm copy) and `before`
  (`estimateTokens(snapshot)`) in scope (`src/agent/loop.ts:1126-1127`).
  Post-compact tokens were re-derived once in `recordReactive`; we hoist
  them into a local `after` to share the estimate (one call instead of
  two, parity with the proactive site's `const after =
  estimateTokens(result.messages)` at `src/agent/loop.ts:773`).

## Decision

Wire the reactive site to emit `compaction_event` using the EXISTING
`emitCompactionEvent` helper (`src/agent/loop.ts:842`) with the same
NO-THROW / absent-slot semantics as the proactive site:

```ts
const after = estimateTokens(compacted.messages)
breaker?.recordReactive(before, after)
emitCompactionEvent(config, {
  kind: "compaction_event",
  trigger: "mid_turn",
  reason: "context_limit",
  tokensBefore: before,
  tokensAfter: after,
  messagesRemoved: Math.max(snapshot.length - compacted.messages.length, 0),
  at: Date.now(),
})
wm.replace(compacted.messages)
```

### Trigger / reason mapping

- **`trigger: "mid_turn"`** — fixed. The reactive site only runs from a
  recovery `compact` action, which the router produces only AFTER a PTL
  is thrown mid-turn (`decideOnStreamError(..., "ptl", ...)`). Codex
  `run_auto_compact(..., MidTurn)` is the direct analogue.
- **`reason: "context_limit"`** — fixed. The reactive action is
  generated only by PTL classification (`classifyLLMError(e) ===
  "prompt_too_long"`), which **is** a context-limit signal by
  construction. Other ADR-0324 reasons (`"token_budget"`, `"manual"`)
  are not reachable from this call site today. Adding a new reactive
  trigger (e.g. a token-budget-driven mid-turn squeeze) requires its
  own ADR + extending the closed set under ADR-0324.

### Field invariants

- **`tokensBefore`** — `estimateTokens(snapshot)`, computed before the
  reactive squeeze.
- **`tokensAfter`** — `estimateTokens(compacted.messages)`, hoisted from
  the existing `recordReactive` argument (single estimate per emit,
  same as proactive site).
- **`messagesRemoved`** — `Math.max(snapshot.length -
  compacted.messages.length, 0)`. The `max(…, 0)` clamp protects the
  non-negative contract (`src/memory/typed-event/types.ts:130-134`) if
  a future reactive synthetic header ever runs longer than the prefix
  it summarized (cannot happen today but the field contract is
  enforced regardless).
- **`tokensAfter <= tokensBefore` is NOT enforced here.** Per
  ADR-0324's schema rationale: "the invariant `tokensAfter <=
  tokensBefore` is the **producer's responsibility**. The store
  boundary (`append`) does **NOT** validate." The reactive site, when
  `inputTokens < REACTIVE_MIN_INPUT_TOKENS` (4 000, see
  `src/agent/compaction.ts:274`), bypasses the drop-ratio fail-fast
  guard; on a tiny transcript the synthetic `<continuation summary>`
  header can be longer than the prefix it replaced. The emit reports
  the accurate numbers (which the breaker also observes via
  `recordReactive(before, after)` and would strike on) — the typed
  event is observation, not enforcement.

### Order (matches proactive site)

`recordReactive` → `emitCompactionEvent` → `wm.replace`. Same sequencing
as the proactive site (`src/agent/loop.ts:773-789`): the breaker
records FIRST (cheap, deterministic), the emit fires SECOND (so a
throwing emitter cannot stall the breaker, but the post-mutation
narrative window is still consistent because `wm.replace` happens
LAST). A throwing emitter is swallowed inside `emitCompactionEvent`
(`src/agent/loop.ts:847-851`) — pure observability.

## Non-goals

- **No new `trigger` or `reason` variant.** ADR-0324 closed set is held
  byte-identical; adding `"token_budget"` for a reactive driver, or
  reusing `"manual"` for a slash-command reactive squeeze, is a separate
  ADR.
- **No `turnId` propagation.** The proactive site also leaves `turnId`
  undefined (the recovery-action site does not have a `turnId` in
  scope; `applyNonSuccessRecoveryAction` receives `state` but not the
  `turnId` local). Threading it is a follow-up under the typed-event
  consumer ADR.
- **No change to `reactiveCompact` / `recoveryRouter` / breaker.** The
  pure decision pipeline is byte-identical.
- **No new `AgentConfig` field.** Reuses the existing
  `compactionEventEmit` slot from ADR-0324.

## Files touched

In-slice fence:

- `src/agent/loop.ts` — 1 site mutation in
  `applyNonSuccessRecoveryAction` (`action.do === "compact"` success
  branch). Hoists `after`, calls `emitCompactionEvent` between
  `recordReactive` and `wm.replace`.
- `tests/unit/loop-reactive-compaction-emit-hellgate.test.ts` — new
  hellgate, 6 cases driven through `runAgent`:
  1. Absent slot ⇒ no emit (byte-identical).
  2. Present slot ⇒ exactly one emit with
     `kind:"compaction_event"`, `trigger:"mid_turn"`,
     `reason:"context_limit"`.
  3. Throwing emitter swallowed ⇒ loop completes successfully.
  4. Reactive skip (`reactiveCompact` returns `{ok:false}` on empty
     summary) ⇒ no emit AND no third LLM call.
  5. Field shape: `tokensBefore`/`tokensAfter` finite, `messagesRemoved
     >= 1`, `at` within wall-clock bounds.
  6. Two separate `runAgent` invocations sharing one emitter ⇒ each
     contributes exactly one event (per-call emission, not deduped).

ADRs:

- `docs/decisions/0331-reactive-compaction-emit-wire.md` — this file.

## Wiring

- **Default-OFF.** `compactionEventEmit` absent ⇒
  `emitCompactionEvent` returns at the `=== undefined` guard
  (`src/agent/loop.ts:846`); the reactive branch is byte-identical to
  pre-ADR-0331 modulo the hoisted `const after =
  estimateTokens(compacted.messages)` (which `recordReactive` already
  computed inline — the call count of `estimateTokens` is reduced from
  2 to 1 on the reactive path, a strict improvement). All companion
  hellgates (`working-loop.test.ts`, `recovery-hellgate.test.ts`,
  `recovery-router-hellgate.test.ts`, `compaction-breaker-hellgate.test.ts`,
  `recovery-hell.test.ts`) pass unchanged.
- **Producer side (existing).** Any consumer wiring
  `compactionEventEmit` to push onto a `TypedHistoryEventStore`
  (ADR-0320) now sees BOTH proactive (`trigger:"pre_sampling"`) and
  reactive (`trigger:"mid_turn"`) events — closing the ADR-0324
  coverage gap.

## Slice fence

`src/agent/loop.ts` (1 mutation) + new test file under `tests/unit/`.
No other files touched. ADR-0001 module boundaries preserved (no new
imports, the emit helper already lives in `src/agent/loop.ts`).

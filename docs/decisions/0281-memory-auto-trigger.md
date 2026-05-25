# ADR-0281: Memory auto-trigger (session-end → phase1 → phase2 promote)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0068 (2-phase consolidator), ADR-0207 (stage1-store),
  ADR-0114 (session-end consolidator hook), ADR-0282 (cross-session
  inject — the sibling slice that consumes the promoted rows).

## Context

The 2-phase consolidator (ADR-0068) and stage1 usage/selection cache
(ADR-0207) ship the primitives, and ADR-0114 wires the session-end
hook for Phase 1. But the *trigger* shape is still manual:

- Phase 1 fires only when the host opts in (`memoryConsolidator.enabled
  = true`) and never automatically promotes a Stage 1 entry to Phase 2.
- `Stage1OutputsStore.markSelectedForPhase2` is a no-op call site —
  nobody decides "this entry is interesting enough to keep".
- No cross-session cumulative knowledge: a session ends, the rollout
  vanishes, the next session starts from a clean prompt.

Cursor and Codex both ship a higher-level seam on top of these
primitives: "at session end, distill, then *score* the distillation,
and promote the high-signal subset; at session start, *recall* the
promoted subset". This ADR introduces the trigger half (scoring +
promotion); ADR-0282 introduces the recall half (inject).

Negative invariants we are NOT violating:

- **Byte-identical default-OFF.** Until the composition root reads
  `QUANTA_MEMORY_AUTO=on`, no auto-trigger code runs and the loop is
  byte-identical to today.
- **`exactOptionalPropertyTypes: true`.** The policy + outcome types
  use OMIT semantics for absent fields (no `undefined` literals).
- **Closed-port DIP.** `MemoryAutoTrigger` is the closed port. The
  `DefaultMemoryAutoTrigger` is the only adapter in this ADR;
  alternative scoring strategies (embedding-based, LLM-judge-based)
  ship as new adapters against the same port.
- **Slice boundary.** Lives at `src/memory/auto-trigger/`. Reads from
  `src/memory/stage1-store/` (existing port) and is allowed to invoke
  `runPhase1` from `src/memory/consolidate/` through the existing
  port. NEVER mutates either sibling slice's code.
- **No silent leak.** `onSessionEnd` swallows Phase 1 failures into a
  structured `TriggerError` outcome + injected logger warn — never
  throws (mirrors ADR-0114's no-throw contract). Abort signals are
  propagated unchanged.

## Decision

Stand up a new sibling slice `src/memory/auto-trigger/` (4 files)
exposing the closed `MemoryAutoTrigger` port + default scoring impl.

```
src/memory/auto-trigger/
  port.ts           — MemoryAutoTrigger { onSessionEnd, onSessionStart, shouldPromote }
  types.ts          — TriggerPolicy { promoteThreshold, minUsageCount }, TriggerError
  default-trigger.ts — DefaultMemoryAutoTrigger (lexical-jaccard similarity)
  index.ts          — barrel
```

Public surface (`MemoryAutoTrigger`):

```ts
interface MemoryAutoTrigger {
  /** Run Phase 1 distill on session end, store the result in stage1,
   *  then evaluate every stage1 entry for promotion. No-throw. */
  onSessionEnd(input: SessionEndInput): Promise<SessionEndOutcome>

  /** Reserved for ADR-0282 cross-session inject — the trigger slice
   *  itself only signals "selection is fresh"; inject reads the
   *  stage1Store directly via ADR-0282 injector. No-op for now (kept
   *  on the port so adapters can hook session-start side effects in
   *  a follow-up ADR). */
  onSessionStart(input: SessionStartInput): Promise<void>

  /** Pure scoring predicate — given a stage1 entry + query corpus,
   *  return whether the entry should be promoted to Phase 2. Used
   *  internally by `onSessionEnd`; exported so a host can plug a
   *  different scorer (LLM judge, embedding cosine, etc.). */
  shouldPromote(entry: Stage1Entry, ctx: PromoteContext): boolean
}
```

Public shapes (`TriggerPolicy`, `TriggerError`):

```ts
interface TriggerPolicy {
  /** Similarity / score threshold for promotion. Default `0.7`. */
  promoteThreshold: number
  /** Minimum `usageCount` an entry needs before it can be promoted.
   *  Default `1` (anything ever-used can promote). */
  minUsageCount: number
}

class TriggerError extends Error {
  readonly reason: "phase1_throw" | "stage1_put_throw" | "promote_throw"
  readonly cause?: unknown
}
```

`SessionEndOutcome` is a discriminated union:

```ts
type SessionEndOutcome =
  | { kind: "skipped"; reason: "empty_session" | "policy_off" }
  | { kind: "stored";  stage1ThreadId: string; promoted: boolean }
  | { kind: "error";   error: TriggerError }
```

Scoring strategy (default impl):

- Lexical Jaccard similarity between the stage1 entry's
  `rolloutSummary` token set and the query corpus token set
  (composed from all *other* selected-for-phase2 entries).
- Token = `[a-z0-9]+` lowercased; empty corpus → score `0`.
- `shouldPromote = score >= policy.promoteThreshold &&
  entry.usageCount >= policy.minUsageCount`.
- Boundary cases:
  - `threshold = 0` ⇒ every entry promotes (edge — useful for tests
    and `*-firehose` workflows).
  - `threshold > 1` ⇒ nothing promotes (the predicate is `>=`, but a
    Jaccard score is always ≤ 1).
  - empty session (0 messages) ⇒ skip without calling `runPhase1`.
  - `clock.now()` going backwards ⇒ `lastUsage` may regress; the
    trigger does NOT enforce monotonicity (stage1-store's
    `markSelectedForPhase2` is the authoritative writer).

Failure model (no-throw):

| failure                              | outcome                                                      |
|--------------------------------------|--------------------------------------------------------------|
| `runPhase1` throws                   | `{kind:"error", error: TriggerError("phase1_throw")}` + warn |
| `stage1Store.put` throws             | `{kind:"error", error: TriggerError("stage1_put_throw")}`    |
| promotion scoring throws (custom)    | `{kind:"error", error: TriggerError("promote_throw")}`       |
| `signal.aborted` mid-trigger         | propagate the `AbortError` (NOT wrapped — distinguishable)   |
| stage1 entry malformed (read path)   | skip that entry + warn; never throw                          |
| concurrent `onSessionEnd` calls      | each gets its own outcome; no shared state                   |
| duplicate `threadId` second call     | idempotent (replace semantics from stage1-store `put`)       |

Default-OFF wiring posture:

- No barrel re-export from `@/memory` in this ADR — the slice is
  reachable as `src/memory/auto-trigger/index.ts` directly by the
  composition root and tests. A future ADR adds the `@/memory`
  re-export when broader callers wire it.
- Composition root reads `QUANTA_MEMORY_AUTO` (one canonical knob,
  `on` / absent). Absent ⇒ no slice loaded, byte-identical legacy.

## Hellgate (22 cases — auto-trigger + cross-session inject)

`tests/unit/memory/auto-trigger-hellgate.test.ts` (this ADR + ADR-0282
share the same hellgate file because the assemble wire is shared):

| id           | seal                                                                    |
|--------------|-------------------------------------------------------------------------|
| HELL-MAT-01  | session-end calls phase1.distill + stage1.put                           |
| HELL-MAT-02  | similarity > 0.7 → promote (markSelectedForPhase2 called)               |
| HELL-MAT-03  | similarity < 0.7 → stage1 stored, NOT promoted                          |
| HELL-MAT-04  | minUsageCount unmet → promote skipped (even if score high)              |
| HELL-MAT-05  | phase1 throws → graceful (error outcome + warn, no leak)                |
| HELL-MAT-06  | stage1Store full → LRU prune compatible (trigger does not break)        |
| HELL-MAT-07  | concurrent session-end (3 parallel) → isolated, no race                 |
| HELL-MAT-08  | duplicate threadId session-end twice → idempotent (replace)             |
| HELL-MAT-09  | empty session (0 messages) → skip without invoking phase1               |
| HELL-MAT-10  | malformed stage1 entry from store → skip + warn (no throw)              |
| HELL-MAT-11  | threshold = 0 → every entry promotes (edge)                             |
| HELL-MAT-12  | threshold > 1 → nothing promotes                                        |
| HELL-MAT-13  | promote mid-flight: stage1 invalidated → graceful                       |
| HELL-MAT-14  | clock backwards → lastUsage update tolerated (no crash)                 |
| HELL-MAT-15  | session-start → injector called + prompt section produced (ADR-0282)    |
| HELL-MAT-16  | maxBytes cap exact — overflow truncated (ADR-0282)                      |
| HELL-MAT-17  | kindFilter selects subset (ADR-0282)                                    |
| HELL-MAT-18  | empty inject result → empty string section (ADR-0282)                   |
| HELL-MAT-19  | QUANTA_MEMORY_AUTO unset → byte-identical, trigger not invoked          |
| HELL-MAT-20  | AbortSignal mid-trigger → propagate AbortError, cleanup                 |
| HELL-MAT-21  | default policy: threshold 0.7 + minUsageCount 1                         |
| HELL-MAT-22  | assembleMemoryAuto env wire exact                                       |

## Consequences

- **+ Cross-session cumulative knowledge** finally automatic — no
  manual `markSelectedForPhase2` calls required.
- **+ Closed-port scoring strategy** — swap lexical Jaccard for an
  embedding cosine or LLM judge by writing a new adapter.
- **+ Default-OFF preserves byte-identical legacy** for every host
  that does not opt in.
- **−** Lexical Jaccard is coarse; high-signal paraphrases score
  lower than they should. Mitigation: ADR follow-up swaps the scorer
  to embedding cosine (the port supports it; we just need a real
  scoring adapter and an embedder seam).
- **−** Two thresholds (`promoteThreshold` + `minUsageCount`) add
  configuration surface. Mitigation: both default reasonable values
  and the env-knob slug is exactly two (`THRESHOLD` + `MIN_USAGE`).

## Follow-up

- ADR-0282 cross-session inject (consumed by `onSessionStart`).
- Swap lexical Jaccard for embedding cosine (new adapter against the
  same port).
- Optional LLM-judge scorer for high-stakes promotion.
- OTel span around `onSessionEnd` (attribute set: outcome enum,
  promoted bool, latency ms).

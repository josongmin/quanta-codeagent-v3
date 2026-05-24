# ADR-0178: Mid-turn user interruption — capture facade over `PlanQueueStore` with 3-arm mode + `InterruptionPolicy` port

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0128 (PlanQueueStore — this round WIRES it to a mid-turn input source); ADR-0177-sibling (streaming-cancellation — `cancelCause` coordination, in flight on a sibling worktree)
- **참조**: `src/agent/mid-turn-interruption/types.ts`, `src/agent/mid-turn-interruption/default.ts`, `src/agent/mid-turn-interruption/index.ts`, `tests/unit/mid-turn-interruption-hellgate.test.ts`

## 맥락

User typing while the agent is still streaming is now table-stakes. The SOTA matrix:

| Agent | typing-while-streaming | explicit cancel | queued replay |
|---|---|---|---|
| Claude Code 2.1 | ✅ `Ctrl-T` queue inspector | ✅ `Esc-Esc` rewind | ✅ |
| Cursor 3.2 | partial | ✅ `Cmd-K` cancel-replace | ❌ (cancel-mode replaces, no replay) |
| Codex Desktop | ✅ (`queued-follow-ups`) | ❓ | ✅ |
| ChatGPT (web) | ✅ (auto-queues) | ✅ (stop button) | ✅ |
| **quanta (before)** | ❌ (store existed but no capture surface) | partial (loop AbortSignal) | ❌ (drain never called) |

ADR-0128 already shipped the `PlanQueueStore` (12-field `FollowUp`, per-thread LRU, dedup window). What was missing: **the capture-facade that maps the CLI "user submitted while streaming" signal to either (a) plan-queue enqueue or (b) cancel-signal + plan-queue enqueue**. Without it the store is reachable but no surface knows when to call it or what it means.

## 결정

A 3-file slice (`mid-turn-interruption/{types,default,index}.ts`) that ships:

1. **`InterruptionMode` (closed enum, 3 arms)** — `"queue" | "cancel-and-replace" | "cancel-and-amend"`. The caller (CLI input loop) picks the mode based on UI surface: a typed-ahead keystroke = `queue`; `Cmd-K`-style explicit cancel = `cancel-and-replace`; "wait I forgot to add X" right after enter = `cancel-and-amend`.
2. **`InterruptionPolicy` port** — single-method `decide(input, ctx) → InterruptionDecision`. Three stock implementations:
   - `defaultInterruptionPolicy()`: explicit `mode` token wins; unknown mode → defensive `"queue"` (typing must never silently drop).
   - `alwaysQueuePolicy` / `alwaysCancelPolicy`: testing stocks + emergency override hooks.
3. **`MidTurnCapture` facade** (`defaultMidTurnCapture(opts)`) — wires policy decisions through a `PlanQueueStore`. Three methods:
   - `capture(input) → InterruptionDecision`: NO-THROW. Policy crashes collapse to `{action:"queue", reason:"policy-error"}`; plan-queue crashes preserve the decision but tag `"enqueue-error"`.
   - `drainForTurn(turnIndex) → MidTurnInput[]`: maps `PlanQueueStore.drain(...)` back to mid-turn shape; urgent-first ordering inherited.
   - `peek() → MidTurnInput[]`: snapshot, mutation-safe.

### Cancel-cause coordination with ADR-0177-sibling

The sibling `streaming-cancellation/types.ts` is in flight on another worktree. Both ADRs will ship a `"user-abort"` string literal in their respective cause unions. We DEFINE `MidTurnCancelCause = "user-abort"` locally to keep this module plane-clean — consumers structurally assign across the two (closed-string-union widening only). When ADR-0177 lands, a follow-up either (a) re-exports the sibling type, or (b) leaves the parallel definition; both options stay binary-compatible because the literal set matches.

### Default-fill rules

- `mode === "queue"` → `cancelCause` OMITTED in `metadata` (exactOptional — never `undefined`).
- `mode === "cancel-and-*"` + caller omits `cancelCause` → default-fill `"user-abort"`.
- `urgent` derived: `cancel-and-amend` → `true` (user attention signal); else `false`.

### `metadata` encoding (FollowUp ↔ MidTurnInput round-trip)

| FollowUp.metadata key | source | reverse |
|---|---|---|
| `midTurnMode` | `input.mode` (verbatim) | back to `MidTurnInput.mode`; defensive fallback to `"queue"` |
| `cancelCause` | resolved cause when mode≠queue | back to `MidTurnInput.cancelCause` (omitted on queue) |

## Hellgate (22 cases)

| # | Block | Asserts |
|---|---|---|
| 1-4 | A. defaultInterruptionPolicy | queue / replace / amend / unknown → defensive queue |
| 5-6 | B. always-* stocks | force-queue / force-cancel regardless of mode |
| 7 | C. capture+queue | 12-field shape — source, pausedReason, arrivedDuringTurn, urgent=false, metadata.midTurnMode |
| 8 | C. capture+cancel-replace | decision.action=cancel + metadata stamped |
| 9 | C. urgent | amend → urgent=true |
| 10 | C. dedup | same text same turn → peek count 1 |
| 11 | C. graceful | no planQueue → decision returned, no throw, peek=[] |
| 12 | C. NO-THROW | policy throws → synthetic queue/policy-error + no enqueue |
| 13 | C. preservation | observedTurnIndex → arrivedDuringTurn |
| 14 | C. default-fill | cancel-* default cancelCause=user-abort |
| 15-18 | D. drain | order / mark-drained / empty / urgent-first |
| 19-20 | E. peek | copy / empty |
| 21-22 | F. cancel-cause | explicit preserved / omitted on queue (Object.hasOwn) |

## Default-OFF

When `planQueue` is absent from `MidTurnCaptureOpts`, the facade degrades to a **pure decision oracle** — `capture` still returns the policy decision (so the CLI can fire cancel), but no persistence happens and `drainForTurn` / `peek` return `[]`. This means the slice can land before the apps/agent bootstrap wires the planQueue, with zero observable behaviour change.

## Alternatives rejected

- **"Always-cancel default"** — disruptive for typing-ahead users; Codex / ChatGPT default to queue. Rejected: causes lost input on every keystroke during long streams.
- **"Always-queue default"** — feels unresponsive on explicit cancel (Cmd-K); explicit mode parameter respects user intent. Rejected: user expectation that `Esc` / `Cmd-K` ACTUALLY cancels.
- **"Implicit cancel via empty input"** — ambiguous; an explicit mode token is clearer and the test matrix exhaustive. Rejected: tying behaviour to a sentinel value tangles two orthogonal signals (intent vs text).
- **"Separate `interruption-store` from `plan-queue`"** — duplicates the 12-field envelope + dedup + LRU infrastructure. Rejected: map mode through `metadata.midTurnMode` and reuse the shipped store.
- **"Policy returns the planQueue enqueue parameters directly"** — couples the policy port to the FollowUp shape and breaks plane-cleanliness. Rejected: keep the policy purely on the InterruptionDecision shape; the facade owns the FollowUp mapping.

## Follow-up

- `apps/cli`: wire the CLI input loop to call `capture(...)` while the loop is `streaming`; on `action === "cancel"`, fire the existing AbortSignal channel (sibling ADR-0177 will formalise the cancel-cause hand-off).
- UI: `Ctrl-T`-style queue inspector reading `peek()`.
- Re-export `MidTurnCancelCause` from ADR-0177 once that slice lands (currently parallel-defined for plane-cleanliness).
- Observability: stamp `mid_turn.mode` / `mid_turn.decision_action` OTel attributes via the existing PlanQueue collapse counter (ADR-0167) or a sibling instrument wrap.

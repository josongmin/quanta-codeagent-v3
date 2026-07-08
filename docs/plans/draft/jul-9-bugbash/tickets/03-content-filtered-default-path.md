# ALBB-03 — `content_filtered` silently proceeds + drains deferred MUTATING tools on the default path

**Priority:** P1 (terminal proceed is pinned-intended; the streaming mutating-tool drain is the live defect)
**Wave:** A
**Depends on:** none
**Owner:** `src/agent/recovery.ts`, `src/agent/streaming-dispatch.ts`, `src/llm/providers/provider-port.ts`
**Verdict:** keep (confirmed real by two audit rounds; not a duplicate — unique to the `content_filter → content_filtered` mapping seam)

## Goal

On the DEFAULT production path (`refusalFallback` OFF, `stopReasonPolicy` unset)
a provider content-filter stop must be treated as a terminal safety refusal that
executes **no** further tools — never a silent `completed` proceed, and never a
barrier-deferred MUTATING tool dispatch. This mirrors the competitor baseline
(Claude Code / Codex): a provider content-filter/safety stop is terminal; the
agent runs zero additional tools rather than proceeding.

## Problem

The provider-blind seam that folds both vendors' refusal-class stops already
exists but is **not consumed** on the default assembled-mapping path.

**1. Predicate exists, one caller ignores it.**
`src/llm/providers/provider-port.ts:53-54` folds both reasons:

```ts
export const isRefusalStopReason = (stopReason: string): boolean =>
  stopReason === "refusal" || stopReason === "content_filtered"
```

The OpenAI wire maps the vendor incomplete reason with no policy gate
(`src/llm/openai-responses-wire.ts:743-748`):

```ts
const stopReason =
  reason === "max_output_tokens" ? "max_tokens"
  : reason === "content_filter" ? "content_filtered"
  : "error"
```

The user runs on an OpenAI key, so `content_filtered` is **live-reachable**.

**2. Terminal-mapping leak — `decideRefusal` matches only the literal.**
`src/agent/recovery.ts:246-247`:

```ts
const decideRefusal = (stopReason: string, message: AssembledMessage): RecoveryAction | null =>
  stopReason === "refusal" ? { do: "refusal", rationale: extractRefusalRationale(message) } : null
```

`decideOnAssembled` (`src/agent/recovery.ts:306-326`) has **no**
`content_filtered` arm; a text-only `content_filtered` falls all the way through
to `return { do: "proceed" }` (line 325). On the default path
`resolveTurnAction` (`recovery.ts:404-406`) delegates to
`decideFromStopPolicy(undefined, …) ?? decideOnAssembled(…)` — policy `undefined`
returns `null` (line 351), so `decideOnAssembled` has the final word.
A `proceed` on a text-only turn is then sealed as SUCCESS in
`src/agent/loop/recovery-executor.ts:218-223`:

```ts
const toolCalls = message.content.filter((b) => b.type === "tool_use")
if (toolCalls.length === 0) {
  … wm.append(message)
  return { done: true, result: { kind: "completed", message } }
}
```

→ a content-filtered turn silently seals `completed`. Pinned today by
`recovery-hell.test.ts` NI-2 (`tests/unit/recovery-hell.test.ts:209-228`).

**3. Streaming leak — the DANGEROUS half (this is why the ticket stays open).**
`src/agent/streaming-dispatch.ts:626` gates the Phase-3 deferred (barrier-blocked,
concurrency-UNSAFE ⇒ MUTATING) drain on an EXACT literal:

```ts
if (stopReason !== "refusal") {
  if (!(await drainDeferredSlots(state.slots, dispatch, onToolStart, signal))) { … }
}
```

So `content_filtered` does **not** take the in-stream short-circuit: any
barrier-deferred mutating tool queued mid-stream before the filter stop is
**dispatched and executed**. This is a real side-effect, not a pinned intent.
The `resolveTurnAction` comment at `recovery.ts:379-387` already *documents* this
as a known gap ("`content_filtered` does NOT take the in-stream short-circuit …
so its deferred MUTATING tools run"), which makes the two literal checks the
single root: unifying them onto `isRefusalStopReason` closes both leaks at once.

**Defaults confirmed OFF (not a config accident):**
`buildRefusalFallbackInput` returns `undefined` unless
`config.refusalFallback.enabled === true` (`recovery.ts:190-191`), and
`stopReasonPolicy` is `undefined` on the wire path — so neither guard is engaged
by default. The leak is the default.

## Required changes — Option A (narrowest, fail-closed by default)

Reject Option B (default-on policy perturbs budget/retry accounting) and
Option C (re-introduces a tool-vs-text subtlety). The fix is a pure seam swap
gated by the **existing** provider-blind predicate — no new thresholds, no
heuristics ([[no-heuristics-only-validated]]).

1. **Terminal mapping.** In `decideRefusal` (`recovery.ts:247`) replace
   `stopReason === "refusal"` with `isRefusalStopReason(stopReason)` (already
   imported at `recovery.ts:1`). `content_filtered` now maps to `{ do: "refusal" }`
   → terminal, no silent `completed`.
2. **Streaming short-circuit.** In `streaming-dispatch.ts:626` replace
   `if (stopReason !== "refusal")` with `if (!isRefusalStopReason(stopReason))`.
   `content_filtered` now skips Phase 3 exactly like `refusal`, so deferred
   MUTATING slots keep `promise === undefined` and never dispatch.
3. **Flip NI-2** (`tests/unit/recovery-hell.test.ts:209-228`): the
   `content_filtered ⇒ proceed` assertions become `⇒ refusal`. `pause_turn` /
   `guardrail_intervened` stay `proceed` (still deliberately un-branched — the
   NI-2 defense-in-depth invariant is preserved for those two literals).
4. **Update the stale comments** at `recovery.ts:379-387` (which describe the
   old leak as expected) once the streaming site is unified.

Competitor baseline absorbed: Claude Code / Codex treat a provider
content-filter/safety stop as a terminal refusal executing no further tools —
this change brings quanta to parity on the default path.

## Acceptance

- Default embed/CLI path (`refusalFallback` OFF, `stopReasonPolicy` unset):
  a text-only `content_filtered` turn does **not** seal `{ kind: "completed" }`.
- A `content_filtered` stop with a barrier-deferred MUTATING slot does **not**
  call `drainDeferredSlots`; those slots keep `promise === undefined`.
- 4-combo config matrix (policy {unset, set-continue} × fallback {off, on})
  asserts no combo silently proceeds a content-filter stop — a future
  default-ON policy cannot silently regress this.

## Proof rails (red-on-injection — reverting the fix must re-red these)

```sh
# existing pins — NI-2 flips to `refusal` under Option A
bun test tests/unit/recovery-hell.test.ts
bun test tests/unit/agent/stop-reason-hellgate.test.ts
bun test tests/unit/refusal-fallback-units.test.ts
bun test tests/unit/streaming-dispatch-refusal-shortcircuit.test.ts
```

- **Streaming unit (mirror the refusal battery).** Extend
  `tests/unit/streaming-dispatch-refusal-shortcircuit.test.ts` (harness at
  lines 32-78; `makeHarness([])` yields a MUTATING `bash`, `dispatchCalls`
  records every dispatch). Add a case cloning NI-1 (line 81) but with
  `{ type: "message_stop", stop_reason: "content_filtered" }`, asserting
  `dispatchCalls` is empty (drain NEVER fired) and `res.stopReason === "content_filtered"`.
  Reverting the `streaming-dispatch.ts:626` swap re-reds this (the deferred
  `bash` would dispatch). Mirror NI-3 as a control: a `tool_use` stop STILL
  drains, proving the guard is reason-scoped, not a blanket skip.
- **Terminal-mapping unit.** In `recovery-hell.test.ts`, assert
  `decideOnAssembled("content_filtered", textMsg("x"), rec).do === "refusal"`
  (replacing the current `=== "proceed"` at line 227). Add a paired-control
  assertion that `pause_turn`/`guardrail_intervened` remain `proceed` so the
  swap is proven narrow.
- **Default-path e2e (new).** `tests/integration/content-filtered-default-e2e.test.ts`
  (does not exist yet): drive the OpenAI wire → loop with
  `refusalFallback` OFF and `stopReasonPolicy` unset; inject a
  `response.incomplete` / `content_filter` event with a queued barrier-blocked
  MUTATING slot; assert the loop result is NOT `{ kind: "completed" }` and the
  deferred slot's `promise === undefined`. This is the integration analogue that
  fails if either literal is reintroduced.

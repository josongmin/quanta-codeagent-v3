# ALBB-08 — Compaction breaker `empty_summary` gap + on-demand effort reset

**Priority:** P2  <!-- was P1; blast radius is bounded — see Severity note -->
**Wave:** B
**Depends on:** ALBB-07 (compaction touch surface)
**Owner:** `src/agent/loop/compaction-wire.ts`, `src/agent/compaction.ts`, `src/agent/loop/recovery-executor.ts`

## Goal

Make the proactive compaction circuit-breaker (`tengu_auto_compact_circuit_breaker`
parity, CC `consecutiveFailures ≥ z_K=3`) strike on EVERY non-progress proactive
outcome — including a refused/empty summarizer — so a summarizer stuck returning
`""` cannot spin the loop unbounded. Reset the effort classifier after
`/summarize-now` so escalated effort does not persist across a manual context reset.

## Problem

### Claim 1 (load-bearing) — `empty_summary` records NO breaker strike

`compactIfNeeded` distinguishes four non-progress `reason`s
(`src/agent/compaction.ts:246`):

```ts
reason: "under_threshold" | "no_boundary" | "deferred" | "empty_summary"
```

The SSOT intent comment at `src/agent/compaction.ts:652-656` says an empty/refused
summary is an **unproductive strike** and the breaker "still trips if it keeps
recurring":

```ts
// jun-26 SE-audit: an EMPTY/refused summarizer response must NOT replace the
// summarized prefix with an empty summary (it would silently DESTROY history).
// ... compacted:false is an unproductive strike, so the breaker still trips if it
// keeps recurring.
if (summary.trim() === "") {
  return { compacted: false, messages: input.messages, reason: "empty_summary" }
}
```

But the wire that turns a `compacted:false` into a strike, `applyProactiveResult`
(`src/agent/loop/compaction-wire.ts:437-439`), only matches `no_boundary`:

```ts
} else if (result.reason === "no_boundary") {
  breaker?.recordProactive(before, before)
}
```

`empty_summary` (and `deferred`) fall through the `else if` with **no
`recordProactive` call**. Because an empty summary leaves the transcript unshrunk
and STILL over-threshold, `maybeCompact` re-fires next turn, `compactIfNeeded`
re-consults the same refusing summarizer, returns `empty_summary` again — and
`proactiveStrikes` never increments, so `maxNoProgressProactive`
(`src/agent/compaction-breaker.ts:132`, default 3) **never trips**. This is the
exact unbounded-futility mode the breaker exists to catch.

Note the parallel THROW path is already correct: `runProactiveTier2`
(`src/agent/loop/compaction-wire.ts:386`) strikes on a summarizer exception:

```ts
breaker?.recordProactive(before, before)   // M9 — a compaction that THREW freed nothing
```

So this is a **narrow gap** (empty-string return vs throw), not a systemic one —
`empty_summary` should mirror `no_boundary`/throw.

### Claim 2 — `compactNowOnDemand` skips the effort-classifier reset

Every other compaction site resets the effort classifier after `wm.replace(...)`:

- proactive tier-2: `resetClassifier(config.effortClassifier)` at
  `src/agent/loop/compaction-wire.ts:424` (DI param threaded in from
  `context-assembler.ts:322` → `resetClassifier: resetEffortClassifier`).
- reactive PTL: `resetEffortClassifier(config.effortClassifier)` at
  `src/agent/loop/recovery-executor.ts:148`.

`compactNowOnDemand` (`/summarize-now`, `src/agent/loop/compaction-wire.ts:135`)
does `wm.replace([...result.messages])` at line **187** but never calls any reset —
`resetEffortClassifier` is not even imported into `compaction-wire.ts` (it lives at
`src/agent/loop/context-assembler.ts:176`). A user who escalated effort, then runs
`/summarize-now` to shed context, keeps the **stale escalated effort state** even
though the context that justified it was just summarized away. Real asymmetry.

### Claim 3 (optional, document-or-fix) — reactive `empty_summary` also skips a strike

`recovery-executor.ts:126` returns on `!compacted.ok` BEFORE `recordReactive` at
`:128`:

```ts
if (!compacted.ok) return { done: true, result: { kind: "error", reason: compacted.reason } }
const after = estimateTokens(compacted.messages)
breaker?.recordReactive(before, after)
```

So a reactive empty/refused summary skips a reactive strike. This is **real but
bounded**: the reactive path terminates in a hard `kind:"error"` (the turn ends,
no spin), unlike the proactive path which loops. Lower severity — fix or document
the intentional skip.

### Severity

P2, not P1 (ticket header downgraded). All three are real correctness gaps but the
blast radius is bounded: an empty/refused summarizer is a rare failure mode, and
only the **proactive** path (Claim 1) is an unbounded spin — reactive (Claim 3)
hard-errors and `/summarize-now` (Claim 2) is a state-staleness leak, not a loop.

## Required changes

### Fix 1 (fail-closed, evidence-driven SSOT) — strike on `empty_summary`

Do NOT just add `|| result.reason === "empty_summary"` inline at
`compaction-wire.ts:437` (it will drift again the next time a non-progress reason
is added). Instead make the set of unproductive reasons a **single source of truth**
next to the `CompactResult` type in `src/agent/compaction.ts` (~L231-247):

```ts
/** Non-progress proactive outcomes that MUST accrue a breaker strike (the
 *  transcript stayed over-threshold, so re-firing without a strike spins). NOT
 *  `deferred` (host explicitly chose to wait one turn) nor `under_threshold`
 *  (benign). Mirrors CC: a no-headroom proactive compaction is a
 *  consecutiveFailure regardless of WHY it froze nothing. */
export const UNPRODUCTIVE_PROACTIVE_REASONS = new Set(["no_boundary", "empty_summary"] as const)
```

Then `applyProactiveResult` (`compaction-wire.ts:437`) becomes:

```ts
} else if (UNPRODUCTIVE_PROACTIVE_REASONS.has(result.reason)) {
  breaker?.recordProactive(before, before)
}
```

This closes the CC-parity gap (`tengu_auto_compact_circuit_breaker`, `z_K=3`, cited
at `compaction-breaker.ts:12-13,38`): CC counts a no-headroom proactive compaction
as a `consecutiveFailure` regardless of the reason it froze nothing. `deferred`
stays excluded by design (it is a host-chosen wait, documented at
`compaction.ts:243-244`). No new imports in the wire; the reason set is defined
where the reasons are.

### Fix 2 (symmetric DI seam) — reset effort classifier in `compactNowOnDemand`

Thread a `resetClassifier` DI param into `compactNowOnDemand` exactly as
`applyProactiveResult`/`maybeCompact` take it (a param, NOT a direct import of
`resetEffortClassifier`, to keep the seam symmetric and testable). Call it AFTER
the `wm.replace([...result.messages])` at `compaction-wire.ts:187`:

```ts
wm.replace([...result.messages])
resetClassifier(config.effortClassifier)   // parity with proactive :424 / reactive :148
```

Wire the default at the caller `src/agent/loop/turn-iteration.js` (the
`compactNowOnDemand(args.cfg, args.wm, args.tokenBaseline)` call site) to pass
`resetEffortClassifier`. `undefined`/no-op default ⇒ byte-identical opt-out.

### Fix 3 (optional) — reactive `empty_summary`

Either move a `recordReactive(before, before)` strike ahead of the `!compacted.ok`
return at `recovery-executor.ts:126`, OR add a one-line comment documenting the
intentional skip (reactive terminates in a hard error, no spin). Measure-first: the
reactive breaker cap already backstops repeated reactive failures via `check()`;
only add the strike if a repro shows a reactive-refusal loop. Do NOT add an
arbitrary threshold.

## Acceptance

- Repeated proactive `empty_summary` outcomes trip `maxNoProgressProactive` and
  `maybeCompact` returns `{ abort:true, reason: "rapid_refill_breaker: proactive …" }`.
- `/summarize-now` (`compactNowOnDemand`) invokes the effort-classifier reset after
  the WM replace (spy-observed).
- `UNPRODUCTIVE_PROACTIVE_REASONS` is the single source; adding a new non-progress
  reason to `CompactResult` without adding it to the set leaves the wire behavior
  unchanged (drift is now a one-line, reviewable edit in one place).

## Proof rails (red-on-injection, not vacuous)

The existing hellgate `tests/unit/compaction-no-progress-strike-hellgate.test.ts`
exercises `compactIfNeeded`'s `no_boundary` return AND the breaker UNIT directly
(`recordProactive(before, before)` → cap trip), but it does **NOT** drive
`applyProactiveResult`'s `empty_summary` wire — that is the untested gap.

**Fix 1 rail — new WIRING test (extend `compaction-no-progress-strike-hellgate.test.ts`
or `tests/unit/compaction-breaker-hellgate.test.ts`):** drive the real
`applyProactiveResult`/`maybeCompact` path with a fake summarizer that returns `""`
(→ `compactIfNeeded` yields `{compacted:false, reason:"empty_summary"}`) `N =
maxNoProgressProactive` times against a live `CompactionBreaker`. Assert the
`(N)`th `maybeCompact` returns `{ abort:true }` with `reason` containing
`"rapid_refill_breaker: proactive"`. **Red-on-injection:** revert Fix 1 (drop
`empty_summary` from the set → back to `else if (result.reason === "no_boundary")`)
and the test must go RED — the breaker never trips, `maybeCompact` keeps returning
`{ abort:false }` (the spin). Guard against a vacuous pass by also asserting the
transcript stayed over-threshold and unshrunk across all N calls.

**Fix 2 rail — paired classifier-reset test (extend
`src/agent/loop/__tests__/compact-now-baseline-invalidation.test.ts`, which already
spins up `compactNowOnDemand` with a real summarizer + WM):** add a spy
`resetClassifier` (or spy on the threaded reset) and assert it is called exactly
once with `config.effortClassifier` AFTER a shrinking `/summarize-now`, and NOT
called on the non-shrinking `no_boundary` control (mirror the existing
"control: a NON-shrinking compaction leaves the box untouched" case at
`compact-now-baseline-invalidation.test.ts:103`). **Red-on-injection:** revert
Fix 2 (drop the `resetClassifier(...)` call) → the spy assertion goes RED.

**Regression rails to run:**

```sh
bun test tests/unit/compaction-no-progress-strike-hellgate.test.ts
bun test tests/unit/compaction-breaker-hellgate.test.ts
bun test src/agent/loop/__tests__/compact-now-baseline-invalidation.test.ts
bun test tests/unit/loop-reactive-compaction-emit-hellgate.test.ts
bun test tests/integration/breaker-x-recovery-hell-e2e.test.ts
```

## Baseline (competitor parity)

Anthropic Claude Code's `tengu_auto_compact_circuit_breaker` (mirrored explicitly at
`src/agent/compaction-breaker.ts:12-13,38`, `z_K=3`) counts a proactive compaction
that gains no headroom as a `consecutiveFailure` **regardless of why it froze
nothing**. Our `empty_summary` omission is precisely a CC-parity gap; Fix 1 restores
parity. No new heuristic or threshold is introduced — `maxNoProgressProactive`
already defaults to CC's `z_K=3` at `compaction-breaker.ts:50`.

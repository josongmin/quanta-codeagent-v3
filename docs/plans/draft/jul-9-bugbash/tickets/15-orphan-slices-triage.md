# ALBB-15 — Orphan slices triage (lane-manager, side-chat stub, objective idle-continuation)

**Priority:** P2 (triage / product-decision — not a live crash; all three slices are dormant, default-OFF, off any production path)
**Wave:** C
**Depends on:** product decision (wire-OR-deprecate-OR-delete per slice)
**Owner:** `src/agent/lane-manager/`, `src/agent/side-chat/`, `src/agent/objective/continuation.ts`

> Verdict: **keep** (confirmed real by two audit rounds). This is the canonical ticket for the orphan-slice overclaim; no merge target.

## Goal

Resolve three ADR slices that declare **L3 maturity** in the feature catalog but have **ZERO production importers**, and turn the manual "don't overclaim maturity" policy into an **enforced hard-gate** (extend the existing `fc reachability` import-graph check to L3) so this class can never regress.

## Ground-truth (verified 2026-07-09, current `main`)

Repo-wide import grep excluding `tests/` returns **empty** for all three barrels:

```
rg -l 'from ["'\'']@/agent/lane-manager'      src/ | grep -v test   → (empty)
rg -l 'from ["'\'']@/agent/side-chat'         src/ | grep -v test   → (empty)
rg -rn 'runIdleContinuation|evaluateContinuation' src/ | grep -v continuation.ts
      → only src/agent/objective/index.ts (BARREL re-export, not a call site)
```

| Slice | Catalog claim | Ground truth |
|-------|---------------|--------------|
| `lane-manager` | `lane-manager-parallel.yaml:6` **maturity: L3**; purpose (L25) asserts CASCADE contract "부모 abort 시 in-flight 전부 **force-cancel**" | Zero importers. `awaitAll` timeout branch (`default-manager.ts:261-301`) resolves a `timeout` LaneResult but **never calls `laneCtrl.abort()`** → the underlying `runner.delegate` keeps running (delegate leak). Docstring `default-manager.ts:12-13` "stragglers **force-cancel**" is false for the timeout path. |
| `agent/side-chat` | `side-chat-session-isolation.yaml:6` **maturity: L3** (dir `04-context-management/`) | Zero importers. `makeReply` (`default-manager.ts:69-73`) synthesizes `` `[side-chat ack] received ${userText.length} chars` `` with **no `@/llm`**. The real LLM-backed side-chat is `src/runner/orchestrate/side-chat.ts` (L4, wired via `orchestrate/index.ts`). Two SSOTs for one concept. |
| `objective/continuation` | `objective-budget-enforce.yaml:120-131` **notes** claim the budget gate "hooks into" `evaluateContinuation` / `runIdleContinuation` | The LIVE budget-suppression path is `objectiveBudgetExhausted` (`src/agent/loop/emit-helpers.ts:157-164`) reading the DERIVED `budget_limited` status — it does **not** touch the continuation machine. `runIdleContinuation` / `evaluateContinuation` / `ContinuationSemaphore` (`continuation.ts:114/145/214`) are **dead** (barrel-only). The `QUANTA_GOAL_ENFORCE` → `goalContinuationEnforce` knob (`knobs-b.ts:6`, `runtime-config.ts:212`, `runtime-config/types.ts:220`) has **zero readers**. |

## Problem (exact fail-open / silent paths)

**1. lane-manager timeout non-cancellation (latent correctness gap).**
`default-manager.ts:268-290` — the `Promise.race` timeout arm:

```ts
const timer = setTimeout(() => {
  const r: LaneResult = { id: h.id, ok: false,
    error: { kind: "timeout", message: `lane '${h.id}': exceeded awaitAll timeout (${timeoutMs}ms)` },
    durationMs: timeoutMs, ... }
  resolve(r)               // ← resolves the timeout result but the delegate is NEVER aborted
}, timeoutMs)
```

The per-lane `laneCtrl` (`default-manager.ts:160`) that could abort the delegate is **out of scope** here — `awaitAll` only holds `h.promise`, not the controller. So a timed-out lane's child agent runs to completion (or forever) consuming tokens/CPU. The yaml (L25) and docstring (L12-13) both promise force-cancel; the hellgate `HELL-LM-04` (`tests/unit/agent/lane-manager-hellgate.test.ts:146-171`) only asserts `r0.error.kind === "timeout"` and **never observes the delegate's signal** → vacuous guard, no red-on-injection.

**2. side-chat duplicate stub advertised as L3.**
The catalog lists `side-chat-session-isolation` at L3 with a placeholder reply that is structurally incapable of an LLM turn, while the canonical LLM-backed implementation lives elsewhere. An operator reading the catalog cannot tell which is real.

**3. objective idle-continuation dead + turns-budget half-wired.**
`runIdleContinuation`/`evaluateContinuation`/`ContinuationSemaphore` and the `QUANTA_GOAL_ENFORCE` knob are dead. Separately: `recordUsage` (`src/agent/objective/store.ts:370`) is invoked **only** via the objective tool (`src/tool/objective/index.ts:265-269`); there is **no loop-turn-boundary auto-increment** of `turnsUsed`. So the turns half of `objective-budget-enforce` only fires if the model voluntarily calls `objective_update {kind:"recordUsage", turns:…}` — the turns budget gate is effectively inert without self-report. (Token half is fine — usage flows through `collector.recordUsage` at `emit-helpers.ts`.)

**4. Policy hole (root cause of the overclaim regressing).**
`fc reachability` (`tools/feature-catalog/cli.ts:1097-1104`) already flags catalog features whose src files are unreachable via the **real import graph** (`tools/feature-catalog/reachability.ts`) — but line 1098 gates it to `L4`/`L5` only:

```ts
if (feature.maturity !== "L4" && feature.maturity !== "L5") continue   // ← L3 escapes
```

and `passesL3` (`cli.ts:430-432`) checks only `hasCode && hasTests`, **no reachability**. That is exactly why two orphan **L3** slices declare L3 with zero importers and pass `fc validate` today.

## Required changes

Resolve as **wire-OR-deprecate-OR-delete** with a fail-closed, evidence-driven proof rail — no heuristics, measure-first for anything efficacy-dependent.

### A. Hard-gate the overclaim (do this regardless of per-slice decision)

Extend `fc reachability` to **fail-close L3** overclaim, reusing the existing import-graph — NOT a keyword match:

- In `cmdReachability` (`tools/feature-catalog/cli.ts:1097`), change the maturity floor from `L4/L5` to **`>= L3`** (or add an L3-specific pass), so any feature declaring `maturity >= L3` whose declared `evidence.code` src files are ALL unreachable/dead-API (`computeReachability` / `computeSymbolReachability`) becomes an offender.
- Wire the offender set into a **non-zero exit** (align with the existing `--strict`) so CI fails closed. This is the SOTA move R1 asked for: the manual policy becomes an enforced gate. Add it to whatever CI already runs `fc validate`.

### B. lane-manager — wire OR demote (product decision)

- **If wire** (parallel sub-agent lanes mirror Claude Code's Task/sub-agent fan-out and Codex's parallel tool dispatch — the competitor baseline): fix the real bug. Plumb the per-lane `laneCtrl` (or a `handle.cancel()`) so the `awaitAll` timeout arm at `default-manager.ts:283` calls `laneCtrl.abort()` before `resolve(r)`, aborting the underlying `runner.delegate`. Then land a host call-site that injects `defaultLaneManager` through `AgentConfig` + a reader for `QUANTA_LANE_MAX_CONCURRENCY`, gated behind a default-OFF knob, and A/B on the SWE/TB rail before claiming efficacy. Promote to L4 only after a real consumer exists.
- **If demote**: drop `lane-manager-parallel.yaml` to **L1** (scaffold), delete the false "force-cancel" language from the yaml purpose (L25) and the `default-manager.ts:12-13` docstring, and remove the `HELL-LM-04` straggler claim from the yaml `notes` (L42) unless the cancel is actually implemented.

### C. side-chat — collapse to one SSOT

Delete the `@/agent/side-chat` stub slice (or explicitly relabel `side-chat-session-isolation.yaml` to **L1 scaffold** with a non-LLM contract in `deliberate_hold`), and keep `src/runner/orchestrate/side-chat.ts` as the canonical L4. Remove the duplicate L3 catalog entry so `fc` reports one truth.

### D. objective idle-continuation — wire OR delete

- **If wire**: bind `runIdleContinuation` off the existing idle-monitor / reactor seam and make `goalContinuationEnforce` (`runtime-config.ts:212`) actually gate `ContinuationDeps.enabled`, with a smoke test proving an idle thread with an active goal triggers exactly one `resume`. Also add a loop-turn-boundary `recordUsage({turns:1})` so the turns budget is real (measure-first, default-OFF).
- **If delete**: remove `runIdleContinuation` + `evaluateContinuation` + `ContinuationSemaphore` from `continuation.ts`, drop their barrel re-exports (`src/agent/objective/index.ts:18-22`), delete the `QUANTA_GOAL_ENFORCE` knob (`knobs-b.ts:6`, `runtime-config.ts:212`, `runtime-config/types.ts:220`), and correct `objective-budget-enforce.yaml:120-131` notes to describe the ACTUAL suppression path (`objectiveBudgetExhausted` reading `budget_limited`), not the continuation machine.

> Scope note (R1): the `objective-budget-enforce` **budget-suppression half is legitimately wired and stays L3** — target the dead continuation orchestrator + unread knob only, not the whole objective feature. `objective-first-class.yaml` is honestly L2 with a truthful "NOT wired" `deliberate_hold`.

## Acceptance

- No feature declares **maturity ≥ L3** whose declared `evidence.code` src files are all unreachable via `fc reachability` (import-graph), OR the feature is explicitly demoted/relabeled.
- `bun fc validate` and the extended `fc reachability --strict` both pass (exit 0) after the status updates.
- If wired: default-OFF knob shipped, efficacy A/B recorded on the SWE/TB rail before any promotion.

## Proof rails

Behavioral / red-on-injection tests (must fail if the defect is reintroduced — no vacuous compile assert):

1. **lane-manager cancel (if wired):** extend `tests/unit/agent/lane-manager-hellgate.test.ts` `HELL-LM-04` so the injected `DelegationRunnerPort.delegate` records whether its `spec.signal` fires; assert the signal is **aborted** on timeout. Mutation: reverting the `laneCtrl.abort()` line in `default-manager.ts` must turn this test RED.
2. **overclaim gate:** a test over `runGates`/`cmdReachability` that injects a synthetic L3 feature whose `evidence.code` points at an unreachable src file and asserts it is reported as an offender + non-zero exit (mutation: raising the floor back to L4-only turns it green → RED-on-injection proves the gate).
3. **objective continuation (if wired):** a smoke test on the idle-monitor/reactor seam proving an idle thread with an active goal + `QUANTA_GOAL_ENFORCE=1` calls `resume` exactly once, and OFF calls it zero times.

```sh
bun fc validate
bun fc reachability --strict            # extended: must now flag L3 orphans
rg -l 'from "@/agent/lane-manager"' src/ | grep -v test   # expect a host call-site OR empty-with-demotion
rg -rn 'runIdleContinuation|evaluateContinuation' src/ | grep -v continuation.ts   # expect a real caller OR deletion
rg -rn 'goalContinuationEnforce' src/ | grep -v runtime-config   # expect a reader OR knob removed
```

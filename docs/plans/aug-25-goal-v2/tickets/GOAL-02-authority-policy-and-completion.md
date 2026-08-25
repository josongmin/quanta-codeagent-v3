# GOAL-02 — Exhaustive authority policy and deterministic completion

**Priority:** P0 · **Depends on:** GOAL-01 · **Owner:** objective policy

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-02.yaml

## Purpose

Put definition, completion, and terminal-state authority behind the same actor-by-mutation policy. Completion is a deterministic projection of trusted evidence; an LLM judge is optional telemetry and has no admission power.

## Policy owner

Add src/objective/policy.ts with:

    type MutationVerdict = "allow" | "deny" | "approval"
    const MUTATION_POLICY:
      Record<ObjectiveMutation["kind"], Record<ObjectiveActor, MutationVerdict>>

The composition-owned raw authority calls authorizeMutation after normalization and before commit. Consumers use GOAL-01 actor-fixed capabilities; no caller-supplied actor or system/internal bypass exists.

## Required decisions

- create: user/system allow. Model only through the existing gate-on approval proposal. Gate-off model create is denied.
- replace, clear, amendBudget: user/system only.
- setExplicitStatus: user/system only; blocked, budget-limited, and usage-limited recovery uses the owning mutation, not status forcing.
- setNextActions: user/model/continuation/system.
- Manual markCriterion(met:true|false): user/system only.
- Checked criteria reject all manual marking.
- A user/system may reopen a completed manual criterion with met:false; status immediately re-derives to active. Model mutations remain denied while completed.
- applyVerificationBatch and invalidateVerification: verifier only.
- beginAttempt, settleAttempt, markUsageLimited, and restore: system-fixed capabilities only.
- Model cannot clear a committed blocker. User/system or the host resolver may clear it.
- replace and clear reject with attempt-in-flight while a durable started attempt is unsettled. Pause/cancel first; after terminal settlement the user may replace/clear. This prevents deleting the accounting owner mid-turn.

GOAL-09 adds a distinct transient observeBlocker mutation; do not overload the verdict type with an observe pseudo-permission.

## Completion contract

Completion requires at least one criterion, no blocker, every criterion met, and a trusted completion receipt. Manual receipts must be user/system attestations. Checked receipts must come from the matching immutable check and a passing verifier result.

- Zero criteria is never completed.
- validationContract is derived as missing, manual-only, or checked.
- Completed, blocked, budget-limited, and usage-limited are derived states; only active/paused is explicit.
- Every rejection has a stable typed code. Tool/CLI/web render the code but do not reimplement policy.

## Model tool reduction

- Model update operations retain next actions and the pre-GOAL-09 blocker surface; model completion is absent from schema.
- Remove status, recordUsage, and completion-admission branches.
- objective_set creates only through the existing HITL proposal when the gate is on.
- Keep thread_id deprecated/ignored only for compatibility; host-bound thread identity wins. Remove it after catalog/client compatibility is proven.

## Judge shadow boundary

- Config accepts only off or shadow; legacy reject parses to off with one warning.
- Shadow output can emit telemetry only. It cannot mutate state, add blockers, deny completion, or affect wake decisions.
- Do not launch detached unowned promises. GOAL-04 may wire an ObjectiveJudgeObserverPort registered with the session task lifecycle, with its own evaluation budget, timeout, cancellation, and awaited disposal.
- Until that lifecycle exists, production shadow invocation stays disabled. Unit evaluation of the observer is allowed.
- Raw transcript, tool output, criterion prose, and caller-supplied digests remain excluded from judge input.

## RED rails

1. Zero-criteria objective cannot become completed through any actor/mutation pair.
2. Model marking the last manual criterion met is denied with manual-attestation-required.
3. User marking it met completes; user reopening it reactivates while preserving objective ID.
4. Checked completion can only come from a verifier batch.
5. Gate-off model create is denied; gate-on proposal still requires approval.
6. Completed model setNextActions is terminal-denied; user criterion correction is allowed.
7. Blocked/budget-limited state cannot be escaped via explicit active.
8. Every mutation × actor cell exists; injected table deletion fails module validation.
9. A mutant allowing model manual completion makes the policy test red.
10. Judge timeout, throw, circuit-open, or hostile result changes no objective state.
11. A model/web command cannot forge system/verifier actor or reach raw authority; direct composition-owned commit still invokes policy.
12. replace/clear during a started attempt rejects; pause remains allowed and suppresses re-arm.

## Verification

    bun test tests/unit/objective tests/unit/objective-tools-hellgate.test.ts
    bun test tests/unit/agent/objective-completion-admission.test.ts tests/unit/goal-judge-config.test.ts
    bun test tests/unit/objective-hitl-bypass-h1-hellgate.test.ts
    bun run typecheck
    bun run lint:debt

## Stop conditions

- A completion path still depends on model prose or judge availability.
- The policy table omits an actor/mutation combination.
- A consumer must duplicate transition rules to render an outcome.
- Shadow work can outlive session disposal or consume the objective execution budget.

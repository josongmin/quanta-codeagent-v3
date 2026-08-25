# GOAL-06 — Bounded event-driven wake controller and hard product cap

**Priority:** P0 · **Depends on:** GOAL-04 · **Owner:** goal wake controller/policy

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-06.yaml

## Purpose

Replace interval polling with one owned timer, require live quiescence at arm and fire, back off on no progress/failure, and make autonomous execution bounded even when user budget is absent or oversized.

## Controller contract

- Remove startGoalContinuationTicker, interval constants, and interval injection.
- goal-quiescence.ts projects existing live stores only: turn, plan mode, external prompt, text/image/plan queues, follow-up, approval, attach/close.
- Check quiescence both before arming and immediately before enqueue.
- One timer per active thread/objective. Timer, subscriptions, and claims are disposed on clear, replace, attach, close, and fatal session state.
- Consecutive no-progress count is derived from attributed progress receipts; do not create a second durable counter.
- A controller-local monotonic activityEpoch/lastUserActivity observes raw input and existing queues. Reservation/queued work captures it; dequeue rejects a changed epoch without consuming or deleting the user's draft.
- User activity resets backoff and requires a full quiet period.
- Usage-limit schedules one timer at the persisted expiry and re-arms correctly after restart.

computeGoalWakeDelay returns a typed delay or skip reason:

- progress -> base quiet
- success/no progress -> exponential backoff capped at max
- error/refusal/infrastructure unavailable -> capped cooldown/backoff
- usage-limited -> exact remaining expiry
- validation-contract-missing, paused, blocked, completed, budget-limited, fatal, freshness-unresolved, non-quiescent -> skip

Fire order is fixed: timer fires -> await GOAL-03 reconcile (cheap precheck first) -> reread objective/revision/activityEpoch/quiescence/caps (+ sessionEpoch once GOAL-07 exists; until then the claim carries no epoch) -> reserve -> enqueue. Reconcile mutation/unavailable never leaves an old reservation; it cools down or rearms from the fresh state.

## Hard-cap rule

    userRemaining =
      max(0, (userConfiguredMaxTurns ?? Infinity) - objectiveBudgetTurnsUsed)
    productRemaining =
      max(0, productHardCap - autonomousTurnsStarted)
    autonomousWakeAllowed = min(userRemaining, productRemaining) > 0

- Product default is 20 and cannot be raised by user/session config.
- If user max is 5 and product cap 3, effective cap is 3. The previous plan's budget-overrides-product behavior is forbidden.
- Objective budget turnsUsed includes attributed user goal work and autonomous work. Product hard-cap usage is the GOAL-04 durable autonomousTurnsStarted counter.
- Controller checks caps before reservation; authority beginAttempt atomically rechecks and consumes the slot before provider execution. No N+1 enqueue or crash refund.
- On cap exhaustion, authority derives budget_limited with source user-budget or product-hard-cap; renderer shows requested limit, both counters, and limiting source.
- A same-ID budget amendment can recover user-budget exhaustion when userRemaining becomes positive. It never resets productRemaining. Pause/resume also cannot reset either counter.
- Token budget and usage-limit remain independent stop boundaries.

## Policy/config owner

goal-wake-policy.ts owns defaults and clamps:

- minimum public quiet: 15 seconds
- maximum backoff: 15 minutes
- product autonomous turn cap: 20

Runtime config, knob inventory, renderer, controller, and catalog import/reflect these definitions. No NODE_ENV bypass, hidden dev flag, or public unsafe override.

## Claim registry

Use one bounded entry per threadId + objectiveId with highest committed ordinal and at most one reservation. Delete it on clear/replace/attach. A reservation is released on typed rejection/cancel and committed only by an accepted submit/settlement lifecycle.

## RED rails

1. No-progress sequence produces 15s, 30s, 60s ... under a fake clock.
2. Same-revision verifier/agent infrastructure failure stays in cooldown; user revision change resets to base quiet. Shadow judge never participates in wake.
3. No user budget: product cap N gives exactly N autonomous attempts and then budget_limited.
4. User max 5/product cap 3 gives exactly 3, not 5.
5. User max 2/product cap 20 gives exactly 2; one attributed foreground goal turn leaves only one autonomous user-budget turn but consumes zero product-cap turns.
6. Live plan mode, approval, draft, queued input, active turn, attach, or close prevents fire.
7. Quiet value below 15 seconds clamps and emits one bounded warning.
8. 100k ordinal churn leaves registry size equal to active objectives.
9. Clear/replace/attach/dispose leaves no claim/timer.
10. Agent throw clears active-turn and reservation in finally.
11. Continuation enqueue does not self-cancel; later raw input changes activityEpoch and makes dequeue drop only the continuation, preserving the user draft.
12. Budget amendment recovers user-limit exhaustion but cannot recover an exhausted product cap.
13. Hard-cap precheck and post-settlement check each fail a dedicated mutant.
14. Deleting the fire-time quiescence check makes the race test red.
15. UI idle suppression and goal quiet remain independent.
16. Missing validation contract produces wake 0 and renderer guidance instead of consuming the product cap.
17. Reconcile revision change/unavailable causes reread/cooldown with zero stale reservation.

## Timing tests

- Unit/in-process integration uses injected clock/timer through controller construction.
- PTY uses production clamp. It asserts the typed scheduling decision or performs at most one real 15-second cycle; it never injects 200ms policy or a test-only runtime knob.
- Existing interval-disposal hellgates are rewritten to assert owned controller timer/subscription disposal, preserving the safety invariant.
- Existing PTY cases that pass `QUANTA_GOAL_QUIET_MS` below the clamp (idle-drives-continuation, own-quiet-window, partial-draft, foreground-rearm, Ctrl+B) are rewritten in this ticket: assert the typed `goal-wake armed delay=` scheduling decision from the decision counter/NDJSON instead of waiting for a fire, and keep at most ONE real 15 s cycle in the whole file. Budget the PTY file at <= 90 s wall clock.

## E2E

- Budget max 2 produces exactly two autonomous attempts and no third.
- Partial draft/background turn/plan mode/approval suppresses wake.
- Restart during usage-limit restores one expiry timer.
- Verifier unavailable causes cooldown with no hot loop.

## Verification

    bun test tests/unit/objective/goal-wake-controller.test.ts tests/unit/objective/goal-wake-policy.test.ts
    bun test tests/unit/apps/cli/goal-wake-hook.test.ts tests/unit/apps/cli/goal-quiescence.test.ts
    bun test tests/integration/goal-continuation-live-e2e.test.ts
    bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts
    bun run typecheck
    bun run lint:debt

## Stop conditions

- Any interval polling remains reachable.
- User configuration can exceed the product cap.
- A timer/claim can outlive its objective or session.
- PTY requires a production safety bypass.

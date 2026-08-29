# GOAL-04 — Attributed turn settlement and durable outcome ordering


> **구현 대조 (2026-08-30, 코드 확인)** — 귀속·정산은 명세대로이고 형태가 둘 다르다.
> - 런타임 입력의 `objectiveAttempt?: {...}`는 **capability 객체** `objectiveAttemptSlot`(claim/take/release/failStop/recover/status)로 구현됐다(`src/objective/attempt.ts`).
> - `settlement_uncertain`은 `{kind:"fail-stopped", reason, objectiveId}`로, `ObjectiveAuthorityState`라는 이름은 존재하지 않는다(조합은 `core-store/completion-ops.ts` 내부).
> - **rail 4(`/goal verify`가 에이전트 턴을 소모하지 않음)는 주인이 없다**: GOAL-05로 이월했다고 적혔으나 GOAL-05 티켓에 그 rail이 없고, main에 이를 단언하는 테스트도 없다. rail 5는 GOAL-08 round2/3이 닫았다.
> - rail 9(일시정지가 비용은 기록하되 재무장은 막는다)는 테스트가 없다. rail 16은 attempt key를 빌더에 넣지 않은 채 단언해 사실상 공허하다.
> - E2E 1번은 절반만 실재한다: PTY 재시작 케이스는 **평범한 foreground 턴**을 감싸며, "started slot이 소비된 채 남고 body가 재생되지 않는다"는 유닛(`attempt-lifecycle.test.ts`)에만 있다.

**Priority:** P0 · **Depends on:** GOAL-03 · **Owner:** runtime turn transaction

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-04.yaml

## Purpose

Charge only explicitly attributed goal work, durably reserve an attempt before paid execution, settle every terminal path once, and persist enough uncertainty state to prevent crash/restart replay.

## Attribution contract

Runtime input carries:

    objectiveAttempt?: {
      threadId: string
      objectiveId: string
      startedRevision: number
      attemptId: string
      provenance: "autonomous-continuation" | "user-requested-goal-work"
      executionMode: "foreground" | "background"
    }

- Ordinary foreground chat has no objectiveAttempt, incurs no objective tokens/turns, and writes no progress receipt.
- /goal verify is verifier work, not an agent turn; it consumes verifier resource limits but no model-turn budget. Only the explicit /goal work front door (and its typed web equivalent) may mint user-requested-goal-work; plain chat is never classified heuristically.
- Autonomous wake turns use autonomous-continuation.
- Objective budget turnsUsed counts durable starts from both attributed provenance classes. A separate autonomousTurnsStarted count increments only autonomous-continuation; GOAL-06 product cap reads that count.
- startedRevision is audit evidence, not an equality CAS: legitimate in-turn mutations may advance revision.
- Settlement is bound to objectiveId, attemptId, and the active turn claim. GOAL-07 adds sessionEpoch to the claim.
- If pause happens during the turn, cost is still recorded for the same objective but no re-arm occurs. GOAL-02 rejects replace/clear while the durable attempt is unsettled.

## Two-phase atomic state owner

Refactor authority dispatch so beginAttempt and settleAttempt receive combined ObjectiveAuthorityState containing core, attempts, and progress. Do not commit budget, attempt state, and receipt through separate public writers.

beginAttempt binds objectiveId, attemptId, provenance, ordinal, claim, revision, and sessionEpoch when available. It reserves one objective turn, increments autonomousTurnsStarted only for autonomous provenance, records status started, and advances revision exactly once. Persist this start through the existing session snapshot/journal before invoking a paid provider.

Settlement contains actual token delta, normalized stop outcome, criterion/verifier IDs before the turn, completion deltas, and injected-clock time. Authority:

1. Rejects duplicate attemptId or mismatched objective/claim.
2. Requires a matching durable started attempt and never debits the turn twice.
3. Applies measured token usage and terminal status exactly once.
4. Computes criterion/verifier deltas from authority state.
5. Appends one progress receipt for the attributed terminal attempt.
6. Advances revision once.

## Runtime order

In runRuntimeTurn:

1. Validate the host claim, commit beginAttempt, and durably persist started before provider execution.
2. Snapshot BudgetMeter and pre-turn evidence.
3. Run the agent inside a terminal-normalization boundary; throw, abort, refusal, approval wait, and provider errors become typed outcomes.
4. Reconcile verifier freshness. Reconcile throw/CAS contention becomes typed unavailable/freshness-unresolved and never skips settlement.
5. In one finally-style terminal path, commit settleAttempt exactly once.
6. Build and persist the post-settlement turn/session snapshot.
7. Emit checkpoint projection; only then may wake evaluate again.

Move this logic to a focused objective-settlement helper so turn-runner and shell-adjacent files do not breach god-function/module ratchets.

## Usage and failure rules

- BudgetMeter before/after delta is authoritative. Goal composition fails at boot if it is absent.
- Event accumulation is test/legacy compatibility only and cannot enforce a production objective budget.
- Pin OpenAI and Anthropic cassette expectations for input, output, cached, and reasoning token accounting; avoid double-counting reasoning tokens.
- Reuse renderTaskBudgetBlock for task + objective budget. No second budget prompt/render owner.
- A persisted started attempt is never rolled back or refunded after provider execution may have begun. If terminal persistence fails, leave the attempt started/settlement_uncertain, durably mark the session fail-stopped when possible, and reject further turns.
- On restore, orphaned started/settlement_uncertain attempts consume their turn/autonomous slot, are never automatically replayed, and suppress re-arm until recovery marks them abandoned or an operator starts a new objective generation.
- Never claim transcript/tool/file side effects were rolled back.
- Shadow judge, if enabled, is registered in the session task lifecycle, metered separately, timed out, canceled, and awaited on disposal.

## RED rails

1. Ordinary foreground question leaves objective tokens, turns, and receipts unchanged.
2. Attributed foreground goal work and autonomous continuation each charge exactly once.
3. Attributed foreground goal work does not increment the autonomous hard-cap count.
4. /goal verify charges no agent turn and obeys verifier resource budget.
5. Plain goal-related chat remains unattributed; /goal work mints user-requested provenance.
6. Provider is not called until started attempt persistence succeeds.
7. Same attemptId begin/settle replay rejects without a second debit.
8. Replace/clear during a started attempt rejects with attempt-in-flight; after cancellation/settlement, edit cannot inherit its receipt.
9. Pause during a turn records cost but prevents re-arm.
10. Agent throw, abort, approval wait, and reconcile failure all settle/persist one typed outcome.
11. Crash after start persist, during provider call, or after response-before-settle leaves a non-replayable slot after restart.
12. Terminal persist failure does not refund the start; restart stays fail-stopped/uncertain.
13. Missing production BudgetMeter fails composition.
14. Verifier deltas include only IDs created during this attempt.
15. Every StopReason maps exhaustively to one ProgressTurnOutcome.
16. Prompt contains no raw attempt key or internal claim.
17. Moving begin persistence after provider or settlement after terminal persistence makes dedicated mutants red.

## E2E

- Autonomous attempt at each crash point, process restart: started slot remains consumed and agent body is not replayed.
- Unrelated chat while goal active: no objective budget movement.
- User-requested goal work: budget moves once and receipt provenance is foreground.
- Terminal persist failure: next input and restart auto-rearm are rejected by durable uncertain/fatal state.

## Verification

    bun test tests/unit/objective/attempt-lifecycle.test.ts tests/unit/objective/progress-receipt.test.ts
    bun test tests/unit/host/turn-runner-objective-settlement.test.ts tests/unit/agent
    bun test tests/integration/goal-continuation-live-e2e.test.ts
    bun test tests/unit/objective-budget-enforce-e2e-hellgate.test.ts
    bun run typecheck
    bun run lint:debt

## Stop conditions

- Budget/attempt/progress require independently writable public stores.
- Production enforcement uses inferred/self-reported usage.
- A paid attempt can execute before its durable start or be refunded after uncertainty.
- A generic foreground turn is charged merely because a goal exists.

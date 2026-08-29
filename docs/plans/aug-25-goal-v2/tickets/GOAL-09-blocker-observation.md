# GOAL-09 — Typed dependency blockers and transient-observation hysteresis


> **구현 대조 (2026-08-30, 코드 확인)** — 히스테리시스(3회 distinct attempt)는 진짜이고, **의존성 식별 절반이 명세와 반대**다.
> - `observeBlocker`는 mutation kind가 아니다. 하나의 `addBlocker` mutation(+선택적 `attemptId`/`target`)을 actor로 라우팅한다(`src/objective/blocker-observation.ts`). `mutations.ts`/`policy.ts`의 관련 주석은 아직 옛 설명을 담고 있다.
> - `dependencyKey`(host 파생)는 없다. 실제 `dependencyRef`는 **모델이 준 문자열들의 `JSON.stringify`**이고 레지스트리 조회가 없다 — 티켓의 stop condition("prose/hash가 의존성을 식별하면 중단") 위반.
> - `occurrenceEvidenceId` 미구현 ⇒ RED 6(occurrence vs attempt 구분)은 표현 자체가 불가능하다.
> - 5개 레지스트리 생산자 중 검증되는 것은 0이다. 승인 채널은 raw `addBlocker`에 자유 문자열을 넣고(`src/agent/approval-state-machine/store.ts`), attention/subagent는 objective를 참조조차 하지 않는다. 유일한 `target.ref` 생산자는 모델(`src/tool/objective/index.ts`)이다. 단 `attemptId`는 host가 찍는다.

**Priority:** P1 · **Depends on:** GOAL-02, GOAL-04, and GOAL-06 · **Owner:** objective blocker policy

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-09.yaml

## Purpose

Distinguish confirmed host-known dependencies from repeated transient failure. Do not delay a real approval/user dependency for three attempts, and do not let model prose manufacture blocker identity.

## Mutations

- addBlocker is trusted and immediate for user/system or a validated host dependency resolver.
- observeBlocker is transient for model/continuation and may promote after three distinct attributed attempts.
- clearBlocker is user/system or host resolver only. A model cannot clear committed blockers.
- GOAL-02 policy table is extended exhaustively with observeBlocker; MutationVerdict remains allow/deny/approval.

## Dependency identity

Host creates two typed values only after lookup in the owning registry:

- stable scoped dependencyKey: owner + tool/service/resource + closed failure classification + session/objective scope
- per-occurrence occurrenceEvidenceId: the concrete approval/request/tool-call/network-retry evidence for one attributed attempt

Registry sources:

- pending approval ID
- pending attention/user-input request ID
- child task/thread ID and state
- tool-call/retry evidence ID
- network retry classification/evidence ID

Model may reference a candidate occurrence ID; host validates existence, scope, state, current session/attempt, and derives dependencyKey itself. Free-form reason, waitingOn label, model key, endpoint text, or normalized prose never forms identity.

Confirmed pending approval or user-input/attention dependency immediately produces blocked/awaiting state and stops wake. Transient network/tool failures use hysteresis.

## Observation state

BlockerObservation stores bounded dependencyKey, occurrence evidence IDs, waitingOn, distinct attributed attempt IDs, first/last time, and classification. Maximum eight observations; deterministic oldest eviction.

- Same attempt or same occurrence replay counts once.
- Three distinct attempts with three validated occurrences under the same dependencyKey promote to one blocker.
- Stable dependencyKey/classification change starts a separate observation; a new occurrence ID for the same key is expected and merges.
- Verified progress clears transient observations, not committed blockers.
- Snapshot v2 persists observations; v1 migrates empty.

Before wiring, inventory producers: `src/attention/*` and the approval channel exist; a child task registry exists for subagents; a standalone network retry classifier/evidence registry does NOT exist today (only adapter-internal retry). Producers that do not exist are recorded as scope-out with the wake behavior they would have gated; do not invent a registry solely to satisfy hysteresis.

Wire actual producers: approval channel, attention queue, child task registry, tool failure normalization, and network retry classifier. Tests must prove each owner emits the typed reference; prompt text alone is insufficient.

## RED rails

1. Same attempt repeated ten times counts once.
2. Two transient attempts remain active; third distinct matching attempt blocks.
3. Confirmed pending approval blocks on first observation.
4. Confirmed user-input/attention request blocks immediately.
5. Unknown, completed, wrong-session, or prose-only occurrence is rejected.
6. Three different occurrence IDs for one stable dependencyKey reach 3/3; replaying one occurrence does not increment.
7. Different dependencyKey/classification does not merge.
8. Verified progress clears transient observations only.
9. Model clearBlocker is denied; host resolver clears when dependency resolves.
10. Persistence preserves observations, occurrence IDs, and attempt IDs.
11. Ninth observation evicts deterministically.
12. Every producer has a wiring test with a real registry entry.
13. Removing distinct-attempt/occurrence logic or host lookup makes a mutant red.

## E2E

- Two identical transient tool/network failures show observing 2/3; third blocks and wake stops.
- Pending approval blocks immediately; approval resolution clears/rearms according to policy.
- Progress between transient failures resets the observation sequence.

## Verification

    bun test tests/unit/objective/blocker-observation.test.ts tests/unit/objective/authority.test.ts
    bun test tests/unit/objective-tools-hellgate.test.ts tests/unit/goal-pursuit-prompt-hellgate.test.ts
    bun test tests/integration/goal-continuation-live-e2e.test.ts
    bun run typecheck
    bun run lint:debt

## Stop conditions

- Prose/hash identifies a dependency.
- Confirmed approval/user wait is delayed by hysteresis.
- Model can clear a blocker.
- A producer has no registry-backed evidence.

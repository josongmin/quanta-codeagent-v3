# GOAL-07 — Transactional attach/fork and session-epoch fence


> **구현 대조 (2026-08-30, 코드 확인)** — 이 티켓의 **Epoch fence / Transaction 섹션은 구현되지 않았다.**
> - `sessionEpoch`, `WakeLifecyclePort` 는 repo 전체에 존재하지 않는다(grep 0). 실제 fence는 objective별 `attachGeneration` 카운터(`src/objective/authority.ts`)다.
> - `src/session/attach-session.ts`는 114줄 선형 절차다 — prepare-all/역순 롤백/fatal fail-stop/wake-cancel 단계가 없다. 순서 보장 7단계는 웹 데몬(`src/apps/web-daemon/server/thread-hydrate.ts`)에 있고, 이는 티켓이 금지한 "두 번째 코디네이터" 형태다.
> - commit 후 "검증 unknown 표시 + bounded reconcile" 없음.
> - 따라서 RED 3~7(롤백)과 10/14의 epoch 절반은 검증 대상 자체가 없다. rail 12(fork)는 `cloneObjectiveForFork`가 구현돼 있으나 테스트 참조가 0이다.
> - GOAL-04/06이 "GOAL-07이 sessionEpoch를 추가하면"이라 적은 문장들도 같은 이유로 무효다.

**Priority:** P1 · **Depends on:** GOAL-06 · **Owner:** existing session attach transaction

**Receipt:** docs/plans/aug-25-goal-v2/receipts/GOAL-07.yaml

## Purpose

Make transcript, persistence target, objective domain, UI surface, and wake ownership move together on attach; prevent old queued continuations from crossing session identity.

## Canonical owner

Extend the existing src/session/attach-session.ts transaction. Do not add a second CLI/web attach coordinator.

The host adapter decodes snapshot v1/v2 and validates zero-or-one objective domain before authority invocation. replaceDomainForAttach accepts only an already normalized domain or null; the authority does not parse a list or own codec policy.

Initial boot hydrate remains a separate no-clobber operation. Explicit attach always replaces the live objective domain, including replacing it with null.

## Transaction

Prepare all fallible data before mutation, then snapshot:

- transcript/conversation state
- persistence target
- objective core/progress/revision
- surface selection
- wake controller/claim state
- draft, queued user input, queued goal prompts, and activityEpoch
- current sessionEpoch

Commit in this order:

1. Reject if a turn/approval/attach/close, user draft, or pending user-owned input is active.
2. Cancel wake/reservations and drain queued goal prompts belonging to the old epoch. User input is never discarded.
3. Replace transcript.
4. Switch persistence target.
5. Replace objective domain and progress.
6. Switch surface/live identity.
7. Mint/increment sessionEpoch and commit the attach.

Every mutated dependency exposes a rollback hook. On failure, roll back in reverse order. Rollback failure puts the session in the same fatal fail-stop state as GOAL-04.

After commit, mark verification unknown and run bounded reconcile under the new epoch/lifecycle. Until it succeeds, wake is suppressed. Verifier unavailable leaves B attached and freshness-unresolved; it does not roll back to A. A post-commit scheduler/re-arm failure leaves B attached and fail-stops autonomous scheduling.

GOAL-07 defines the required WakeLifecyclePort and proves the shared transaction with CLI plus a fake port. GOAL-08 binds the real daemon controller and owns daemon attach/restart/re-arm E2E; GOAL-07 has no circular production no-op completion claim.

## Epoch fence

- sessionEpoch is minted on boot and incremented after successful explicit attach.
- Every queued prompt, goal reservation, and turn provenance carries it.
- Dequeue/submit rejects an old epoch before agent execution.
- A restart creates a new epoch; restored objective can be re-armed only with the new epoch.
- Epoch is host execution identity, not an objective ID and not caller-selectable.

## Fork decision

- Locate and extend the existing fork/store owner in src/session/store.ts and current CLI/web fork path.
- Fork clones definition and budget, issues a new objective ID, starts paused, and copies no progress, completion, verifier, blocker, attempt, or claim evidence.
- Persist the forked paused snapshot through the same session snapshot codec.

## RED rails

1. Attach A -> B moves objective/progress, commits new epoch, then arms B only after reconcile.
2. Attach to B with no goal removes A objective and wake.
3. Transcript replacement failure restores every owner and original epoch.
4. Persistence-target failure restores transcript/objective/surface/wake.
5. Objective replacement failure restores earlier commits.
6. Surface switch failure rolls back the transaction; post-commit reconcile/re-arm failure keeps B attached and wake suppressed/fail-stopped.
7. Rollback failure makes session fatal and rejects future turns.
8. Mid-turn, pending approval, user draft, or queued user-input attach calls no mutator.
9. Multiple/duplicate decoded domains fail before mutation.
10. Old revision or old sessionEpoch queued work executes agent body zero times.
11. Initial hydrate remains byte-compatible and no-clobber.
12. Fork gets new ID, paused state, same definition/budget, and zero evidence.
13. Moving wake cancel after transcript mutation makes the race test red.
14. A queued A goal prompt is drained/rejected by old epoch and never executes under B.
15. Verifier unavailable after commit leaves B visible with freshness-unresolved and wake 0, not A rollback.

## E2E

- CLI attach/resume to thread B shows B goal, persists B, and emits no A continuation.
- Injected commit failure proves visible transcript/objective/persistence identity remains A.
- Daemon attach/restart/rearm is deferred to GOAL-08, where the real controller exists.

## Verification

    bun test tests/unit/session tests/unit/apps/cli/attach-objective.test.ts
    bun test tests/unit/apps/web-daemon/thread-hydrate-hellgate.test.ts
    bun test tests/unit/objective/attach-replace.test.ts
    # daemon attach E2E lives in GOAL-08 (real controller); GOAL-07 proves the shared transaction with the CLI + fake WakeLifecyclePort
    bun run typecheck
    bun run lint:debt

## Stop conditions

- CLI and web own separate attach ordering.
- Any committed owner lacks rollback or fatal containment.
- Authority receives an undecoded multi-domain payload.
- Queued work has no sessionEpoch.

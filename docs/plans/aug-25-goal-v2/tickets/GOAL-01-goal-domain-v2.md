# GOAL-01 — goal-domain-v2: objectiveId, create/replace/clear, 파생 전용 completed

**Priority:** P0 · **Depends on:** GOAL-00 · **크기:** 40+ tool-use, main-direct (세션 1개 전용)

## 목적
turn 중 목표가 교체돼도 이전 attempt 증거가 새 목표에 붙지 않게 안정적인 `objectiveId`를 authority가 발급하고,
`set`이 create/replace를 겸하는 모호성과 `updateStatus("completed")`·`recordUsage` 모델 mutation을 제거해
completed를 **검증 결과로만 파생**되게 만든다. `clear`는 pause 위장이 아니라 실제 삭제가 된다.

## 작업명세
### 파일
- `src/objective/types.ts` — `Objective.objectiveId: string`, `createdBy: ObjectiveActor` 추가.
- `src/objective/mutations.ts` — union 교체:
  ```ts
  export type ExplicitObjectiveStatus = "active" | "paused"
  export type ObjectiveMutation =
    | { kind: "create"; goal: string; criteria?: readonly CriterionDeclaration[]; budget?: ObjectiveBudgetLimit }
    | { kind: "replace"; goal: string; criteria?: …; budget?: … }
    | { kind: "clear" }
    | { kind: "setExplicitStatus"; status: ExplicitObjectiveStatus }
    | { kind: "addBlocker"; reason: string; waitingOn: WaitingOn }
    | { kind: "clearBlocker"; blockerId: string }
    | { kind: "setNextActions"; actions: readonly string[] }
    | { kind: "markCriterion"; criterionId: string; met: boolean }
    | { kind: "applyVerificationBatch"; batch: VerificationBatch }      // GOAL-03이 채움, 여기선 타입+거절만
    | { kind: "settleAttempt"; settlement: ObjectiveAttemptSettlement } // GOAL-04가 채움, 여기선 타입+거절만
    | { kind: "markUsageLimited"; untilEpochMs: number }
    | { kind: "restore"; snapshot: ObjectiveDomainSnapshot }
  ```
  `set`·`updateStatus`·`recordUsage` 제거. `OBJECTIVE_MUTATION_KINDS` 배열 갱신(`mutation-completeness.test.ts`가 잡음).
- `src/objective/core-store/cell.ts` — `explicitStatus: "active" | "paused"`. 파생 규칙(`cell.ts:97-115`)에서 completed 분기는
  `completionSatisfied(cell)`(GOAL-02에서 정책 확정; 이 티켓은 "all met ∧ criteria>0 ∧ blockers=0" 유지) 호출로 교체.
- `src/objective/core-store/rehydrate.ts:45,225` — legacy `explicitStatus==="completed"` 읽기 → migration: completed는 버리고
  `active`로 복원하되 criteria met/completion receipt는 유지(파생이 다시 completed를 만들면 그게 정답).
- `src/objective/core-store/objective-ops.ts` — `create`(objective 존재 시 `objective-exists`), `replace`(부재 시 `objective-missing`;
  새 objectiveId, 모든 criterion completion/blockers/nextActions 초기화), `clear`(cell 삭제).
- `src/objective/authority.ts`
  - `ObjectiveAuthorityOptions.idFactory?: () => string` (default `crypto.randomUUID`). caller가 ID를 넘기는 경로 없음.
  - `clear`는 core cell + `progress.delete(threadId)` + **revision 증가**(0으로 리셋 금지 — queued wake를 stale로 만들기 위해).
  - `fromSnapshot`: `deps.progress.clear()` 추가 후 snapshot에 있는 progress만 재구성.
  - legacy snapshot(`objectiveId` 없음) → `legacy:${sha256(threadId+goal+createdAt)}` deterministic ID 1회 부여, 재로드 시 동일.
- `src/objective/progress-receipt.ts` — `ProgressReceipt.objectiveId: string` 추가; `normalizeProgressReceipt`가 빈 값 거절.
  `recordProgressReceipt`는 `receipt.objectiveId !== current.objectiveId`면 false.
- `src/objective/criteria/model.ts` — `ManualCompletionReceipt`/`VerifierCompletionReceipt`에 `objectiveId` 추가.
- `src/objective/index.ts` export 갱신. `src/tool/objective/index.ts`의 `opToMutation`은 컴파일 깨지는 부분만 최소 매핑
  (`status`→`setExplicitStatus`(completed 거절), `recordUsage` op 제거). 정책 축소는 GOAL-02.
- 소비자 컴파일 수정(**컴파일 통과 최소치만**; 명령 구조·문구·renderer는 GOAL-05 소유): `src/apps/cli/slash/{goal-cmd,objective}.ts`(`set`→`create|replace`, `clear`는 진짜 `clear`, `recordUsage`/`status:completed` op 제거),
  `src/host/runtime/objective-store-wire.ts`, `src/objective/usage-limit-wire.ts`, web `objective-pane` 관련.

### 규칙
- ID는 authority만 발급. 모델/CLI/web 입력에서 ID를 받지 않는다.
- edit = replace = 새 generation. 이전 증거는 전부 무효(receipt는 objectiveId 불일치로 자동 거절).
- pause/resume은 ID 유지. attach restore는 저장 ID 유지.
- god-code: authority.ts(572줄)가 800 넘지 않게 ID/migration은 `src/objective/identity.ts`로 분리.

## RED (구현 전 실패 확인)
`tests/unit/objective/authority.test.ts`, `persistence-roundtrip.test.ts`, `mutation-completeness.test.ts`, `progress-receipt.test.ts` 확장 + 신규 `tests/unit/objective/identity.test.ts`
1. `create` 두 번 → 두 번째 `objective-exists`.
2. objective 없이 `replace` → `objective-missing`.
3. `replace` 후 objectiveId 변경, criteria completion/blockers 비워짐, revision +1.
4. `clear` 후 `readDomain(t).state === null` **그리고** `progressReceipts.length === 0`, revision은 이전+1(0 아님).
5. old objectiveId를 가진 receipt `recordProgressReceipt` → false.
6. `fromSnapshot(snapshot without thread X)` 후 X의 progress 잔존 0.
7. legacy snapshot(objectiveId 없음) 로드 → ID 부여, 재로드 시 동일 ID(deterministic).
8. legacy `explicitStatus:"completed"` snapshot → 파생 상태만 completed 가능, explicit는 active.
9. `setExplicitStatus("completed" as any)` 컴파일 에러 + 런타임 normalize 거절.
10. mutation kind 목록과 DISPATCH/actor 표 drift-guard(`mutation-completeness`).

## E2E
- `tests/integration/goal-continuation-live-e2e.test.ts`: `/goal edit` 후 이전 turn의 지연 receipt가 새 objective에 붙지 않음.
- PTY: `/goal clear` 후 `/goal`이 "no goal", 세션 재기동 후에도 "no goal".

## Proof rails
```sh
bun test tests/unit/objective tests/unit/objective-*.test.ts tests/unit/goal-*.test.ts
bun test tests/unit/apps/cli tests/unit/apps/web-daemon
bun test tests/integration/goal-continuation-live-e2e.test.ts tests/integration/objective-*.test.ts
bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts
+ 공통 rail
```

## 함정
- `objective-resume-lifecycle.test.ts`·`objective-snapshot-intent-hellgate.test.ts`가 explicit completed를 고정하고 있으면 그 테스트는 **정책 반전**이므로 삭제가 아니라 반전 서술로 교체.
- `session/envelope.ts` snapshot codec 버전 bump 필요 시 `restore.ts`의 legacy 경로 유지.

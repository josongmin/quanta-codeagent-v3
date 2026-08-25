# GOAL-09 — blocker observation: 모델 addBlocker 3-attempt hysteresis (Quanta 안전 확장)

**Priority:** P1 · **Depends on:** GOAL-04 (attemptId), GOAL-02 (정책표) · **크기:** ~30 tool-use, main-direct

## 목적
모델이 `addBlocker` 한 번으로 objective를 `blocked`(파생, 최우선)로 만드는 것을 막는다. 프롬프트 문장(`pursuit-prompt.ts:15,32`)이 아니라
authority가 서로 다른 host attempt 3개에서 같은 dependency가 관측될 때만 실제 blocker로 승격한다. user/system blocker는 즉시.

## 작업명세
### 파일
- `src/objective/types.ts` — `Objective.blockerObservations: readonly BlockerObservation[]`(bounded 8):
  ```ts
  interface BlockerObservation { observationId: string; dependencyRef: string; waitingOn: WaitingOn; distinctAttemptIds: readonly string[]; lastObservedAt: number }
  ```
  `dependencyRef` = host가 `waitingOn` + typed 대상(`{kind:"approval"|"external"|"user-input"|"tool", ref}`)으로 생성. reason prose hash는 identity로 쓰지 않음. 모델은 `blocker_key`를 제공하지 않음.
- `src/objective/mutations.ts` — `addBlocker`에 `attemptId?: string`(host가 turn header에서 주입; 모델 입력 아님). `src/tool/objective/index.ts`가 `ctx`의 현재 turnId를 채움.
- `src/objective/policy.ts` — actor=model/continuation의 `addBlocker` → `observe` verdict(observation append/merge), user/system → 즉시 blocker. 정책표 `MutationVerdict`에 `observe` 추가 + drift-guard.
- `src/objective/core-store/criteria-ops.ts` — observation merge: 같은 `dependencyRef`면 `distinctAttemptIds`에 attemptId 추가(중복 제거) → 길이 ≥3이면 실제 blocker 생성 + observation 제거. `applyVerificationBatch`/`settleAttempt`에서 verified progress(transition>0 또는 verifier delta>0)면 observations 전부 삭제.
- `src/objective/pursuit-prompt.ts` — hysteresis 문장 제거(런타임이 보장), "blocked는 host가 판정" 한 줄로 교체. `goal-pursuit-prompt-hellgate.test.ts` 갱신.
- snapshot codec: observations 포함(`persistence-roundtrip`), legacy는 빈 배열.

## RED
`tests/unit/objective/authority.test.ts`, `persistence-roundtrip.test.ts`, 신규 `tests/unit/objective/blocker-observation.test.ts`, `tests/unit/objective-tools-hellgate.test.ts`
1. 같은 attemptId로 model addBlocker 10회 → observation 1개, distinctAttemptIds 길이 1, status active.
2. attempt 2개까지 status active, blockers 0.
3. 3번째 distinct attempt 동일 dependencyRef → blockers 1, observations 0, status blocked.
4. waitingOn 또는 대상 ref 변경 → 별도 observation, 카운트 리셋.
5. verified progress(verifier receipt delta>0) → observations 삭제.
6. persistence roundtrip 후 observation 및 attemptIds 유지.
7. user actor addBlocker → 즉시 blocked.
8. judge(shadow) 결과만으로 blocker/observation 생성 경로 없음(정책표에 judge actor 없음 — 컴파일).
9. observation 8개 초과 → 가장 오래된 것 제거(bounded).
10. red-on-injection: distinct 검사를 제거한 mutant에서 1 RED.

## E2E
- PTY(cassette가 3 turn 연속 같은 approval 대기 blocker 호출): 2회 후 `/goal` `blocked: none (observing 2/3)`, 3회 후 `blocked: approval · waiting on user`, wake 0.
- `tests/integration/goal-continuation-live-e2e.test.ts`: 2회 blocker 후 verifier pass → observation 삭제, 3번째 호출이 다시 1/3부터.

## Proof rails
GOAL-06 rail + `bun test tests/unit/objective/blocker-observation.test.ts tests/unit/goal-pursuit-prompt-hellgate.test.ts`.

## 함정
- `objective-snapshot-cap-hellgate.test.ts` 크기 상한에 observations 포함 — cap 계산 갱신.
- Codex 공개 parity 아님 → catalog에 "Quanta safety extension"으로 표기.

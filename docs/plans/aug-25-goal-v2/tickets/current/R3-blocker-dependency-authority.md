# R3 — Host-resolved blocker dependency identity and occurrence evidence

**Status:** READY · **Priority:** P1 · **Owner:** objective blocker authority + host registries

## 목적

모델 prose/reference가 blocker identity를 제조하지 못하게 하고, 동일 dependency의 세 번의 실제
host-attributed occurrence만 hysteresis를 통과하게 한다.

## 현재 사실

- distinct attempt ID는 live objective attempt에서 host가 읽는다.
- dependency key는 모델 입력 `[waitingOn,target.kind,target.ref]`의 JSON 문자열이다.
- promotion 후 live blocker dedupe는 `reason + waitingOn`이다.
- approval state machine은 실제 approval ID를 소유하며 이미 blocker를 즉시 추가/해제한다.
- RunLedger와 TaskRegistry에는 host-known active work identity가 있다.

## 권한 결정

- `ObjectiveAuthority`가 observation/threshold/promotion의 단일 owner로 남는다.
- host adapter는 candidate target을 `BlockerDependencyResolverPort`로 조회한다.
- resolver 결과만 stable `dependencyId`와 opaque `occurrenceEvidenceId`를 만들 수 있다.
- approval/user-input은 실제 owner의 immediate blocker 경로만 사용한다. model hysteresis 요청은 거절한다.
- tool/child-agent는 동일 thread의 active RunLedger/TaskRegistry record만 허용한다.
- external/network는 owning registry가 없는 동안 `dependency-unresolved`; 티켓을 만족시키려고 새 registry를
  만들지 않는다.

## 구조 작업

1. objective slice에 sync, no-throw resolver port/result union을 정의하고 authority construction에 주입한다.
2. model/continuation `addBlocker`를 authority에서 resolve한 뒤 observation input으로 변환한다.
3. `BlockerObservation`을 stable dependency와 bounded occurrence pair 목록으로 변경한다.
   각 pair는 `attemptId + occurrenceEvidenceId + observedAt`을 가진다.
4. promoted `Blocker`에 optional `dependencyId`를 기록한다.
5. live dedupe와 pending observation grouping을 `dependencyId`로 통일한다. reason은 display copy일 뿐이다.
6. session schema/rehydrate/migration을 갱신한다. legacy model-derived `dependencyRef`는 current registry
   identity로 신뢰 승격하지 않고 drop/degraded 처리한다.
7. tool schema의 target kind/ref 설명을 실제 resolver capability와 일치시킨다.

## 예상 write set

- `src/objective/blocker-observation.ts`
- `src/objective/core-store/criteria-ops.ts`
- `src/objective/types.ts`, `src/objective/store.ts`, `src/objective/policy.ts`
- `src/objective/authority.ts`, authority construction/wire
- `src/tool/objective/index.ts`
- `src/session/types.ts`, `src/session/store.ts`
- `src/objective/core-store/rehydrate.ts`
- host adapters for ApprovalStateMachine/RunLedger/TaskRegistry

## RED rails

1. 동일 registry dependency, 서로 다른 reason/ref, 3 attempts → blocker 1.
2. 서로 다른 dependencies, 동일 reason/waitingOn → blocker 2.
3. 동일 attempt 또는 동일 occurrence replay → count 증가 0.
4. unknown/completed/wrong-thread registry ID → observation 0.
5. approval/user-input model observation → delayed duplicate blocker 0; owner immediate blocker 1.
6. progress가 transient observations만 clear하고 committed blocker는 보존.
7. persistence round-trip이 dependency/occurrence/attempt identity를 보존.
8. reason 기반 dedupe를 복원하면 mutant RED.

## DoD

- model-controlled 문자열이 identity/grouping/dedupe에 관여하지 않는다.
- 지원되는 producer마다 real registry entry를 사용하는 wiring test가 있다.
- 지원되지 않는 dependency kind는 정직한 typed refusal을 반환한다.

## 중단 조건

- normalized prose/hash를 stable dependency identity로 사용하는 경우.
- approval/user-input을 3-attempt hysteresis 뒤로 보내는 경우.
- resolver를 tool adapter에만 두어 authority raw capability가 우회 가능한 경우.

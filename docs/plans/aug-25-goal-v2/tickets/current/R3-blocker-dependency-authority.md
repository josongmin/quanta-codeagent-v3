# R3 — Host-resolved blocker dependency identity and occurrence evidence

**Status:** DONE · FINAL PROMOTION GREEN · **Priority:** P1 · **Owner:** objective blocker authority + host registries

## 목적

모델 prose/reference가 blocker identity를 제조하지 못하게 하고, 동일 dependency의 세 번의 실제
host-attributed occurrence만 hysteresis를 통과하게 한다.

## 구현 결과

- `BlockerDependencyResolverPort`는 objective authority construction에 주입되는 sync/no-throw port다.
- Layer-2 registry adapter는 existing `RunLedger`와 `TaskRegistry`만 조회한다. 별도 dependency store를
  만들지 않는다.
- tool dependency는 same-thread active RunLedger record, child-agent dependency는 active TaskRegistry record와
  same-thread active subagent RunLedger record가 모두 있을 때만 resolve된다.
- approval/user-input/external, unknown, settled, wrong-thread record는 `dependency-unresolved`로 거절된다.
- authority는 live attempt ID를 host state에서 읽고 resolver가 반환한 stable `dependencyId`와 opaque
  `occurrenceEvidenceId`만 pending evidence에 기록한다.
- observation과 promoted blocker dedupe는 `dependencyId`가 소유한다. reason은 display copy다.
- persisted occurrence pair는 `attemptId + occurrenceEvidenceId + observedAt`이며 legacy model-derived
  `dependencyRef` observation은 loadable하되 복원 시 drop된다.
- approval state machine의 실제 owner blocker는 기존대로 즉시 추가/해제되며 model hysteresis 경로로
  들어가지 않는다.

## 권한 결정

- `ObjectiveAuthority`가 observation/threshold/promotion의 단일 owner로 남는다.
- host adapter는 candidate target을 `BlockerDependencyResolverPort`로 조회한다.
- resolver 결과만 stable `dependencyId`와 opaque `occurrenceEvidenceId`를 만들 수 있다.
- approval/user-input은 실제 owner의 immediate blocker 경로만 사용한다. model hysteresis 요청은 거절한다.
- tool/child-agent는 동일 thread의 active RunLedger/TaskRegistry record만 허용한다.
- external/network는 owning registry가 없는 동안 `dependency-unresolved`; 티켓을 만족시키려고 새 registry를
  만들지 않는다.

## 확정 구조

1. objective slice의 sync/no-throw resolver port/result union을 authority construction에 주입한다.
2. model/continuation `addBlocker`는 authority 안에서 resolve한 뒤 observation input으로 변환한다.
3. `BlockerObservation`은 stable dependency와 bounded occurrence pair 목록을 가진다.
   각 pair는 `attemptId + occurrenceEvidenceId + observedAt`을 가진다.
4. promoted `Blocker`에 optional `dependencyId`를 기록한다.
5. live dedupe와 pending observation grouping은 `dependencyId`만 사용한다.
6. session schema/rehydrate/migration이 current occurrence shape를 보존한다. legacy model-derived `dependencyRef`는 current registry
   identity로 신뢰 승격하지 않고 drop/degraded 처리한다.
7. tool schema는 exact active RunLedger/TaskRegistry ID와 optional `run:`/`task:` alias만 지원한다고
   명시한다.

## 검증 receipt

- source typecheck: PASS
- test typecheck: PASS
- focused battery: PASS (125 tests / 11 files) + adversarial approval isolation (15/0)
- modified-file Biome + god-code ratchet: PASS (`src/session/store.ts` split back to 981 lines)
- registry/authority focused rails: same dependency copy drift, distinct dependency same reason,
  same-attempt/occurrence replay, wrong-thread/inactive/unknown, child-agent dual-registry proof
- persistence: real session save/load + authority reopen preserves dependency/occurrence/attempt identity
- migration: legacy model-derived dependency observation restores as empty
- approval owner rail: model approval/user-input/external targets produce no observation; owner immediate
  blocker tests remain green

이 receipt는 R3 branch의 focused closure다. main 통합과 R6 동일-HEAD full gate 전에는 최종 promotion
완료로 간주하지 않는다.

## 예상 write set

- `src/objective/blocker-observation.ts`
- `src/objective/core-store/criteria-ops.ts`
- `src/objective/types.ts`, `src/objective/store.ts`, `src/objective/policy.ts`
- `src/objective/authority.ts`, authority construction/wire
- `src/tool/objective/index.ts`
- `src/session/types.ts`, `src/session/store.ts`
- `src/objective/core-store/rehydrate.ts`
- host adapters for ApprovalStateMachine/RunLedger/TaskRegistry

## 고정된 RED rails

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

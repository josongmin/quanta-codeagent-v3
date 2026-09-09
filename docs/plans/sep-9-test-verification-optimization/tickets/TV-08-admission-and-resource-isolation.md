# TV-08 — 단일 admission 예산과 단계적 자원 격리

- 우선순위: 대기 통합 P0 / lease 분할 P2
- 상태: FOCUSED_VERIFIED
- 소유자: 통합 담당
- 선행: TV-01, TV-02, TV-04
- lease 분할 추가 선행: TV-07, 격리 canary 증거

## 문제와 근거

campaign의 180초 대기, shard의 600초 대기, needsQuietBox gate의 추가 대기가 분산돼 있다. repo lease는 전체 campaign 동안 유지된다. 현재 pure 분류는 heuristic이므로 lease를 즉시 풀면 공유 자원 충돌 위험이 있다.

## 구현 범위 A — 먼저 적용

1. 한 admission owner가 전체 waitBudgetMs와 소진량을 관리하고 nested runner에 남은 예산을 전달한다.
2. bounded poll을 유지하되 이미 대기한 하위 단계에 새 예산을 지급하지 않는다.
3. 심각한 부하와 예산 소진은 explicit deferred/blocked로 반환한다. PASS로 처리하지 않고 실제 full 실행 여부도 사용자 정책에 따른다.
4. tier의 timeout-scale을 고정한다. host load가 결과 의미를 바꾸는 내부 timeout을 임의로 늘리지 않게 한다.
5. SIGINT가 대기·실행 중 어디서든 빠르게 전달되고 child drain 후 lease를 해제한다.
6. 처음에는 전체 lease를 유지한다. 대기 예산 통합만으로 resource 모델을 변경하지 않는다.

## 구현 범위 B — 격리 증명 후

1. immutable checkout, test 전용 HOME/TMP/cache, ephemeral port를 확보한다.
2. resources가 없는 것과 분류 불가능을 구별한다. unknown은 exclusive다.
3. host CPU/RAM weighted semaphore와 repo-write/worktree/browser 등 exclusive lease를 분리한다.
4. 1분 load 평균만으로 영구 직렬화하지 않고 runner-owned RSS/활성 child와 가용 용량을 함께 쓴다.
5. 작은 concurrency로 시작해 1/2/4 폭에서 verdict와 RSS를 비교한다. browser/LSP 전용 조건을 유지한다.

## 수정 파일

- `tools/dev/verification-campaign.ts`, `box-load.ts`, `test-shard-lease.ts`, `test-shard-lifecycle.ts`, `run-test-shards.ts`
- NEW: `tools/dev/verification-admission.ts`
- TEST: `tests/unit/dev/verification-campaign.test.ts`, `tests/unit/test-shard-lease.test.ts`, `tests/unit/dev/box-load.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/verification-admission.ts` | NEW `AdmissionBudget`, `AdmissionDecision`, `remainingBudgetMs` | campaign 시작의 monotonic deadline 하나를 authority로 만들고 nested wait가 남은 값만 소비하게 한다. `admitted/deferred/cancelled`를 tagged union으로 반환한다. | fake clock에서 180초 상위 대기 후 하위 예산 리셋 0. |
| `tools/dev/verification-campaign.ts` | `CAMPAIGN_QUIET_BOX_BUDGET_MS`, `waitForQuietBox`, `terminate` | local budget 상수를 admission 객체로 교체하고 receipt에 consumed/remaining/reason을 쓴다. signal handler는 abort→child drain→lease release 순서다. | 대기 중 SIGINT와 spawn 0 assertion. |
| `tools/dev/box-load.ts` | `QuietBoxOptions`, `waitForQuietBox`, `quietBoxBudgetMs` | 절대 deadline 또는 budget provider를 받게 하고 자체 전체 예산 재발급을 금지한다. | nested call의 총 wait 상한 검증. |
| `tools/dev/run-test-shards.ts` | quiet-box/admission 호출부 | 상위 admission context가 없으면 명시적 standalone budget을 한 번 만들고, 있으면 그대로 전달한다. | campaign/standalone 두 경로 test. |
| `tools/dev/test-shard-lease.ts` | `acquireRepositoryLease` | A단계에서는 lease 범위를 유지한다. B단계에서만 resource key를 추가하며 unknown은 repo-exclusive다. | 정상/timeout/cancel/throw 후 lease file과 waiter 정리. |
| `tools/dev/test-shard-lifecycle.ts` | process registry/cleanup | cancellation 결과가 모든 child drain 완료 전 success receipt를 쓰지 못하게 한다. | descendant 생존 0. |

## 작업 순서

1. A단계 admission type과 fake-clock test를 구현한다.
2. campaign→box-load→runner 순으로 deadline을 관통시킨다.
3. cancellation cleanup 회귀를 통과시킨다.
4. TV-07 RSS/child 관측 자료를 모은다.
5. B단계 격리는 별도 변경으로 1→2→4 concurrency canary 후 활성화한다.

## 검증 계획

fake clock/load로 상위 대기 후 하위 대기 예산이 늘지 않는지 검사한다. deferred일 때 child spawn 0. SIGINT 대기/worker/cleanup 각 단계의 lease와 descendant 정리를 검사한다. resource conflict, unknown, fairness/starvation, memory limit은 작은 fake worker로 검증한다.

## 완료 기준

- [ ] 중복 wait budget 없음.
- [ ] 대기·blocked·실행 실패가 서로 구분됨.
- [ ] 다른 작업의 프로세스를 임의 종료하지 않음.
- [ ] lease 분할은 격리 증거가 있을 때만 별도 완료됨.
- [ ] 정상/취소/실패 모두 lease와 자식 정리 증거 있음.

## 실패·복구

resource 분할에서 충돌이 발견되면 해당 class를 exclusive로 복구한다. timeout 확대나 retry-green으로 감추지 않는다.

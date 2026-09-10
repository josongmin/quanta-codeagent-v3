# TV-08 — resource certification, 단일 admission 예산, lease 세분화

- 우선순위: certification P0 / 대기 통합 P0 / lease 분할 P1
- 상태: IMPLEMENTING — certification authority/audit와 keyed-lease primitive focused green; 558개 review와 campaign integration 미완료
- 소유자: 통합 담당
- 선행: TV-01, TV-02, TV-04
- lease 분할 추가 선행: TV-07, 격리 canary 증거

## 문제와 근거

campaign의 180초 대기, shard의 600초 대기, needsQuietBox gate의 추가 대기가 분산돼 있다. repo lease는 전체 campaign 동안 유지된다. 현재 분류는 regex/path heuristic이며, 2026-09-11 current HEAD에서 `integration-path` fallback이 558 files다. 이 파일들은 8개 chunk 안에서 intra-worker width 1로 실행된다. lease를 먼저 풀면 공유 자원 충돌 위험이 있다.

현재 class 분포는 pure 3,012, integration-path 558, lsp 206, port 62, process-global 55, worktree 17, browser 12, repo-write 2다. `VALIDATED_NONPURE_OVERLAPS`는 비어 있고 browser는 host-exclusive다. 이 값은 분류 현황이지 격리 증명은 아니다.

## 구현 범위 B0 — 558개 resource certification

1. 신규 `test-resource-certification.ts`와 registry에 test ID, source SHA-256, owner, typed claims, isolation scope를 둔다.
2. classifier는 후보 보고서만 생성한다. registry를 자동 수정하거나 heuristic 결과를 인증으로 승격하지 않는다.
3. claim key는 최소 `checkout`, `git-common`, `cache`, `port:<n|ephemeral>`, `browser:<profile>`, `lsp:<workspace>`, `process-env:<key>`, `child-process`를 표현한다.
4. source digest drift, 미등록, parser 실패, unknown claim은 exclusive fallback이다.
5. 시간 가중치가 큰 integration-path 파일부터 owner가 실제 setup/teardown과 production boundary를 검토한다. 558개 모두가 명시적으로 certified 또는 intentionally-exclusive가 될 때까지 fallback bucket을 제거하지 않는다.
6. static guard는 bare identifier가 아니라 실제 fs/env/spawn/listen/git call을 요구하고 anti-vacuum floor와 red-on-injection self-test를 가진다.

## 구현 범위 A — 먼저 적용

1. 한 admission owner가 전체 waitBudgetMs와 소진량을 관리하고 nested runner에 남은 예산을 전달한다.
2. bounded poll을 유지하되 이미 대기한 하위 단계에 새 예산을 지급하지 않는다.
3. 심각한 부하와 예산 소진은 explicit deferred/blocked로 반환한다. PASS로 처리하지 않고 실제 full 실행 여부도 사용자 정책에 따른다.
4. tier의 timeout-scale을 고정한다. host load가 결과 의미를 바꾸는 내부 timeout을 임의로 늘리지 않게 한다.
5. SIGINT가 대기·실행 중 어디서든 빠르게 전달되고 child drain 후 lease를 해제한다.
6. 처음에는 전체 lease를 유지한다. 대기 예산 통합만으로 resource 모델을 변경하지 않는다.

## 구현 범위 B1 — certification 후 lease/scheduler 분할

1. immutable checkout, test 전용 HOME/TMP/cache, ephemeral port를 확보한다.
2. resources가 없는 것과 분류 불가능을 구별한다. unknown은 exclusive다.
3. host CPU/RAM weighted semaphore와 checkout/git-common/cache/port/browser/LSP 등 keyed shared/exclusive lease를 분리한다.
4. 1분 load 평균만으로 영구 직렬화하지 않고 runner-owned RSS/활성 child와 가용 용량을 함께 쓴다.
5. 작은 concurrency로 시작해 1/2/4 폭에서 verdict와 RSS를 비교한다. browser/LSP 전용 조건을 유지한다.

## 수정 파일

- `tools/dev/verification-campaign.ts`, `box-load.ts`, `test-shard-lease.ts`, `test-shard-lifecycle.ts`, `run-test-shards.ts`
- NEW/LANDED: `tools/dev/verification-admission.ts`, `tools/dev/test-resource-certification.ts`, `tools/dev/test-resource-certification-audit.ts`, `tools/dev/test-resource-certifications.json`
- TEST: `tests/unit/dev/verification-campaign.test.ts`, `tests/unit/test-shard-lease.test.ts`, `tests/unit/dev/box-load.test.ts`, NEW `tests/unit/dev/test-resource-certification.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/verification-admission.ts` | NEW `AdmissionBudget`, `AdmissionDecision`, `remainingBudgetMs` | campaign 시작의 monotonic deadline 하나를 authority로 만들고 nested wait가 남은 값만 소비하게 한다. `admitted/deferred/cancelled`를 tagged union으로 반환한다. | fake clock에서 180초 상위 대기 후 하위 예산 리셋 0. |
| `tools/dev/verification-campaign.ts` | `CAMPAIGN_QUIET_BOX_BUDGET_MS`, `waitForQuietBox`, `terminate` | local budget 상수를 admission 객체로 교체하고 receipt에 consumed/remaining/reason을 쓴다. signal handler는 abort→child drain→lease release 순서다. | 대기 중 SIGINT와 spawn 0 assertion. |
| `tools/dev/box-load.ts` | `QuietBoxOptions`, `waitForQuietBox`, `quietBoxBudgetMs` | 절대 deadline 또는 budget provider를 받게 하고 자체 전체 예산 재발급을 금지한다. | nested call의 총 wait 상한 검증. |
| `tools/dev/run-test-shards.ts` | quiet-box/admission 호출부 | 상위 admission context가 없으면 명시적 standalone budget을 한 번 만들고, 있으면 그대로 전달한다. | campaign/standalone 두 경로 test. |
| `tools/dev/test-shard-lease.ts` | `acquireRepositoryLease` | A단계에서는 lease 범위를 유지한다. B단계에서만 resource key를 추가하며 unknown은 repo-exclusive다. | 정상/timeout/cancel/throw 후 lease file과 waiter 정리. |
| `tools/dev/test-shard-lifecycle.ts` | process registry/cleanup | cancellation 결과가 모든 child drain 완료 전 success receipt를 쓰지 못하게 한다. | descendant 생존 0. |
| `tools/dev/test-resource-certification.ts` | NEW `ResourceClaim`, `TestResourceCertification`, `loadCertifications`, `certifyTestResource` | source digest와 typed claim을 검증한다. 누락/만료/unknown은 `exclusive` 결과와 reason을 반환한다. | stale digest, undeclared env/port/spawn/repo-write, empty registry, duplicate ID injection이 RED. |
| `tools/dev/test-shard-plan.ts` | `classifyTestResource`, `resourceClassesOverlap`, `chooseIntraWorkerParallelism` | class 하나가 아니라 test claim set을 planner input으로 받는다. 같은 key에서 하나라도 exclusive면 충돌하며 unknown은 전체 충돌한다. | synthetic claim graph의 allowed/denied pair exact matrix. |
| `tools/dev/test-shard-lease.ts` | `acquireTestShardLease` 후속 keyed lease API | `checkout`, `git-common`, `cache`, host resource를 분리하고 복수 key를 정렬 취득한다. 취소/예외 시 역순 해제한다. | lock-order deadlock, fairness, stale owner, cancellation fixture. |
| `tools/dev/run-test-shards.ts` | chunk scheduling/receipt | chunk claim union을 기준으로 eligibility와 lease를 결정하고 certification digest/acquired keys를 receipt에 쓴다. | width 1/2/4 exact verdict; conflicting fixture overlap 0. |
| `tools/dev/test-resource-certification-audit.ts` | `test:resource-certification:audit`, optional `--check` | current full discovery의 integration-path files만 exact source로 읽어 missing/source-drift/certified/intentionally-exclusive와 candidate claims를 JSON으로 출력한다. 자동 registry 수정은 금지한다. | population floor 500; 2026-09-11 working tree에서 558 reached, missing 558, candidate claim 124. |
| `tools/dev/test-shard-lease.ts` | `acquireKeyedTestShardLeases` | scope+resource key를 canonical sort/dedupe하고 전체 wait budget 안에서 순차 취득한다. 부분 실패는 역순 release한다. | 반대 입력 순서, duplicate key, contender wait, release 후 reacquire. |

## 작업 순서

1. A단계 admission type과 fake-clock test를 구현한다.
2. campaign→box-load→runner 순으로 deadline을 관통시킨다.
3. cancellation cleanup 회귀를 통과시킨다.
4. certification schema와 RED fixture를 먼저 구현한다.
5. 558개 inventory를 owner별로 분할해 certified/intentionally-exclusive로 등록한다.
6. TV-07 RSS/child 관측 자료를 모은다.
7. keyed scheduler를 fake workers에서 검증한 뒤 lease를 checkout/git-common/cache/host 순으로 분할한다.
8. 1→2→4 concurrency canary에서 exact verdict와 자원 충돌 0을 확인한 후 활성화한다.

## 검증 계획

fake clock/load로 상위 대기 후 하위 대기 예산이 늘지 않는지 검사한다. deferred일 때 child spawn 0. SIGINT 대기/worker/cleanup 각 단계의 lease와 descendant 정리를 검사한다. resource conflict, unknown, fairness/starvation, memory limit은 작은 fake worker로 검증한다.

## 완료 기준

- [ ] 중복 wait budget 없음.
- [ ] 대기·blocked·실행 실패가 서로 구분됨.
- [ ] 다른 작업의 프로세스를 임의 종료하지 않음.
- [ ] lease 분할은 격리 증거가 있을 때만 별도 완료됨.
- [ ] 정상/취소/실패 모두 lease와 자식 정리 증거 있음.
- [ ] 558개가 certified 또는 intentionally-exclusive이며 미분류 누락 0.
- [ ] certification digest drift가 자동 병렬화가 아니라 exclusive fallback을 만듦.
- [ ] distinct worktree의 pure/test-local 작업은 동시 실행되고 git-common/cache/동일 host resource 충돌은 직렬화됨.
- [x] source digest/claim validator, read-only 558 audit, shared/exclusive compatibility 함수가 fail-closed focused rail을 가짐.
- [x] canonical multi-key exclusive lease primitive가 partial rollback/reacquire focused rail을 가짐. Campaign은 아직 기존 whole lease를 유지한다.

## 실패·복구

resource 분할에서 충돌이 발견되면 해당 class를 exclusive로 복구한다. timeout 확대나 retry-green으로 감추지 않는다.

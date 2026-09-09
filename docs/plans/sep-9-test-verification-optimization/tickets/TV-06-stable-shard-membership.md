# TV-06 — 안정적 청크 구성과 완전성

- 우선순위: P1
- 상태: FOCUSED_VERIFIED
- 소유자: B
- 선행: TV-02, TV-04

## 문제와 근거

현행 planner는 timing 기반 LPT로 매번 파일을 재배치한다. green 이후 timing이 갱신되면 소스가 같아도 chunk membership이 달라져 cache hit가 사라질 수 있다. target=24와 resource별 partition, checkpoint bound가 합쳐져 현재 40개 청크다.

## 구현 범위

1. 자원 class별 안정적인 bucket 함수와 membershipVersion을 도입한다. fixed/rendezvous hash 중 작은 simulation으로 이동량·최대 bucket size를 비교하고 선택한다.
2. timing은 membership이 아닌 실행 순서에만 사용한다.
3. membershipVersion과 bucket count를 고정하고, rebucket은 명시적 version 변경으로만 한다. 새 test 추가가 전체 bucket 수를 자동 바꾸지 않게 한다.
4. bucket skew와 최대 파일 수 초과를 검사한다. 무조건 160→320으로 확대하지 않는다. class별 작은 bucket split을 버전 관리한다.
5. population 전체가 정확히 한 번 배정됐는지 검사하고 sort order를 고정한다.
6. manifest에 class, ordered files, membership digest, policy digest를 포함해 TV-12 worker가 그대로 실행하게 한다.
7. failed 청크의 재실행 범위와 캐시 blast radius를 함께 측정한다.

## 수정 파일

- EXISTING: `tools/dev/test-shard-plan.ts`, `tools/dev/run-test-shards.ts`
- NEW: `tools/dev/test-shard-membership.ts`
- TEST: `tests/unit/test-shard-plan.test.ts`
- NEW TEST: `tests/unit/test-shard-membership.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/test-shard-membership.ts` | NEW `MembershipConfig`, `bucketForFile`, `buildMembershipManifest`, `membershipDigest` | resource class별 고정 bucket count와 version을 입력받아 stable hash로 배정한다. hash 알고리즘 선택은 fixed/rendezvous simulation 결과를 티켓 evidence에 기록한 뒤 고정한다. | 동일 population/다른 timing의 membership equality; add/remove 이동량 fixture. |
| `tools/dev/test-shard-plan.ts` | `lptBins`, `groupWeightedFiles`, `chunkOneGroup`, `planTestChunks` | LPT를 membership 결정에서 제거하고 이미 고정된 bucket들의 launch order만 timing으로 정렬한다. `MAX_CHUNK_FILES` 초과는 silent rebucket이 아니라 명시적 plan error다. | timing 100배 mutation에도 ordered file sets 동일. |
| `tools/dev/test-shard-plan.ts` | `assertTestChunkPlan` | expected population과 actual union의 exact set equality, duplicate, resource class mismatch, empty bucket 규칙을 검사한다. | 누락+중복으로 총 개수가 같은 fixture가 RED. |
| `tools/dev/run-test-shards.ts` | manifest 생성/실행 연결부 | planner가 만든 ordered files/class/membership digest/policy digest를 그대로 실행하고 실행 시 재분할하지 않는다. | manifest와 executed file IDs exact equality. |
| `tests/unit/test-shard-membership.test.ts` | NEW | singleton/empty/skew/rename/add/delete/version bump를 표 형식으로 검증한다. | red-on-injection fixture 포함. |

## 작업 순서

1. 현재 3,906-file snapshot으로 fixed/rendezvous의 skew와 이동량을 비교한다.
2. 알고리즘·bucket count·version을 `MembershipConfig`에 고정한다.
3. exact partition assertion을 먼저 연결한다.
4. planner에서 membership과 scheduling order를 분리한다.
5. cache identity와 TV-12 matrix manifest에 digest를 연결한다.

## 검증 계획

`bun test tests/unit/test-shard-plan.test.ts`

동일 population에서 timing을 100배 변경해도 membership이 같아야 한다. 추가·삭제·rename 후 예상 bucket 외 이동을 검사한다. skewed resource population, singleton, empty, duplicated file, over-cap을 주입한다. partition 누락 1개와 중복 1개를 동시에 넣어 총 개수만 같은 상태도 실패해야 한다.

## 완료 기준

- [ ] timing 갱신이 cache 단위를 움직이지 않음.
- [ ] 정확한 파일 집합 검증, non-empty floor 유지.
- [ ] resource class 혼합이나 한 파일의 중복 실행 없음.
- [ ] rebucket은 명시적 version과 검증 증거를 가짐.

## 실패·복구

특정 bucket이 긴 tail을 만들면 해당 membership version의 증거를 남기고 명시적으로 재분할한다. 자동 LPT 재배치로 몰래 복귀하지 않는다.

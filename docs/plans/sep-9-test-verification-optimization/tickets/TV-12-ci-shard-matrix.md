# TV-12 — 단일 manifest 기반 CI shard matrix

- 우선순위: P1
- 상태: FOCUSED_VERIFIED
- 소유자: CI 담당
- 선행: TV-04, TV-06, TV-11

## 문제와 근거

로컬 프로세스 40개 청크를 CI에서 같은 방식으로 순차 실행하면 독립 runner의 병렬성을 활용하지 못한다. 각 runner가 별도 discovery/LPT를 수행하면 population·membership이 달라질 수 있다.

## 구현 범위

1. planner job이 정확한 SHA에서 전체 manifest, 정책 digest, shard 파일 목록을 한 번 생성한다.
2. worker는 전달받은 chunk만 실행한다. 발견 결과로 재분할하지 않는다.
3. matrix 폭은 초기 4로 제한하고 runner RSS/critical path에 따라 조정한다. 내부 병렬도와 함께 budget으로 계산한다.
4. artifact 이름에 run attempt, SHA, plan digest, chunk ID를 포함한다. 다른 run의 artifact를 glob으로 섞지 않는다.
5. JUnit, executed IDs, scan-reach, policy, exit/cancel, cache provenance를 worker envelope에 저장한다.
6. aggregator는 모든 expected chunk ID와 실제 파일 집합의 정확한 일치를 검사한다. 총 개수 일치만으로 성공하지 않는다.
7. full aggregate를 만든 뒤 unit-speed/scan-reach/preload/pm consumer를 한 번 실행한다.
8. cache 복원은 TV-04/05 identity 검증을 통과한 결과만 사용한다. fork PR cache가 trusted-main 결과 namespace를 임의 갱신하지 않게 한다.
9. cancel/failure 후 artifact 누락을 성공으로 처리하지 않는다. 업로드 실패도 full proof 실패로 남긴다.

## 수정 파일

- NEW: `tools/dev/verification-matrix-plan.ts`, `tools/dev/verification-matrix-worker.ts`, `tools/dev/verification-matrix-aggregate.ts`
- EXISTING: `tools/dev/run-test-shards.ts`에서 planner/worker 재사용 가능한 모듈 경계 추출
- `.github/workflows/ci.yml`
- NEW TEST: `tests/unit/dev/verification-matrix.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/verification-matrix-plan.ts` | NEW `buildMatrixPlan`, CLI `--suite --head --out` | exact HEAD에서 TV-06 manifest를 한 번 생성하고 expected chunk IDs/files/policy/population digests를 canonical JSON으로 쓴다. | 동일 snapshot deterministic digest. |
| `tools/dev/verification-matrix-worker.ts` | NEW `runMatrixChunk`, CLI `--plan --chunk --out-dir` | plan에 적힌 chunk만 실행한다. local discovery/rebalance를 금지하고 worker envelope에 executed IDs, cache hits, JUnit SHA, exit/cancel을 쓴다. | 다른 chunk/file injection reject. |
| `tools/dev/verification-matrix-aggregate.ts` | NEW `aggregateMatrixResults` | expected result 파일을 ID로 exact join하고 SHA/policy/membership/JUnit을 검증한다. selected = executed ∪ cache-hit 및 중복 0을 강제한다. | missing/duplicate/stale/same-count-different-files/corrupt XML fixture. |
| `tools/dev/run-test-shards.ts` | discovery/worker boundary | CLI 내부에 묶인 discovery, plan, execute 기능을 import 가능한 함수로 추출한다. 기존 local full 경로도 동일 함수를 소비한다. | local single-worker와 matrix result set equality. |
| `.github/workflows/ci.yml` | `full-plan`, `full-shard`, `full-aggregate` | planner artifact→matrix(max-parallel=4)→aggregate DAG를 만든다. artifact 이름은 run_id/run_attempt/head/plan/chunk를 포함한다. | cancelled worker와 upload failure가 required 실패. |

## artifact 계약

- Plan: `verification-plan-v1/<headSha>/<planSha>.json`.
- Worker: `verification-worker-v1/<runId>-<attempt>/<headSha>/<planSha>/<chunkId>.json` + JUnit.
- Aggregate: expected/received chunk IDs, exact file sets, outcome counts, all input digests.
- artifact glob만으로 최신 결과를 고르지 않는다. workflow가 전달한 exact 이름만 읽는다.

## 작업 순서

1. plan/worker/aggregate JSON schema와 parser를 고정한다.
2. fake worker로 aggregate failure matrix를 완성한다.
3. existing runner 로직을 모듈 경계로 추출한다.
4. local 1-worker/4-worker small corpus 동등성을 확인한다.
5. TV-11의 단일 full job을 fallback으로 유지한 채 CI matrix를 shadow로 연결한다.

## 검증 계획

fake workers로 한 shard 누락, duplicate ID, 같은 개수의 다른 파일, 다른 SHA, 다른 policy, invalid JUnit, stale artifact, cancelled worker를 각각 주입한다. 모든 경우 aggregator는 실패해야 한다. 동일 plan의 1-worker/4-worker 결과 집합 동등성을 작은 corpus에서 검증한다.

## 완료 기준

- [ ] discovery와 membership authority가 하나.
- [ ] selected files의 executed/cache-hit 합집합이 정확히 일치.
- [ ] required consumers가 aggregate 생성 뒤 한 번만 실행.
- [ ] actual CI artifact와 최종 check가 동일 SHA/plan에 결합됨.

## 실패·복구

matrix 문제가 생기면 TV-11의 단일 full-suite job으로 복귀한다. 부분 결과를 전체 성공으로 표시하지 않는다.

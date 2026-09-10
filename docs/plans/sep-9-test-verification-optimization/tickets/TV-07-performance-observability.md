# TV-07 — 타이밍, 대기, setup 비용을 분리한 관측

- 우선순위: P1
- 상태: IMPLEMENTING — schema v2와 v1 rejection focused green; healthy-load rebaseline은 미완료
- 소유자: B
- 선행: TV-00, TV-04
- 소비자: TV-06 실행 순서, TV-08 admission, TV-90 비교

## 문제와 근거

`test-shard-timings.ts`는 suite time에 청크 wall의 잔여분을 균등 배분한다. 병렬 suite 합이 wall보다 클 수 있고, 최신 단일 측정값이 과거 값을 덮는다. 이를 파일별 실제 wall-time으로 표시하면 비용 분석이 틀린다.

2026-09-11의 `.git/quanta-verification-cache/test-timings-v1.json`은 최신 최적화 전 표본과 chunk overhead가 섞여 있다. 이 store로 계산한 class별 predicted ms는 launch-order weight일 뿐 현재 wall-time이나 다음 최적화 우선순위의 최종 증거가 아니다.

## 구현 범위

1. timing schema를 분리: schedulingWeightMs, observedChunkWallMs, setup/import 추정치, intraParallel, runnerClass, policy digest, load, sample count.
2. queue/lease wait, admission wait, tool install/build, test, cleanup, artifact merge를 각각 monotonic clock으로 기록한다.
3. 실제 측정과 추정 attribution을 명시적으로 구별한다. JUnit suite duration을 CPU time이라고 부르지 않는다.
4. 같은 runner/mode별 최근 bounded N samples의 median과 p95를 저장한다. 과부하 표본은 삭제하지 않고 별도 집단으로 분리한다.
5. failed/cancelled의 elapsed도 저장하지만 통과한 scheduling sample로 덮어쓰지 않는다.
6. JUnit XML 속성 순서에 의존하지 않는 parser를 사용한다. nested suite time의 중복 합산 여부를 검증한다.
7. cache lookup의 miss reason을 schema/tree/policy/membership/expired/corrupt로 구분한다.
8. 사용자 로그는 시작, 실패, 요약 중심으로 하며 새 출력 relay가 worker를 막지 않도록 기존 fd 기반 전달을 유지한다.
9. v1 store는 v2로 암묵 승격하지 않는다. schema miss로 분리하고 current HEAD healthy-host 표본으로 다시 채운다.
10. `workerStartupMs`, `moduleLoadMs`, `caseMs`, `cleanupMs`, `chunkOverheadMs`를 분리한다. 잔여 chunk wall을 임의의 한 파일 비용으로 귀속하지 않는다.

## 수정 파일

- EXISTING: `tools/dev/test-shard-timings.ts`, `tools/dev/verification-campaign-receipt.ts`, `tools/dev/run-test-shards.ts`
- NEW: `tools/dev/verification-metrics.ts`, `tests/unit/dev/verification-metrics.test.ts`
- EXISTING TEST: `tests/unit/test-shard-plan.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/verification-metrics.ts` | NEW `PhaseTiming`, `VerificationSample`, `summarizeSamples` | queue/lease/admission/setup/run/cleanup/artifact 구간을 monotonic timestamp pair로 기록한다. unknown duration은 `null`, 추정치는 `estimated=true`로 보존한다. | 구간 중복·음수·벽시계 초과 합산을 reject한다. |
| `tools/dev/test-shard-timings.ts` | `TEST_TIMING_SCHEMA`, `loadTestTimings`, `mergeTestTimings` | schema v2에 runnerClass/policy/sampleCount/outcome/load를 추가하고 bounded raw samples에서 median/p95를 계산한다. failed/cancelled는 pass scheduling estimator와 분리한다. | 50배 outlier, 다른 runner/policy, stale sample fixture. |
| `tools/dev/test-shard-timings.ts` | `SUITE_LINE`, `harvestChunkTimings` | 속성 순서 의존 regex를 없애고 testsuite tag의 속성을 이름으로 parse한다. nested suite 중복과 file 없는 module suite를 명시적으로 처리한다. | `file/time` 순서 반전, nested, malformed XML test. |
| `tools/dev/run-test-shards.ts` | chunk lifecycle | chunk start/end, child spawn, JUnit persist, cache lookup miss reason을 sample에 기록한다. stdout relay는 기존 fd 흐름을 유지한다. | fake clock으로 phase 합과 verdict independence 검증. |
| `tools/dev/verification-campaign-receipt.ts` | receipt phase summary | lease/admission/tool setup과 test wall을 분리하고 표본 수 없는 p95를 출력하지 않는다. | JSON schema snapshot. |
| `.git/quanta-verification-cache/test-timings-v1.json` | local mutable v1 store | 증거 파일로 커밋하지 않는다. v2 loader가 이를 current scheduling proof로 승격하지 않고 명시적 legacy/miss로 처리한다. | v1 fixture를 읽어도 v2 p95가 생성되지 않음. |

## 작업 순서

1. metrics schema와 fake monotonic clock unit test를 만든다.
2. JUnit parser 회귀를 고정한 뒤 timing store를 v2로 전환한다.
3. runner/campaign phase instrumentation을 연결한다.
4. cache miss reason과 sample cohort를 출력한다.
5. TV-90 전에는 수집만 하고 단일 표본을 성능 결론으로 사용하지 않는다.
6. healthy host에서 cold/warm ABBA를 수집하고 queue/setup/run/cleanup cohort를 분리한다.

## 검증 계획

JUnit time/file 속성 역순, nested suite, module-only 파일, sum(suite)>wall, missing duration, failed sample, 50배 outlier, 다른 runner sample 혼입을 fixture로 검증한다. elapsed 구성 항목은 중복 계상하지 않으며 unknown을 0으로 위장하지 않는다.

## 완료 기준

- [ ] 추정 23.7분 같은 숫자가 실측 wall로 출력되지 않음.
- [ ] cache·대기·setup·실행·cleanup이 따로 보임.
- [ ] sample 수 없는 p95 또는 한 번의 실행으로 속도 향상을 주장하지 않음.
- [ ] timing 변경이 TV-06 membership을 바꾸지 않음.
- [x] v1 stale 표본이 current-HEAD hot-file 순위를 결정하지 않음.
- [ ] healthy-load current-HEAD raw samples와 sample count가 영구 evidence에 고정됨.

## 실패·복구

telemetry 쓰기 실패는 테스트 verdict를 성공으로 바꾸지 않는다. timing store가 깨지면 보수적인 scheduling 기본값을 쓰고 missing을 보고한다.

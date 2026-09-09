# TV-00 — 기준 증거와 전체 population 고정

- 우선순위: P0
- 상태: FOCUSED_VERIFIED
- 소유자: 통합 담당
- 선행: 없음
- 산출물: baseline 요약, population inventory, known-failure register

## 문제와 근거

가변 cache의 시간 합이 정상 실행 wall-time으로 해석됐고, full 파일 수와 README의 과거 수치도 다르다. 최신 캠페인은 41분 34초 후 취소됐으며 chunk 16 실패가 남았다. 완료시간·실행량·추정치를 구별한 기준이 필요하다.

## 구현 범위

1. 시작 HEAD/base, clean 여부, Bun revision, OS/CPU/RAM, 당시 load를 읽기 전용으로 고정한다.
2. 기존 full discovery 함수로 목록을 산출한다. raw find 결과 대신 실제 runner의 포함/제외 규칙을 쓴다.
3. full 밖의 contract, PTY, web, smoke, eval을 별도 population으로 기록한다. 3,906은 full 기준이며 전체 제품 검증 파일 수가 아니다.
4. 가변 campaign/JUnit/timing 자료의 필요한 요약을 plan의 `evidence/` (NEW)에 기록한다. 원본 해시·수집 시각·출처·coverage를 포함하고 환경 비밀값은 복사하지 않는다.
5. chunk 16의 token 전달 실패는 unresolved로 등록한다. 근본 원인, 신규 변경과의 관계, owner-local reproducer가 확보되기 전 flake 또는 해결로 표시하지 않는다.
6. 실제 활성 remote required checks/merge queue는 TV-15의 읽기 전용 preflight로 확인한다.

## 대상

- 읽기: `tools/dev/run-test-shards.ts`, `sandboxed-test.ts`, `test-shard-timings.ts`
- 읽기: `.git/quanta-verification-cache/last-campaign.json`, `.cache/full-junit.xml.shard-16.xml`
- 문서: 이 패킷의 README 및 `../evidence/` (NEW)

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 변경 또는 수집 로직 | 산출물/검증 |
|---|---|---|---|
| `tools/dev/run-test-shards.ts` | `SUITE_ROOTS`, `SUITE_FLOORS`, discovery/manifest 생성부 | runner가 실제로 선택한 정렬된 파일 목록과 제외 사유를 JSON으로 내보내는 read-only 경로를 추가한다. glob 재구현은 금지한다. | 동일 HEAD에서 2회 실행한 manifest SHA와 파일 순서가 동일해야 한다. |
| `tools/dev/test-shard-plan.ts` | `planTestChunks`, `assertTestChunkPlan` | baseline에서 chunk 수, resource class, scheduling weight를 추출한다. weight를 실행시간으로 이름 바꾸지 않는다. | 전체 파일이 정확히 한 번 배정됐음을 검증한다. |
| `tools/dev/test-shard-timings.ts` | `loadTestTimings`, `harvestChunkTimings` | timing store의 schema, age, 표본 수, source receipt를 함께 기록한다. | stale/누락 timing은 `estimated`로 표시한다. |
| `tools/dev/verification-campaign.ts` | `CAMPAIGN_RECEIPT`, `recordCampaign` | 마지막 캠페인의 상태·HEAD·manifest·중단 시각을 비밀값 없이 snapshot한다. | cancelled/failed를 passed로 요약하지 않는다. |
| `docs/plans/sep-9-test-verification-optimization/evidence/` | NEW `baseline-<sha>.json`, `known-failures.md` | machine-readable inventory와 사람이 읽는 failure register를 분리한다. | 각 파일에 source path, capturedAt, source SHA256을 포함한다. |

## 작업 순서

1. `git rev-parse HEAD`, `git status --porcelain=v1`, Bun/OS/CPU/RAM만 수집한다.
2. runner의 discovery-only 경로로 suite별 population을 고정한다.
3. 기존 campaign/JUnit/timing 파일은 복사 전에 SHA256을 계산하고 상태를 판독한다.
4. chunk 16은 `unresolved`로 등록하고 reproducer가 생길 때까지 분류를 바꾸지 않는다.
5. 모든 후속 티켓이 참조할 baseline SHA와 population digest를 README에 연결한다.

## 검증 계획

- inventory의 정렬·unique 여부와 runner partition의 합집합을 대조한다.
- 증거 파일의 SHA, source timestamp, 스냅샷을 교차 확인한다.
- 테스트 실행 없이 조사 가능한 항목부터 완료한다. 정상 부하 benchmark는 TV-90까지 보류한다.
- baseline 통계에 sample 수·추정치 여부·failed/cancelled 상태가 빠지면 반려한다.

## 완료 기준

- [x] 기준 population과 out-of-band population이 서로 구분됨.
- [x] 실행 비용과 scheduling weight가 다른 필드로 기록됨.
- [x] 기존 실패가 누락 없이 남아 있음.
- [x] full 테스트를 재시작하지 않고 수집 가능한 기준 증거가 기록됨.

## 실패·복구

원본 cache가 이미 덮였으면 재구성한 값을 관측값으로 쓰지 않는다. available/missing을 표시하고 과거 대화 수치는 historical로 남긴다.

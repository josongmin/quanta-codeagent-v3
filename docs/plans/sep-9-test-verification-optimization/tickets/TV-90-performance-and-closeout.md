# TV-90 — 성능·정확성 검증과 최종 종결

- 우선순위: P1
- 상태: IMPLEMENTING
- 소유자: 통합 담당
- 선행: TV-00–15의 해당 구현·활성화 단계
- 실행 제약: 현재 full 중단 요청 유지. benchmark/full 재개는 후속 실행 요청 또는 확인된 CI 실행 범위에서만 수행한다.

## 목적

빠른 명령이 실제로 빨라졌는지와 전체 검증의 판정이 유지되는지를 각각 증명한다. 이번 패킷 작성은 이 티켓의 실행 완료가 아니다.

## 검증 실행 순서

1. 각 owner의 focused 회귀 결과와 변경 파일을 검토하고 immutable HEAD로 통합한다.
2. TV-00 known-failure register의 chunk 16 실패를 재현·분류한다. unresolved 상태라면 전체 green 또는 모든 작업 완료를 주장하지 않는다.
3. 새 tier별 selection dry-run으로 population·이유·fallback을 확인한다.
4. 정상 부하 전용 runner에서 baseline/candidate를 비교한다. scheduling/cache policy 비교는 같은 source HEAD, 다른 policy digest로 실행하고 각 결과를 구분한다.
5. 코드 변경 전후 비교는 production/test source가 같은지 명시한다. 동일 source가 아니면 speedup 전부를 runner 개선으로 귀속하지 않는다.
6. cold test-result-cache, warm same-input, 단일 source 변경, test 추가, fixture 변경, global config 변경을 각각 측정한다.
7. 짧은 대표 corpus에서 ABBA 최소 2 cycle로 변동성을 먼저 본다. p95 목표 검증은 충분한 실제 lane 표본을 수집한 뒤 보고한다.
8. full은 매 수정마다 반복하지 않고 승인된 통합 SHA에서 하나의 authoritative campaign으로 수렴한다.
9. 원격 CI/merge/runtime 지원 증거는 별도 단계로 기록한다. 유료 EC2/LLM이나 native Windows 등의 기존 proof gap을 로컬 mock green으로 닫지 않는다.

## 측정 지표

- smoke/prepush/PR/nightly의 cold·warm wall, queue/setup/run/cleanup
- 최초 실패까지 시간, superseded-run 낭비 시간
- cache hit/miss와 원인, selected/executed/cached/not-selected/skip counts
- runner별 CPU/RSS, peak child count, retry/flake, worker 비용
- 전체 manifest equality, artifact 누락/변조 탐지 결과
- selection shadow에서 full 실패를 놓친 사례와 fail-wide 비율

## 목표와 판정

| 항목 | 초기 수용 기준 |
|---|---|
| smoke | warm p95 ≤60초; cold ≤120초; 필수 skip 0 |
| prepush | 일반 변경 warm p95 ≤180초 / cold ≤300초; broad fallback은 별도 보고 |
| PR | 전용 runner required critical path p95 ≤12분; 초기 full coverage 유지 |
| nightly | 45분 목표, 60분 예산; 초과/누락은 incomplete/fail |
| 캐시 | 동일 입력 재사용, 관찰 입력 변경 시 miss; corruption은 miss/실패 |
| 선택 | synthetic mutation 누락 0, 실제 shadow false-skip 0; 표본 구성 함께 보고 |
| 전체 검증 | baseline 3,906의 정당한 추가·삭제를 반영한 현재 집합 정확히 충족 |

80% hit 같은 숫자는 opt-in 표본에서의 관측 목표로만 보고한다. global-input 변경에 높은 hit율을 요구하지 않는다. 목표 미달 시 원인을 티켓으로 남기고 timeout/skip/coverage를 조정해 숫자를 맞추지 않는다.

## 최종 실행 명령 (PROPOSED — 구현 후에만 유효)

- `bun run verify:smoke`
- `bun run verify:prepush`
- `bun run verify:pr` — CI 정책에 맞는 실행 환경에서
- `bun run verify:full --cache=off` — 재개가 허용된 전용 실행에서
- `bun run verify:nightly` — 지정된 capability/예산 환경에서

현재 존재하는 focused 회귀 명령은 각 티켓에 별도로 기록했다. 위 신규 명령의 존재만으로 실행 성공을 주장하지 않는다.

## 증거 파일과 판정 로직

| 산출물 | 필수 필드 | 판정 |
|---|---|---|
| `evidence/closeout-snapshot.json` | base/head/status, Bun/OS/arch/runner, policy/population/membership digests | dirty/local/CI/merge snapshot을 혼합하면 실패. |
| `evidence/selection-shadow.json` | change stratum, selected/not-selected/fallback, full failures, false-skip | false-skip 1건이면 해당 selector 승격 금지. |
| `evidence/performance-samples.json` | phase별 raw samples, order A/B/B/A, cache mode, load/RSS/child count | 같은 source/policy cohort가 아니면 speedup 귀속 금지. |
| `evidence/full-receipt.json` | expected/executed/cache-hit/not-selected/failed/cancelled exact IDs | expected set equality가 아니면 full PASS 금지. |
| `evidence/remote-activation.json` | repo/branch/PR HEAD, workflow run IDs, required contexts, ruleset digest | workflow green만 있고 ruleset 확인이 없으면 ACTIVE_VERIFIED 금지. |
| `evidence/open-gaps.md` | owner, impact, reproducer, next action, external dependency | unresolved chunk 16/유료·native proof를 누락하면 closeout 실패. |

## 종결 작업 순서

1. 각 티켓의 상태와 변경 파일, focused command/result를 수집한다.
2. immutable integration HEAD에서 selection dry-run과 manifest equality를 확인한다.
3. 정상 부하 runner에서 smoke/prepush ABBA를 먼저 실행한다.
4. 허용된 경우에만 cache-off authoritative full 1회를 실행한다.
5. CI exact-head와 remote required/ruleset을 재조회한다.
6. baseline 대비 성능, coverage, failure를 같은 cohort만 비교한다.
7. 미달/미확인 항목은 새 owner ticket으로 분리하고 현재 티켓을 `CLOSED_WITH_GAPS`로 위장하지 않는다.
8. child/lease 0, docs/catalog parity를 확인한 뒤에만 CLOSED로 전환한다.

## 완료 기준

- [ ] 모든 티켓이 코드·focused·통합·활성화 상태를 각각 기록.
- [ ] 동일 범위 before/after 성능 자료와 표본 수 존재.
- [ ] known failure가 해결되거나 명시적 미완료로 남음.
- [ ] partial/skip/cached 범위를 포함한 정직한 full receipt 존재.
- [ ] 실제 required checks와 해당 SHA 확인.
- [ ] 문서·catalog·명령·workflow parity 일치.
- [ ] 자식 프로세스와 lease 잔존 0.
- [ ] 남은 외부 proof와 비용 발생 작업을 명시.

## 실패·복구

cache 결함은 해당 scope off, selection 결함은 full fallback, matrix 결함은 단일 runner로 복구한다. 전체 실행이 허용되지 않거나 외부 환경이 없으면 해당 검증 상태를 미완료로 유지한다. 문서 패킷 작성 완료와 이 구현 목표 달성을 구별한다.

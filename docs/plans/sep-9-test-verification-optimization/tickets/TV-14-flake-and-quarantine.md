# TV-14 — 최초 실패 보존과 quarantine lifecycle

- 우선순위: P2
- 상태: PLANNED
- 소유자: 테스트 운영 담당
- 선행: TV-02, TV-11

## 문제와 근거

`tools/test-resilience/quarantine.json`과 CLI는 존재하지만 full gate와의 결과 계약이 별도다. retry 성공을 최초 실패 대신 사용하면 실제 결함과 환경 문제를 숨길 수 있다. 현재 chunk 16 실패는 flake로 증명되지 않았다.

## 구현 범위

1. failure kind를 assertion, timeout, setup/capability, infrastructure, cancelled로 나눈다. 분류 불명확은 unknown으로 남긴다.
2. 첫 실패의 SHA, test ID, stack/fingerprint, runner/policy, seed, elapsed, artifact를 보존한다.
3. 진단용 retry를 허용해도 첫 required verdict는 자동 green으로 바꾸지 않는다.
4. quarantine 등록은 owner, issue, 최초 관측 SHA, fingerprint, 재현 근거, 만료일, 영향 범위를 필수로 둔다.
5. 초기 expiry는 14일 이내 정책으로 제안한다. 만료·owner 누락·unknown ID는 정책 검사에서 실패한다.
6. quarantine test는 별도 nightly에서 계속 실행하며 excluded population을 명확히 표시한다. all-tests-passed 표현에 포함하지 않는다.
7. 보안·권한·데이터 유실 등 핵심 회귀는 quarantine으로 merge 보호를 우회하지 않는다.
8. 해제 증거는 표준 실행 폭에서 연속 통과 기록과 원인 수정이다. 예: 20회 통과는 보조 기준이며 결함 부재의 수학적 보장이 아니다.
9. 기존 1개 ledger entry의 실제 상태부터 검증하고 새 JSON authority를 중복 생성하지 않는다.

## 수정 파일

- `tools/test-resilience/cli.ts`, `tools/test-resilience/quarantine.json`, 관련 기존 parser
- TV-02 policy와 TV-11 aggregator의 quarantine 소비부
- `tests/unit/tools/test-resilience-quarantine-ratchet.test.ts`
- NEW: 작은 result classification 통합 테스트

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/test-resilience/cli.ts` | `runBunTest`, `classifyInIsolation`, `cmdRun`, `cmdQuarantineCheck` | 첫 실행 결과를 immutable `FirstFailure`로 보존하고 진단 retry를 별도 attempt로 추가한다. retry pass는 verdict를 green으로 바꾸지 않는다. | fail→pass, fail→fail, timeout, cancel fixture. |
| `tools/test-resilience/quarantine.json` | existing authority | entry에 test ID/name, owner, issue, firstSeenSha, fingerprint, resourceClass, expiresAt, scope를 요구한다. 기존 `maxCount` ratchet은 올리지 않는다. | expired/unknown/duplicate/missing owner/critical test 거부. |
| `tools/dev/verification-result.ts` | failure classification/quarantine summary | assertion/timeout/setup/infrastructure/cancelled/unknown을 tagged union으로 집계하고 quarantined failures를 required passed count와 분리한다. | unknown을 flake로 자동 변환하지 않음. |
| `tools/dev/test-policy.ts` | quarantine eligibility/critical flag | security/permission/data-loss critical IDs는 quarantine 불가로 선언한다. | critical registration injection RED. |
| `tests/unit/tools/test-resilience-quarantine-ratchet.test.ts` | ledger parser/ratchet | ledger population floor, expiry, exact test existence와 red-on-injection을 유지한다. | 현재 1개 entry와 `maxCount: 1`을 기준으로 감소만 허용. |

## 작업 순서

1. 현재 ledger 1개가 실제 test ID와 일치하는지 확인한다.
2. `FirstFailure`/attempt/result schema와 fingerprint normalization을 구현한다.
3. CLI retry가 최초 verdict를 보존하도록 바꾼다.
4. ledger validation과 critical deny-list를 연결한다.
5. nightly quarantine lane을 TV-13에 연결하고 expiry owner에게 실패를 전달한다.

## 검증 계획

`bun test tests/unit/tools/test-resilience-quarantine-ratchet.test.ts`

first-fail/retry-pass, expired entry, mismatched fingerprint, unknown test ID, critical test 등록 시도, quarantined failure의 별도 집계를 fixture로 검증한다. 결과에 최초 실패가 계속 남아야 한다.

## 완료 기준

- [ ] retry로 실패가 지워지지 않음.
- [ ] 모든 제외에 owner·issue·expiry 존재.
- [ ] quarantine도 정기 실행됨.
- [ ] known failure를 근거 없이 flaky로 이동하지 않음.

## 실패·복구

quarantine 정책/집계 문제가 생기면 정상 required 실행으로 복귀한다. 불완전한 결과는 partial/failed로 표시한다.

# TV-01 — tier 명령, 로컬 hook, fail-fast

- 우선순위: P0
- 상태: FOCUSED_VERIFIED
- 소유자: A / 공통 파일은 통합 담당
- 선행: TV-00, contracts.md
- 활성화 선행: TV-03 및 TV-15의 원격 보호 확인

## 문제와 근거

`package.json`의 test:ci가 prepush를 호출하고, prepush는 static 10개와 runtime 11개를 묶는다. `gate.ts`는 기본적으로 실패 뒤에도 후속 gate를 실행한다. hook만 --bail을 넘기는 현재 UX는 호출 경로마다 다르다.

## 구현 범위

1. 기존 gate ID·command를 재사용해 smoke/prepush/pr/full/nightly membership을 표현한다. 기존 precommit의 staged mechanical 역할은 보존한다.
2. `verify:smoke`는 `tests/unit/smoke-battery.test.ts`와 고정 critical canary, 변경 lint를 실행한다. 전체 typecheck를 매 smoke에 의무화하지 않고 prepush/PR에서 수행한다.
3. `verify:prepush`는 static → TV-03 selection → runtime canaries를 실행한다. 기본 fail-fast, 명시적 --keep-going만 독립 gate를 계속한다.
4. failed producer의 consumer는 skipped-input으로 기록한다. static failure 후 toolchain 설치를 시작하지 않는다.
5. `verify:full`로 기존 전체 경로를 보존한다. test:ci는 CI tier에 연결하고 로컬 prepush로 재귀하지 않게 한다.
6. 새 명령이 구현된 뒤 TV-15에서 hook과 prepush alias를 원자적으로 전환한다. 기본 smoke만으로 full 통과를 표시하지 않는다.
7. local dirty smoke, immutable push snapshot, clean full 각각의 receipt 종류를 구분한다.
8. SIGINT는 child tree 정리 후 cancelled/130을 반환한다. wrapper와 hook의 --bail 인자 전달을 실제 fake-child 경로에서 검증한다.

## 수정 파일

- EXISTING: `package.json`, `.githooks/pre-push`, `tools/dev/gate-manifest.ts`, `tools/dev/gate.ts`, `tools/dev/verification-campaign.ts`
- NEW: `tools/dev/verification-result.ts`, tier policy 관련 sibling 모듈
- EXISTING TEST: `tests/unit/_arch/gate-manifest-workflow-parity.test.ts`, `tests/unit/dev/verification-campaign.test.ts`
- NEW TEST: `tests/unit/dev/verification-tier-runner.test.ts`

## 파일·심볼별 작업

| 파일 | 심볼/영역 | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `tools/dev/gate-manifest.ts` | `GateStage`, `Gate`, `GATES`, `gatesForStage` | `VerificationTier`와 tier membership을 명시한다. 기존 gate ID/command는 복제하지 않고 한 gate가 어느 tier에 속하는지 선언한다. producer/consumer 의존성은 기존 `produces`/`consumes` 계약을 유지한다. | unknown tier, 중복 gate ID, consumer-before-producer, tier별 최소 population을 unit test한다. |
| `tools/dev/gate.ts` | argv parsing, `planned`, 실행 loop, `failedIds`, `poisoned`, `skipped` | `--keep-going`을 명시적 opt-in으로 추가하고 prepush 기본값은 fail-fast로 둔다. producer 실패 시 dependent gate를 `skipped-input`, 아직 시작하지 않은 독립 gate를 `not_run`으로 receipt에 남긴다. | fake `runGate` adapter로 첫 실패 뒤 heavy spawn 0회와 keep-going 동작을 검증한다. |
| `tools/dev/verification-result.ts` | NEW `VerificationResult`, `GateResult`, `finalizeVerificationResult` | passed/failed/cancelled/skipped-input/not-selected/not-run을 서로 다른 상태로 정의하고 exit code를 한 곳에서 결정한다. | 모든 상태 조합 truth table; missing result는 success 금지. |
| `tools/dev/verification-campaign.ts` | command launch, `terminate`, `recordCampaign` | tier/result metadata를 campaign receipt에 전달하고 SIGINT/SIGTERM에서 child tree 종료 후 130/143을 보존한다. | fake child가 signal 후 살아 있지 않은지 확인한다. |
| `package.json` | scripts | `verify:smoke`, `verify:prepush`, `verify:full`을 추가하되 `test:ci` 전환은 TV-11 barrier 이후 별도 커밋으로 한다. | 각 script가 존재하고 자기 자신을 재귀 호출하지 않는 정적 test. |
| `.githooks/pre-push` | gate invocation | TV-15 R2에서만 `verify:prepush`로 전환하고 실제 push SHA를 인자로 전달한다. | failing fake runner의 exit code와 args 보존. |

## 작업 순서

1. result type과 tier manifest를 먼저 추가한다.
2. `gate.ts`를 adapter 주입 가능한 orchestration 함수로 추출하고 CLI는 얇게 유지한다.
3. focused unit test를 RED→GREEN으로 만든 뒤 package alias를 추가한다.
4. hook과 `test:ci` 변경은 TV-03/11/15 activation barrier까지 보류한다.

## 검증 계획

기존 focused 명령:
`bun test tests/unit/dev/verification-campaign.test.ts tests/unit/_arch/gate-manifest-workflow-parity.test.ts`

새 fake-runner 테스트: 첫 gate 실패 → 뒤 heavy child 시작 0회; producer 실패 → consumer 실행 0회; keep-going → 독립 gate만 실행; unknown tier → 오류; strict smoke skip → 실패; cancellation → 생존 child 0. 신규 테스트는 작성 후 파일 단위로 실행한다.

## 완료 기준

- [ ] 모든 명령의 실행 population과 성공 의미가 문서·코드에 일치.
- [ ] default prepush가 full을 암묵 실행하지 않음.
- [ ] fallback full-required는 명시적 상태로 전달.
- [ ] 인자 전달·취소·실패 전파의 실제 wrapper 회귀 테스트 통과.
- [ ] hook 활성화는 TV-15 barrier 후 기록.

## 실패·복구

새 빠른 tier가 불완전하면 hook 전환을 보류하거나 이전 hook으로 복구한다. 실패를 --no-verify 또는 exit 0으로 숨기지 않는다.

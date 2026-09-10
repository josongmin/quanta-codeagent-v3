# TV-11 — CI 독립 job과 안정적인 required 집계

- 우선순위: P0
- 상태: IMPLEMENTING — local DAG/parity focused green; hosted execution과 required activation blocked
- 소유자: CI 담당 / workflow는 단일 작성자
- 선행: TV-01
- 원격 활성화: TV-15

## 문제와 근거

`.github/workflows/ci.yml`의 pyramid는 static/full/parity/PTY/web/toolchain을 한 job에서 순차 실행한다. workflow에 PR superseded-run cancellation이나 명시적 job timeout이 없다. fc-gate check 이름은 보호 규칙이 참조할 수 있다.

2026-09-11 현재 `static-code`, `catalog`, `full-suite`, `pty`, `web`, `toolchain`, `contract`, `required` job과 legacy `pyramid`가 tree에 존재한다. 최신 scheduled CI는 각 job이 0 steps로 실패했고, private repository의 branch-protection/ruleset read는 HTTP 403이다. 따라서 코드/parity 상태와 hosted/required 상태를 동일한 완료로 표시하지 않는다.

## 구현 범위

1. static-code, catalog, full-suite, pty, web, toolchain, contract, required로 분리한다.
2. 1차에서는 full-suite runner를 그대로 유지한다. JUnit/scan-reach 소비자는 producer와 같은 job에 둔다.
3. lint와 lint-debt도 같은 job의 producer/consumer 순서를 유지한다.
4. required aggregator는 항상 실행해 계획에서 요구한 needs 결과를 확인한다. failure/cancel/missing을 success로 만들지 않는다.
5. conditional lane의 not-selected는 selection plan이 명시적으로 승인한 경우만 허용한다. GitHub skipped와 정책상 미선택을 동일 취급하지 않는다.
6. PR 번호+workflow 기준 concurrency로 이전 SHA를 취소한다. main/merge-group/nightly의 정책은 별도다.
7. runner·Bun 버전을 고정하고 dependency setup cache를 lockfile/OS/arch에 결합한다. latest 런타임 비교는 별도 lane이다.
8. job timeout은 measured baseline과 cleanup 예산을 반영한다. workflow concurrency와 각 worker의 내부 병렬도가 곱해져 oversubscribe되지 않게 한다.
9. old required context를 유지하면서 새 집계를 추가한다. 보호 규칙 이동은 TV-15의 별도 상태다.
10. private 유지 시 branch protection을 제공하는 repository plan을 확보한다. public 전환은 별도 사용자 결정이며 기본 해결책으로 간주하지 않는다.
11. Actions 0-step 원인을 계정/결제 설정에서 해소한 뒤 exact local HEAD를 origin에 게시하고 실제 PR check names를 다시 수집한다.

## 수정 파일

- `.github/workflows/ci.yml`, `.github/workflows/fc-gate.yml`
- `tools/dev/gate-manifest.ts` 및 workflow parity 계약
- NEW: `tools/dev/verification-result.ts`의 CI 집계 소비부
- TEST: `tests/unit/_arch/gate-manifest-workflow-parity.test.ts`
- NEW TEST: `tests/unit/dev/ci-required-results.test.ts`

## 파일·job별 작업

| 파일 | 심볼/job | 구현 로직 | 회귀 rail |
|---|---|---|---|
| `.github/workflows/ci.yml` | `pyramid` 분해 | 1차 job ID를 `static-code`, `catalog`, `full-suite`, `pty`, `web`, `toolchain`, `contract`, `required`로 고정한다. setup은 각 job에 명시하고 full/JUnit 소비자는 같은 job에 둔다. | workflow parser가 expected job IDs와 needs DAG를 exact 비교. |
| `.github/workflows/ci.yml` | top-level `concurrency` | PR은 workflow+PR 번호로 group하고 `cancel-in-progress: true`; push/main/schedule은 서로 오염되지 않는 key를 쓴다. | event별 rendered group fixture. |
| `.github/workflows/ci.yml` | job `timeout-minutes` | TV-00/07 baseline+cleanup budget으로 각 job에 명시한다. timeout 숫자는 tests 내부 deadline 확대 근거로 사용하지 않는다. | 모든 required job에 timeout 존재 검사. |
| `tools/dev/verification-result.ts` | CI result aggregation | GitHub의 `success/failure/cancelled/skipped`와 정책상의 `not-selected`를 별도 입력으로 받고 expected job 누락을 failure로 판정한다. | all-success/failure/cancel/missing/unexpected-skip truth table. |
| `tools/dev/gate-manifest.ts` | `GATING_WORKFLOWS`, `REQUIRED_GATE_IDS` | workflow command와 gate authority의 parity를 새 job 구조에 맞춘다. 명령 문자열 복제 대신 stable gate ID를 비교한다. | `gate-manifest-workflow-parity` non-vacuity floor 유지. |
| `.github/workflows/fc-gate.yml` | `fc-gate` | 원격 보호가 참조할 기존 check name을 R3까지 유지하고 새 required와 병행한다. | old/new context가 한 PR에서 모두 관측될 때만 전환. |

## 작업 순서

1. 현재 `pyramid` step을 producer/consumer 묶음으로 inventory한다.
2. required result evaluator와 truth-table test를 먼저 만든다.
3. workflow job을 분해하되 full command와 범위는 바꾸지 않는다.
4. parity test와 local YAML parse를 통과시킨다.
5. TV-15 R3에서 실제 PR SHA의 check 이름/결과를 확인한 뒤 원격 required를 전환한다.
6. `required`와 legacy `pyramid`를 전환 기간 함께 관측하고, 동일 SHA에서 두 context가 모두 정상 생성된 뒤 legacy를 제거한다.

## 검증 계획

고정 needs-result truth table로 all-success, one-failure, cancelled, missing, allowed-not-selected, unexpected-skip을 검증한다. workflow parser/기존 parity test로 gate 누락을 확인한다. 실제 PR 실행의 job IDs, SHA, required 상태는 TV-15에서 읽어 확인한다.

## 완료 기준

- [ ] 독립 job이 실제 동시 실행 가능.
- [ ] required 결과가 누락/skip을 green으로 오인하지 않음.
- [ ] 기존 full 검증 범위 보존.
- [ ] obsolete PR 실행 취소와 cleanup 확인.
- [ ] workflow 파일 수정과 원격 required 활성화 상태를 별도 기록.
- [ ] Actions job이 0-step이 아닌 실제 setup/test steps를 실행한 exact-HEAD run ID 존재.
- [ ] branch protection/ruleset readback에 required context와 enforcement 대상 branch가 기록됨.

## 실패·복구

새 집계가 불완전하면 old required context를 유지한다. continue-on-error로 required failures를 숨기지 않는다.

# T-101 — cheap validation accept

## 목표

`staticAccept()`를 blind accept에서 cheap validation accept로 바꾼다.

현재 `staticAccept()`는 low-risk cand0에서 `applyClean`, `regressionGreen`, `smokeGreen`,
`patchedResolvedKofN`를 모두 `null`로 둔다. 이 티켓은 최소 `applyClean`을 항상 확인하고,
이미 준비된 cheap ports가 있으면 `declaredExpected`, issue smoke, discovered regression도 반영한다.

## 범위

주 파일:

- `src/runner/batch/eval/selection-executor.ts`

보조 테스트:

- `tests/unit/selection-executor.test.ts`
- 필요 시 `tests/unit/verify-select-driver-parity.test.ts`

## 구현

- `staticAccept()`가 `scoreOne(candidate, size, size)` 또는 동등한 shared probe path를 사용하게 만든다.
- empty patch는 기존 hard gate와 동일하게 `patchProduced=false`.
- `applyClean=false`면 low-risk라도 winner가 되지 않는다.
- `declaredExpected=false`는 기존 `applyDeclaredExpectedHardGate()` 권한을 유지한다.
- `regression`/`smoke` port가 없으면 `null` fail-open을 유지한다.
- `verify-select-repro=off` arm에서는 resolved K-of-N을 추가로 켜지 않는다.

## 비목표

- cand1 생성 정책 변경 없음.
- LLM gate default-on 없음.
- 전역 patch-budget hard reject 없음.

## Hellgate

- low-risk cand0 + non-empty patch + applyClean=true -> cand0 winner.
- low-risk cand0 + applyClean=false -> cand0 winner 금지.
- low-risk cand0 + declaredExpected=false -> cand0 winner 금지.
- regression/smoke port 미가용 -> fail-open, 기존 low-cost 동작 유지.
- `verify-select-repro=off`에서 repro consensus 호출 없음.

## 완료 기준

- changed unit tests green.
- low-risk path telemetry가 `staticAccept`와 validation 결과를 구분해서 남긴다.


# T-201 — cand0 risk facts contract

## 목표

cand0 패치를 구조 분석해 cand1 seed와 selector가 공유할 stable fact set을 만든다.

이 fact set은 heuristic verdict가 아니라 deterministic evidence다.

## 범위

주 파일:

- `src/runner/batch/eval/strict-risk-gate.ts`
- `src/runner/batch/eval/selection-risk-gate.ts`
- `src/runner/batch/eval/selection-executor.ts`
- 필요 시 신규 `src/runner/batch/eval/counterfactual-risk.ts`

기존 소스:

- `src/agent/patch-budget/index.ts`

## Fact set

`CandidateRiskFacts`:

- `touchedSourceFiles`
- `ownerFiles`
- `filesOutsideOwner`
- `newFiles`
- `newDefs`
- `runtimeExpandingCalls`
- `emptyPatch`
- `declaredExpectedMatch`
- `applyClean`
- `structuralReasons`
- `llmShadowReasons` optional, telemetry only

## 구현

- `evaluateStrictPatchRisk()`가 이미 갖고 있는 `PatchBudgetVerdict`를 버리지 않고 downstream으로 전달한다.
- risk decision telemetry와 counterfactual seed generation이 같은 fact object를 보게 한다.
- cand0 cheap validation 결과를 fact set에 합친다.
- reason string parsing에 의존하지 않는다. seed builder는 typed facts를 사용한다.

## 비목표

- semantic correctness 판정 없음.
- repo-specific rule 추가 없음.
- seaborn/django 같은 instance-specific trigger 금지.

## Hellgate

- multi-file cand0 -> `touchedSourceFiles.length > 1` fact 생성.
- added helper cand0 -> `newDefs > 0` fact 생성.
- runtime-expanding call cand0 -> `runtimeExpandingCalls > 0` fact 생성.
- empty patch -> `emptyPatch=true`.
- reason string 문구를 바꿔도 seed builder test가 깨지지 않음.

## 완료 기준

- strict-risk-gate 기존 테스트 유지.
- new fact contract tests 추가.
- telemetry에 fact summary가 machine-readable로 남음.


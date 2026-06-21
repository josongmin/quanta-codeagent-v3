# T-301 — counterfactual contract in selector

## 목표

selector가 counterfactual candidate의 자기 계약 위반을 강하게 내리게 만든다.

전역 patch-budget hard reject가 아니다. 큰 패치가 정말 필요한 문제는 살아야 한다. 다만
counterfactual seed를 받은 후보가 그 seed의 구조 계약을 어기면 cand0 대비 우위를 잃어야 한다.

## 범위

주 파일:

- `src/runner/batch/eval/selection-executor.ts`
- `src/agent/verification-bundle/score.ts`
- 필요 시 신규 `src/runner/batch/eval/counterfactual-contract.ts`

## 구현

- `Candidate` 또는 sidecar map에 `counterfactualContract`를 붙인다.
- 계약 종류:
  - `singleOwnerFile`
  - `noNewDefs`
  - `noNewFiles`
  - `noRuntimeExpansion`
  - `nonEmptyPatch`
- candidate patch를 `analyzePatchBudget()`으로 다시 분석한다.
- contract violation은 일반 후보 hard gate가 아니라 counterfactual-specific negative signal로 둔다.
- 정책:
  - empty patch, applyClean=false, regression=false, smoke=false, declaredExpected=false는 기존 hard reject.
  - counterfactual contract violation은 hard reject 또는 large penalty 중 하나로 시작하되, 전역 후보에는 적용하지 않는다.
  - 시작값은 "constrained fallback에서 제외"가 가장 안전하다.

## 비목표

- patch-budget global discard 없음.
- score weight tuning 없음.
- benchmark-specific solved count 최적화 없음.

## Hellgate

- cand1이 `singleOwnerFile` 계약을 받고 2 source files를 touch -> cand1이 cand0를 이길 수 없음.
- cand1이 `noNewDefs` 계약을 받고 helper를 추가 -> cand1이 cand0를 이길 수 없음.
- cand1이 계약을 지키고 applyClean/regression/smoke/declaredExpected green -> cand1이 cand0보다 선택 가능.
- cand0 large-but-valid patch는 전역 hard reject되지 않음.

## 완료 기준

- selector tests에 cand0/cand1 counterfactual ranking fixtures 추가.
- telemetry가 contract pass/fail을 candidate별로 남김.


# T-202 — counterfactual candidate seed

## 목표

cand1+ seed를 owner-focus 한 줄에서 counterfactual minimal retry prompt로 바꾼다.

현재 seed:

```
Focus your investigation on `<file>`. Confirm the ROOT CAUSE lives there ...
```

목표 seed:

```
Candidate 0 was rejected/expanded for structural reasons:
- touched 2 source files
- added 1 new def

Produce a counterfactual minimal alternative:
- edit only `<owner-file>` unless the issue text proves otherwise
- no new helper/class/method
- preserve existing control flow
- avoid runtime-expanding calls
- prefer in-place guard/change
```

## 범위

주 파일:

- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/driver.ts`
- 필요 시 신규 `src/runner/batch/eval/counterfactual-seed.ts`

## 구현

- `buildSelectionInputs()`는 기존 owner seed builder 역할을 유지하되, cand0 risk facts를 받을 수 있는 별도 path를 추가한다.
- cand0 생성 전에는 기존 seeds를 만든다.
- cand0 risk/validation 후 cand1 seed를 재작성하거나 `generate(i, seed)` 호출 직전에 counterfactual seed를 계산한다.
- seed는 bounded text다. diff 전문을 다시 넣지 않는다.
- owner file은 closure-ranked owner list에서 고른다.
- cand0가 multi-file이면 cand1은 single-owner-file alternative를 요구한다.
- cand0가 new def/helper를 추가했으면 cand1은 no-new-def/in-place edit을 요구한다.
- cand0가 runtime-expanding call을 추가했으면 cand1은 no-runtime-expansion/preserve-control-flow를 요구한다.
- cand0가 empty patch면 cand1은 owner file에서 concrete source edit을 요구한다.

## 비목표

- cand0 patch 자체를 LLM에게 긴 diff로 재주입하지 않는다.
- candidate mutation/edit-rewrite engine을 만들지 않는다.
- LLM semantic gate default-on 없음.

## Hellgate

- cand0 multi-file -> cand1 seed에 single owner file contract 포함.
- cand0 new-def -> cand1 seed에 no new defs contract 포함.
- cand0 runtime-expanding -> cand1 seed에 no runtime expansion contract 포함.
- cand0 empty patch -> cand1 seed에 concrete source edit contract 포함.
- low-risk cand0가 validation 통과하면 cand1 seed 생성/agent rerun 없음.

## 완료 기준

- `agentless-v3-thin-strict-gated` 기존 동작은 새 preset 전까지 byte-identical 또는 명시적으로 분리.
- counterfactual preset에서만 새 seed path 활성화.


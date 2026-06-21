# T-401 — presets and telemetry

## 목표

counterfactual-select를 별도 실험 arm으로 노출하고 gated-5 중심으로 측정한다.

## 범위

주 파일:

- `src/runner/knobs/presets.ts`
- `src/config/knob-inventory.ts`
- `src/runner/batch/eval/knobs-bench.ts`
- `tests/unit/bench-knob-discoverability-hellgate.test.ts`
- `tests/unit/bench-preset-drives-config-hellgate.test.ts`
- `tests/unit/runner/knobs/parsers-hellgate.test.ts`

## Presets

추가:

- `agentless-v3-thin-strict-counterfactual-shadow`
- `agentless-v3-thin-strict-counterfactual`

후보 설정:

```yaml
base: agentless-v3-thin-strict-gated
verify-select: 2
verify-select-risk-gate: 1
verify-select-regression: discovered
verify-select-repro: off
verify-select-counterfactual: 1
verify-select-llm-risk-gate: shadow # shadow arm only
```

## Telemetry

필수 fields:

- `riskGate.expanded`
- `riskGate.reasons`
- `riskGate.facts`
- `riskGate.shadow`
- `counterfactual.enabled`
- `counterfactual.seedKind`
- `counterfactual.contracts`
- `counterfactual.contractPass`
- `candidateWinner`
- `cand1WinsOverCand0`
- `lowRiskValidatedAccept`
- `lowRiskValidationRejectReason`

## 측정

gated-5 우선:

- baseline: `agentless-v3-thin-strict-gated`
- treatment: `agentless-v3-thin-strict-counterfactual`
- shadow: `agentless-v3-thin-strict-counterfactual-shadow`

지표:

- resolved delta
- turns delta
- cand1 generated count
- cand1 win-rate
- multi-file/new-def/runtime-expanding reduction
- false expansion rate
- low-risk validation reject rate
- LLM shadow trigger precision

## Hellgate

- preset name discoverability.
- env override precedence 유지.
- default arm 변경 없음.
- `shadow` arm에서 LLM decision은 submit authority 없음.
- `counterfactual` off일 때 기존 gated behavior 유지.

## 완료 기준

- knob/preset tests green.
- one-command local dry run command가 README 또는 runbook에 남음.


# T-501 — optional critic late

## 목표

critic/reranker는 N=3~5 이상으로 확장할 때만 붙인다.

현재 N=2의 병목은 critic 부재가 아니라 cand1 품질이다. 따라서 이 티켓은 선행 티켓들이 측정으로
cand1 win-rate를 만든 뒤에만 시작한다.

## 전제 조건

- T-101 완료.
- T-201 완료.
- T-202 완료.
- T-301 완료.
- T-401 gated-5 측정 완료.

## 범위

후보:

- existing `verify-select` N-best flow
- optional LLM/critic selector
- telemetry-only shadow mode first

## 구현 방향

- N=3~5 complete trajectories를 생성한다.
- hard validation은 critic보다 먼저 적용한다.
- critic은 admissible candidates 사이의 tie-break/rerank만 맡는다.
- critic은 correctness authority가 아니다.
- critic decision은 shadow -> on 순서로 승격한다.

## 비목표

- round-0에 critic 추가 금지.
- low-risk cand0에 critic 비용 추가 금지.
- LLM gate와 critic을 동시에 default-on 금지.

## 승격 기준

- counterfactual N=2 대비 resolved delta가 포화.
- N 증가로 cand diversity가 실제로 증가.
- critic shadow가 selector miss를 안정적으로 잡음.
- added turns/cost 대비 resolved delta가 양수.

## Hellgate

- hard rejected candidate는 critic이 되살릴 수 없음.
- critic shadow와 live selection 결과를 분리 기록.
- N=2 preset에서는 critic 호출 없음.

## 완료 기준

- critic arm은 별도 preset으로만 노출.
- 기본 `agentless-v3-thin-strict-counterfactual`에는 critic 없음.


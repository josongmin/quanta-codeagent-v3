# ADR-0085: Cost & cache dashboard

- **상태**: Accepted
- **날짜**: 2026-05-22
- **관련**: ADR-0074(OTel span tree), `observability/metrics.ts`(Metrics registry), `observability/pricing.ts`(costUsd), `agent/metrics.ts`(AgentRecorder METRIC keys), ADR-0081(shell.exec.* counters).

## 맥락

세션의 token in/out·cache hit·$·latency 데이터는 이미 `Metrics` registry에 다 쌓이고 있었다 (AgentRecorder가 turns/tool_calls/stop_reason/gen_ai.usage.* counter + llm_stream/tool_exec timer를 채움; ADR-0081 shell observer가 shell.exec.* 추가). 그런데 그걸 사람이 읽을 cost/cache 요약으로 보여주는 surface가 없었다 — `slog.info("metrics.snapshot")`로 structured log만 나갔다.

## 결정

신규 **순수 aggregator** `src/observability/cost-dashboard.ts`:

- `buildCostDashboard(snapshot, {model?}): CostDashboard` — MetricsSnapshot에서 토큰/cacheHitRate/cost/turns/toolCalls(byTool)/stopReasons/latency(p50/p95)/shell rollup 집계. **새 데이터 수집 0** — 기존 counter/timer만 읽음.
- `cacheHitRate = cacheRead / (input + cacheRead)`, input 0이면 `null`(미정의 비율).
- `estimatedCostUsd`: model 알 때만 `costUsd()`, 모르면 `null`(silent $0 금지).
- 3 renderer: `renderDashboardText`(터미널 블록), `renderDashboardMarkdown`(PR 코멘트 테이블), 객체 자체가 JSON.
- CLI wire: `metrics` 활성 시 turn 종료마다 `renderDashboardText`를 stderr로 (structured log는 그대로 유지).

## 근거

- **데이터 이미 있음 → ROI 최고**: 수집 인프라(Recorder/Metrics/pricing)는 완성돼 있었고 표현만 없었음. aggregator + renderer만으로 즉시 가치.
- **순수 함수**: snapshot in → dashboard out, IO·clock 0 → 결정론 테스트. CLI는 snapshot을 떠서 넘기기만.
- **cost null-safe**: unknown model은 `null` (pricing 테이블 미등록). 가짜 $0 안 보여줌.
- **canonical key 재사용**: `GEN_AI_ATTRS.usage.*`(AgentRecorder와 동일) — surface가 private namespace 안 만듦.

## 대안

- **status-line에 인라인**: 기각 — status-line은 한 줄, 대시보드는 멀티라인 블록. 별도.
- **별도 수집 패스**: 기각 — 데이터 이미 Metrics에 있음. 중복.
- **항상 출력**: 기각 — `metrics` opt-in일 때만 (byte-identical default-OFF).

## 결과·트레이드오프

- **얻은 것**: turn별 cost/cache/latency 가시화 (CLI stderr) + markdown(PR) + JSON. 11 unit green.
- **비용**: `metrics` 활성 시 turn당 stderr 1블록 (structured log는 유지). 비활성 시 0 변화.

## 한계 (LIMITATIONS)

- (a) cost는 `pricing.ts` 테이블 의존 — unknown model `null`.
- (b) cacheHitRate는 input+cacheRead 기준 — provider별 cache 회계 차이 미반영.
- (c) 세션 누적만 — per-turn delta 분해는 follow-up (snapshot은 누적값).

## 불변식 영향

- **byte-identical default**: `metrics` 미설정 시 dashboard 미호출.
- **순수 aggregator**: 새 수집 0, 기존 counter/timer만 read.
- **신규 npm dep 0**.

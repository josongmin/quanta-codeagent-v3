# ADR-0065: workMetrics — turn별 비용·작업 투명성 (v0.dev 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0032(OTel attr 빌더), ADR-0054(context-usage-metrics), `observability/pricing.ts`, `v0-dev-feature-review.md` §A급-13(workMetrics).

## 맥락

v0.dev는 매 turn `workMetrics { diffMap: {file:{addedLines,removedLines}}, agentActions, linesRead, imageGenerationCost, creditCost, usage }`를 서버 response로 받아 "몇 줄 읽고 / 몇 액션 / 얼마"를 UI에 노출한다. v3는 token 카운터는 있으나 diffMap·linesRead·action 단위 집계 + turn별 cost 노출이 없었다.

## 결정

신규 순수 모듈 `src/observability/work-metrics.ts` + L3 wire 모듈 `src/agent/work-metrics-collector.ts`:

- `FileDiffStat { file, addedLines, removedLines }`, `WorkMetrics { diffMap, agentActions, linesRead, tokensInput, tokensOutput, cacheReadTokens?, estimatedCostUsd? }`.
- `parseNumstat(stdout)` (binary `-` → 0, 공백 경로, 잘못된 행 skip).
- `summarizeWorkMetrics(m)` — compact 1-block(예: `3 files (+42 -7) · 5 actions · 312 lines read · 1.2k in / 0.8k out · ~$0.03`).
- `accumulateWorkMetrics(base, delta)` — 순수 fold.
- `buildWorkMetrics(...)` — `pricing.ts`로 cost(unknown model ⇒ undefined).
- `QUANTA_ATTRS.work.*` namespace(filesChanged/linesAdded/linesRemoved/actions/linesRead/costUsd) + `workMetricsAttrs(m)`.
- L3 wire: `TurnWorkMetricsCollector` (5 record methods + finalize). loop이 turn 시작 시 (sink 있을 때만) 인스턴스화, 매 tool-call/usage 시 collector?.recordX(...) 호출, turn 종료 시 sink.emit(metrics, {turnId}).
- `AgentConfig.workMetricsSink?` opt-in.

## 근거

- **비용·작업 투명성**: 에이전트 작업의 "얼마나/얼마"를 사용자가 turn 단위로 보면 신뢰·통제 향상. token만으로는 부족 — diff 규모·읽은 줄·액션 수가 직관적 척도.
- **순수 집계**: 파싱/요약/fold 전부 IO·clock 0 — 결정론 테스트.
- **OTel flat 제약**: per-file diff를 scalar 합계(filesChanged/linesAdded/...)로 집계 후 emit; 상세 diffMap은 trajectory에 별도.
- **`estimatedCostUsd?: number | undefined`**: `exactOptionalPropertyTypes` 하에서 "비용 미상" 상태 명시 표현.
- **슬라이스 격리**: collector를 `@/agent`에 둠 — `@/observability`는 `@/agent` import 금지지만 역방향은 OK. `@/observability/work-metrics`만 import.

## 대안

- **token 카운터만**: 기각 — 작업량 직관 부족.
- **diffMap을 OTel attr 통째로**: 기각 — flat 제약 위반.

## 결과·트레이드오프

- **얻은 것**: turn/session 작업·비용 집계 + 요약 + attr seam + loop emit. 13 + 24 unit + 232 loop-regression all green. loop runAgent 복잡도 36 유지(helper 추출).
- **비용**: AgentConfig +1 field (workMetricsSink?).

## 한계 (LIMITATIONS)

- (a) loop이 numstat 직접 spawn은 미수행 — 기존 git_diff 결과를 식별해 numstat-스타일 입력 만드는 follow-up 필요(현재 `recordDiff`는 호출 가능하지만 caller가 numstat-shape stdout 공급).
- (b) `imageGenerationCost`(v0 fal.ai)는 미흡수 — v3에 image 생성 없음.

## 불변식 영향

- **byte-identical default**: `workMetricsSink` 미설정 시 collector 미인스턴스화·emit 0.
- **vocabulary 추가만**(`QUANTA_ATTRS.work.*` 신규).
- **신규 npm dep 0**.

# ADR-0182: Prompt cache observability

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0138 (budget-ledger — sibling primitive; this round adds cache-specific observability via type-only bridge), ADR-0144 (metrics — used as MetricSink for gauge/counter emit)
- **참조**: `src/observability/prompt-cache/{types,default,default-pricing,budget-bridge,index}.ts`, `src/tool/prompt_cache_status.ts`, `tests/unit/prompt-cache-observability-hellgate.test.ts`, `tests/unit/prompt-cache-tracker-hellgate.test.ts`

## 맥락

Anthropic Messages API는 prompt caching을 1급으로 지원한다 — `cache_control: {type:"ephemeral"}` 으로 prefix 마킹, usage event에 `cache_creation_input_tokens` + `cache_read_input_tokens` surface. cache hit은 input 단가의 10% (90% 할인).

ADR-0138 budget-ledger는 이미 두 토큰 종류를 모두 누적 + pricing 적용한다. 그러나 cache 자체의 **운영 가시성**(hit rate / 절감액 / breakpoint별 효과)이 ledger 표면에 직접 없다 — caller가 raw 토큰 카운트로부터 추정해야 함. Claude Code의 `/cost`도 raw 토큰만 surface한다. operational dashboard / alerting을 위해 typed observable이 필요.

## 결정

신규 plane-clean 슬라이스 `src/observability/prompt-cache/`:

```ts
interface CacheHitEvent {
  model, sessionId, turnIndex, atMs,
  inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens
}

interface PromptCacheObserver {
  record(event: CacheHitEvent): void
  attributeBreakpoint(name: string, tokenSpan: number, wasHit: boolean): void
  snapshot(): CachePerformanceSnapshot   // perModel / perSession / breakpoints
  reset(): void
}

const defaultPromptCacheObserver: (opts?) => PromptCacheObserver
const wirePromptCacheToBudget: (obs, ledger) => () => void   // deregister fn
```

### 핵심 공식 (snapshot 시점에 평가)

- **Hit rate** = `cache_read / (input + cache_create)` — "input rate로 청구될 토큰 중 cache hit 비율". denominator 0 → 0 (NaN 회피).
- **Cost savings** = `cache_read × (inputPerM - cacheReadPerM) / 1e6` (USD). 음수 가드 (오설정 pricing이 negative savings 못 만들게).

### MetricSink 통합 (ADR-0144 sink)

`record(event)` 시 4 metric 호출:
- `prompt_cache.input_tokens` (counter)
- `prompt_cache.cache_read_tokens` (counter)
- `prompt_cache.cache_write_tokens` (counter)
- `prompt_cache.hit_rate` (gauge)

Labels: `{model, session}`. Sink throw 시 record는 정상 return (no-throw 계약).

### Default pricing table (`default-pricing.ts`)

Extracted from `default.ts` into a sibling file so the observer slice carries
its own first-class pricing primitive (mirrors the budget-ledger sibling
without coupling at the module-graph layer):

| model              | input  | output | cache_create   | cache_read    |
|--------------------|--------|--------|----------------|---------------|
| claude-opus-4-7    | $15.00 | $75.00 | $18.75 (1.25×) | $1.50 (0.10×) |
| claude-sonnet-4-6  |  $3.00 | $15.00 |  $3.75 (1.25×) | $0.30 (0.10×) |
| claude-haiku-4-5   |  $1.00 |  $5.00 |  $1.25 (1.25×) | $0.10 (0.10×) |

Fallback: unknown model → `claude-sonnet-4-6` rates with a one-shot `logger.warn`
(safe-LOUD; mirrors ADR-0138 clause #4). `outputPerM` is carried for completeness
(future per-model cost-breakdown tool may read it) — today only `inputPerM` and
`cacheReadPerM` are consumed by the hit-rate / savings math.

### Tool surface (`prompt_cache_status`)

`src/tool/prompt_cache_status.ts` exposes the observer to the agent as a
read-only, concurrency-safe Tool. Two factories:

- `promptCacheStatusTool(observer)` — composition root constructs with the
  wired `PromptCacheObserver`. Renders a formatted text report (lifetime
  header + per-session list sorted by savings + per-breakpoint section +
  formula footnote). Optional `sessionId` narrows to one session; optional
  `topN` (default 10) caps the per-session list.
- `promptCacheStatusUnwiredTool()` — symmetrical placeholder when no observer
  is attached; yields `ok:false` with typed `failure: { mode: "rejected",
  reason: "observer_not_attached" }`. Lets composition roots register the
  tool surface unconditionally if desired (otherwise: omit when unwired).

Caller-wired (NOT in `buildDefaultTools`) — sessions that never construct
either factory see byte-identical behavior. The tool DOES NOT compute
"actual cost" from raw token counts (the per-model pricing lives in the
observer's closure, not on the snapshot); the operator pairs this tool with
`/cost` (ADR-0138 budget-ledger) for the dual axis.

### budget-bridge (type-only coupling)

`wirePromptCacheToBudget(observer, ledger)`이 observer.record를 wrap해서 매번 `ledger.record(toUsageEvent(event))`도 호출. **observer 자체는 ledger를 import 안 함** — module graph 안 결합. 슬라이스의 plane-cleanness 유지.

Deregister 반환 함수로 wiring 끊을 수 있음. Validation-error parity: observer가 `negative-tokens` throw하면 ledger도 호출 안 됨 (atomicity).

## Default-OFF

`metricsSink` absent → snapshot-only (call site는 직접 `observer.snapshot()` query). `wirePromptCacheToBudget` 미호출 → ledger 독립. Observer 자체를 인스턴스화 안 하면 budget-ledger만으로 기존 토큰 회계 동작 byte-identical.

## Hellgate (24 observer + 20 tracker/tool = 44 cases total)

### Observer-internal battery (`prompt-cache-observability-hellgate.test.ts`, 24 cases)

- **A. record + snapshot 8**: 단일/다중 event / 다중 model / hitRate denom=0 / cost savings Sonnet 1M cache_read → ~$2.70 / perSession aggregation / 음수 토큰 throw / 알 수 없는 model fallback
- **B. attributeBreakpoint 4**: 단일 hit / 다중 breakpoint / tokenSpan 누적 / 빈 상태 OMITTED (exactOptional)
- **C. MetricSink integration 4**: 4-metric emit / labels {model, session} / sink throw no-throw / sink 부재시 무해
- **D. LRU cap 2**: ring drops oldest + aggregates 보존 / reset() 전체 clear
- **E. budget-bridge 5**: wire + record → ledger.record / no wire → ledger 0 / deregister → 이후 0 / negative-tokens parity / sink 부재시도 wire 작동
- **F. determinism 2**: 같은 input → 같은 snapshot / clock injection이 sample.at에 사용

### Tracker + tool surface battery (`prompt-cache-tracker-hellgate.test.ts`, 20 cases)

- **A. record + metrics math 8**: regular-only / cache_read-only / mixed / multi-event monotonic / multi-session isolation / unknown model fallback / zero-token / 1 B-token overflow guard
- **B. Sink integration 3**: sink absent / sink wired emits 4 / sink throws → no-throw collapse
- **C. LRU + reset 2**: maxEvents=10 + 15 events → aggregates monotonic / reset() rebuilds from zero
- **D. Tool surface 6 (16+sub)**: metadata (read-only, concurrency-safe) on both factories / execute lifetime header + savings line + breakpoint section + footnote / sessionId drill-down / missing-session helpful note / unwired branch typed rejection / pre-aborted signal → typed rejected

44 pass / 0 fail. 164 expects.

## Alternatives rejected

1. **budget-ledger snapshot에서 직접 읽기** — breakpoint attribution 손실. 별도 observer가 더 풍부.
2. **Per-tool cache attribution** — 너무 세분화. cache_control 단위(breakpoint)가 자연스러운 단위.
3. **Auto breakpoint detection** — 너무 추측적. caller가 declare하는 게 audit-friendly.
4. **Hit rate as %** — ratio가 더 composable. UI에서 format.
5. **Observer가 직접 ledger import** — module-graph 결합 → plane-cleanness 위반. bridge에서 type-only coupling.
6. **Per-event 영구 저장** — LRU ring (default 1000)이면 충분; 영속성은 metric sink 책임.

## SOTA++ 자리매김

| Agent | Hit rate | Cost savings | Breakpoint attribution |
|---|---|---|---|
| Claude Code 2.1 | partial (raw tokens) | partial (/cost summary) | ❌ |
| Cursor | proprietary (UI 노출) | proprietary | ❌ |
| OpenAI Playground | basic | ✅ | ❌ |
| **quanta** | ✅ typed port | ✅ pricing-aware | ✅ named breakpoints |

= "Anthropic ephemeral cache의 *운영-grade observability* (hit-rate / savings / breakpoint attribution)를 typed-port + MetricSink-bridge + budget-bridge로 hexagonal 분리. cache_control 단위가 1급 type."

## Follow-up

- **Prompt cache strategy advisor**: snapshot 데이터로 cache_control 위치 추천 (예: "system-prefix 보다 rules가 hit rate 낮음 → break 점 이동")
- **Per-skill cache attribution**: skill 호출 시점에 breakpoint span 자동 집계
- **Cross-session warm-cache analysis**: TTL window 안 다른 session에서 caching benefit 추정
- **alarm wiring**: hit rate가 threshold 아래로 떨어지면 metric sink 통해 alert
- **Cost-anomaly alert**: 10 연속 turn에서 `cache_creation > 30% × input` 감지 시 metric sink 통해 alert (Anthropic misconfig 시그널)
- **Auto-call after each turn**: 의도적 NON-GOAL — 에이전트가 호출 시점을 결정 (operator-visible 운영 도구이지 turn-internal 텔레메트리가 아님)
- **`outputPerM` consumer**: 향후 per-model 전체 cost 브레이크다운 도구가 `default-pricing.ts`의 `outputPerM`을 읽을 수 있음 (오늘은 hit-rate / savings만 사용)

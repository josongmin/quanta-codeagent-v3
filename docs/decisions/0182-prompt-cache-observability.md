# ADR-0182: Prompt cache observability

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0138 (budget-ledger — sibling primitive; this round adds cache-specific observability via type-only bridge), ADR-0144 (metrics — used as MetricSink for gauge/counter emit)
- **참조**: `src/observability/prompt-cache/{port,default,budget-bridge,index}.ts`, `tests/unit/prompt-cache-observability-hellgate.test.ts`

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

### budget-bridge (type-only coupling)

`wirePromptCacheToBudget(observer, ledger)`이 observer.record를 wrap해서 매번 `ledger.record(toUsageEvent(event))`도 호출. **observer 자체는 ledger를 import 안 함** — module graph 안 결합. 슬라이스의 plane-cleanness 유지.

Deregister 반환 함수로 wiring 끊을 수 있음. Validation-error parity: observer가 `negative-tokens` throw하면 ledger도 호출 안 됨 (atomicity).

## Default-OFF

`metricsSink` absent → snapshot-only (call site는 직접 `observer.snapshot()` query). `wirePromptCacheToBudget` 미호출 → ledger 독립. Observer 자체를 인스턴스화 안 하면 budget-ledger만으로 기존 토큰 회계 동작 byte-identical.

## Hellgate (24 cases)

- **A. record + snapshot 8**: 단일/다중 event / 다중 model / hitRate denom=0 / cost savings Sonnet 1M cache_read → ~$2.70 / perSession aggregation / 음수 토큰 throw / 알 수 없는 model fallback
- **B. attributeBreakpoint 4**: 단일 hit / 다중 breakpoint / tokenSpan 누적 / 빈 상태 OMITTED (exactOptional)
- **C. MetricSink integration 4**: 4-metric emit / labels {model, session} / sink throw no-throw / sink 부재시 무해
- **D. LRU cap 2**: ring drops oldest + aggregates 보존 / reset() 전체 clear
- **E. budget-bridge 5**: wire + record → ledger.record / no wire → ledger 0 / deregister → 이후 0 / negative-tokens parity / sink 부재시도 wire 작동
- **F. determinism 2**: 같은 input → 같은 snapshot / clock injection이 sample.at에 사용

24 pass / 0 fail.

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

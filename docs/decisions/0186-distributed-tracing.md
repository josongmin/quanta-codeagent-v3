# ADR-0186: Distributed tracing — typed `Tracer` port + OTel SDK adapter + W3C propagator

- **상태**: Accepted (no-op default + OTel adapter)
- **날짜**: 2026-05-25
- **관련**: ADR-0144 (observability-metrics — sibling primitive, same default-OFF + plane-clean discipline + sub-barrel posture), ADR-0154 (otel-sink — sibling OTel adapter on the metrics surface)
- **SOTA 출처**: W3C Trace Context (https://www.w3.org/TR/trace-context/) — canonical wire format for `traceparent` / `tracestate` across process boundaries (every modern collector speaks it: Jaeger, Tempo, Honeycomb, Datadog, X-Ray); OpenTelemetry SDK (`@opentelemetry/api` + `@opentelemetry/sdk-trace-base`) — canonical in-process API for span trees; Codex Desktop OTel breakdown is per-model only (no in-process span tree query); Claude Code 2.1 + Cursor 3.2 emit IDE-side activity logs but no programmatic span tree + no W3C `traceparent` propagation
- **참조**: `src/observability/tracing/port.ts`, `src/observability/tracing/noop-tracer.ts`, `src/observability/tracing/otel-tracer.ts`, `src/observability/tracing/w3c-propagator.ts`, `src/observability/tracing/index.ts`, `tests/unit/observability-tracing-hellgate.test.ts`

## 맥락

ADR-0144 의 metrics primitive 가 counter / histogram / gauge 를 봉인했지만 — metrics 는 **causality 를 모른다**:

- "지난 turn 이 왜 30s 걸렸지?" → metric 은 `turn_duration_ms = 30000` 만 안다
- "어느 tool 호출이 8s 였지?" → metric 은 모름 (tool 별 histogram 을 추가하면 합계는 알지만 순서/포함관계는 모름)
- "subagent 가 누가 누구를 spawn 했지?" → metric 으론 영영 모름 (parent/child 트리는 wire 가 다르다)

distributed tracing 이 정확히 이 격차를 메운다: 모든 operation = span, span 은 parent/child 트리로 nest, W3C `traceparent` 헤더로 process 경계 너머까지 propagation. `agent run took 30s` 가 `10s LLM stream + 15s bash + 5s verify-guard` 로 자동 분해된다.

다른 modern agent:
- **Claude Code 2.1** — IDE-side activity log (UI only, no programmatic span tree, no W3C propagation)
- **Cursor 3.2** — IDE inspector (same — UI-bound, in-process logs only)
- **Codex Desktop** — per-model OTel breakdown (export only — no in-process tracer API, no parent/child wiring for tool calls)
- **v0.dev** — none

= "typed `Tracer` port + OTel SDK adapter + W3C propagator 가 한 슬라이스에 모인 첫 구현. metrics 의 sibling 으로서 같은 default-OFF + plane-clean + sub-barrel 디시플린."

## 결정

신규 plane-clean 디렉토리 `src/observability/tracing/`:

```ts
// port.ts
type SpanKind = "internal" | "server" | "client" | "producer" | "consumer"
type SpanStatusCode = "unset" | "ok" | "error"

interface SpanContext {
  readonly traceId: string         // 32-hex lowercase (128 bits)
  readonly spanId: string          // 16-hex lowercase (64 bits)
  readonly traceFlags: number      // bit 0 = sampled
}

interface SpanAttributes {
  readonly [key: string]: string | number | boolean   // closed primitive set
}

interface Span {
  readonly context: SpanContext
  setAttribute(key: string, value: string | number | boolean): void
  setStatus(code: SpanStatusCode, message?: string): void
  recordException(error: Error): void
  end(endTime?: number): void   // idempotent
}

interface Tracer {
  startSpan(name: string, opts?: {
    readonly kind?: SpanKind
    readonly parent?: SpanContext | Span
    readonly attributes?: SpanAttributes
    readonly startTime?: number
  }): Span
  withSpan<T>(name: string, fn: (span: Span) => Promise<T>, opts?: ...): Promise<T>
}

interface TraceContextPropagator {
  inject(ctx: SpanContext, carrier: Record<string, string>): void   // → traceparent
  extract(carrier: Record<string, string>): SpanContext | null      // null on malformed
}
```

2 built-in adapters + 1 propagator:
- `noopTracer` — default. Produces well-shaped Spans (32/16-hex IDs from `crypto.getRandomValues`) but every method is a deliberate no-op. Byte-identical "no tracing wired" cost.
- `otelTracer({tracerProvider?, tracerName?, tracerVersion?})` — caller-built `TracerProvider` (or fall back to OTel global API). Adapts our Span ↔ OTel Span via a private `WeakMap`; lifts parent contexts through `trace.setSpan(context.active(), parent)`. EVERY OTel API call wrapped in try/catch and swallowed (observability sinks must never break the recorder). Provider failure collapses to `noopTracer.startSpan` so the caller's code path is unaffected.
- `w3cTraceContextPropagator` — strict W3C version "00" emitter + parser. Validates segment count, hex shape, ID widths, all-zero rejection per spec. No-throw on malformed.

## 계약 (5)

1. **NO-THROW EVERYWHERE**. Observability primitives must never crash callers. `Span.setAttribute / setStatus / recordException / end`, `Tracer.startSpan / withSpan`, and `Propagator.inject / extract` all swallow internal failures. A misbehaving OTel exporter collapses to a no-op span; a hostile traceparent header returns `null`.
2. **PURE PORT**. The port (`./port.ts`) has zero runtime imports. Adapters live in sibling files. Surfaces depend on the port via `@/observability/tracing` and never reach into `./otel-tracer` directly.
3. **DEFAULT-OFF + SUB-BARREL POSTURE** (mirrors ADR-0144). The parent `@/observability` barrel intentionally does NOT re-export `tracing/*`. Surfaces opt in by importing `@/observability/tracing` explicitly. The sub-barrel's default export is `noopTracer`.
4. **CALLER-OWNED OTEL LIFECYCLE**. `otelTracer` never auto-instantiates a `TracerProvider` — caller passes one in (or omits it to use the OTel global API). Exporter, sampler, resource attrs, shutdown — all stay with the caller. Same posture `otelMetricsSink` (ADR-0144 follow-up).
5. **W3C STRICT-MODE PARSER**. Unsupported version (`!= "00"`), wrong segment count, wrong ID width, non-hex chars, and all-zero IDs all return `null`. We choose strict over permissive: clear `null` lets the caller decide between "start a new root trace" vs "fail loudly" instead of inheriting half-corrupted parent state.

## Default-OFF posture

이 슬라이스를 **자동으로 wire 하는 곳 없음**. `apps/agent` bootstrap, `dispatch.ts`, `subagent` fork — 어디서도 자동으로 `otelTracer({...})` 호출하지 않는다. surface 가 opt-in:

```ts
import { otelTracer } from "@/observability/tracing"
const tracer = otelTracer({ tracerProvider: myOtelSdkProvider })
// then pass `tracer` into any caller that takes `Tracer`
```

부재 시 caller 가 `defaultTracer` (= `noopTracer`) 를 사용해도 0 cost: spans 는 IDs 만 생성되고 어디로도 export 되지 않는다.

## Hellgate (21 cases)

`tests/unit/observability-tracing-hellgate.test.ts` 가 4 section 으로 봉인 (21/21 pass, 58 expects):

- **A. noop tracer (5)**: 32/16-hex 모양 valid context / setAttribute·setStatus·recordException·end 모두 no-throw / withSpan resolve · reject propagate / 50 parallel spans → unique IDs
- **B. otelTracer with fake provider (8)**: startSpan delegate / parent SpanContext 전달 → same traceId / attributes 전달 / setStatus("error", msg) → OTel ERROR + message / recordException → OTel addEvent("exception") side-effect / end(epochMs) 전달 + idempotence / provider throws → noop collapse + still usable / `mapKind` 5-arm exhaustive 매핑
- **C. W3C propagator (5)**: inject `00-<32hex>-<16hex>-XX` shape / extract 정상 traceparent / 누락 → null / malformed 6가지 (segment count / non-hex / all-zero traceId / all-zero spanId / wrong width / unsupported version) → null / roundtrip equality
- **D. withSpan integration (3)**: resolve → end + status "ok" / throw → recordException + status "error" + end / nested withSpan → child has parent's traceId

전부 in-process, 0 disk I/O. fake OTel provider 는 startCalls / spans 배열을 캡처해 모든 delegation 을 검증.

## Alternatives rejected

1. **"`src/agent/dispatch.ts` 에서 `@opentelemetry/api` 직접 import"** — observability 가 loop 와 coupling 되면 plane-clean 위반이고 metrics 가 ADR-0144 에서 닫은 격리를 깨뜨림. typed port + 별도 adapter 가 metrics 와 동일 디시플린.
2. **"span 트리 self-impl"** — W3C `traceparent` 는 이미 표준화된 wire format 이고 OTel SDK 는 sampler/exporter/resource detector 등 production-grade ergonomics 를 갖고 있다. 재발명은 collector 호환성을 잃고 maintenance burden 만 늘림.
3. **"Jaeger SDK 직접 dependency"** — Jaeger 는 backend 중 하나. OTel SDK 는 broader (multi-exporter, multi-backend, multi-language). 첫 슬라이스부터 vendor lock-in 은 회피.
4. **"`@opentelemetry/api` 를 structural-only 로 선언" (metrics OTel sink 가 한 패턴)** — metrics 의 sink 는 leaf-shaped (counter.add(value, attrs)) 라 structural 로 충분했다. tracing 은 PARENT CONTEXT 를 OTel 의 `context.with(setSpan(context.active(), parentSpan), …)` ceremony 로 lift 해야 하는데, 이를 structural 로 재구현하면 OTel Context API 전체를 다시 짜야 한다 (버전마다 바뀜). package 가 ~50KB 로 작으니 직접 의존, bridge 는 얇게.
5. **"`SpanAttributes` 에 `string[]` / `number[]` 허용"** (OTel api 가 허용) — 배열 attribute 는 cardinality explosion 의 주범이고 우리 surface 의 90% 사용처 (`tool=bash`, `phase=verify`, `retries=3`) 에서 불필요. 배열이 필요한 caller 는 client-side 에서 join. 닫힌 primitive set 으로 시작.
6. **"propagator 가 `tracestate` 도 운반"** — tracestate 는 vendor-specific 확장 (Honeycomb-only, Datadog-only). 우리 `SpanContext` 는 3-field 라 tracestate 를 더하면 surface 가 커진다. follow-up.

## SOTA++ 자리매김

| Agent | typed `Tracer` port | W3C propagator | OTel adapter | parent-child tree | no-throw collapse | sub-barrel default-OFF |
|---|---|---|---|---|---|---|
| Cline | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| Claude Code 2.1 | ❌ (UI activity log only) | ❌ | ❌ | UI tree only | n/a | n/a |
| Cursor 3.2 | ❌ (IDE inspector only) | ❌ | ❌ | IDE tree only | n/a | n/a |
| Codex Desktop | partial (export-only) | ❌ | per-model only | export only | n/a | n/a |
| v0.dev | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| **quanta (본 ADR)** | ✅ closed Span/Tracer/Context | ✅ strict-mode W3C | ✅ caller-owned `TracerProvider` | ✅ parent SpanContext + Span both supported | ✅ provider failure → noop span, caller path unaffected | ✅ mirrors ADR-0144 metrics posture |

= "Codex 의 export-only OTel breakdown + Cursor/Claude 의 UI activity log 가 각각 cover 한 fragment 를 typed `Tracer` port + OTel adapter + W3C propagator 로 통합한 첫 슬라이스."

## Follow-up (이 ADR 이 닫지 않는 것)

- **dispatch instrumentation** — `src/agent/dispatch.ts` 의 모든 tool call 을 `tracer.withSpan(toolName, …)` 으로 감싸 자동 span 생성. attributes: `tool.name`, `tool.args.hash`, `tool.result.byteCount`, `tool.duration_ms`.
- **LLM stream instrumentation** — `src/llm/*` 의 stream open/close 를 span 으로 감싸 TTFT / token rate / stream stall 을 trace 트리에 가시화.
- **subagent fork-link** — `src/subagent/*` 의 spawn 시 parent span 의 context 를 child agent 에 넘기고 child 가 `tracer.startSpan(…, {parent: ctx})` 로 link. cross-process 의 경우 W3C propagator 로 ENV `TRACEPARENT` 전달.
- **W3C `tracestate` 운반** — vendor 확장이 필요해지면 `SpanContext` 에 `traceState?: string` 추가 + propagator 양방향 확장. 본 ADR 은 `traceparent` 만.
- **`/trace` CLI 슬래시** — registry 가 옵션이면 최근 N 개 trace 트리를 ASCII 트리로 dump. operator UX.
- **sampling policy** — 본 ADR 은 OTel SDK 의 sampler 에 위임. quanta-specific sampling (e.g. "verify-gate fail trace 는 항상 sample, 성공한 turn 은 1% sample") 은 별도 ADR.
- **0144/0186 helper-bundle ADR** — metrics 와 tracing 둘 다 default-OFF deferred-wire 패밀리. 미래에 single helper bundle ADR 로 묶을 가능성 (현재는 각자 격리되어 충돌 없음).

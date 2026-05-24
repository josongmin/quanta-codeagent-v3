# ADR-0159: Monitoring impl — instrument wrap helpers + Grafana dashboard + alert rules + E2E coverage

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0144 (MetricsRegistry), ADR-0154 (OTel sink), ADR-0155 (OTLP helper), ADR-0158 (24-metric recipe)
- **참조**: `src/observability/metrics/instrument.ts`, `docs/observability/{grafana-quanta.json, alerts-quanta.yaml}`, `tests/integration/instrumentation-coverage-e2e.test.ts`

## 맥락

ADR-0158이 24-metric recipe를 *권장 표*로 정의했지만 각 슬라이스에 boilerplate try/catch + increment 호출이 흩어지면 (1) 코드 누수 (2) drift (slice 추가 후 wire 누락) 가능. 본 라운드는 recipe → 실제 wrap helpers + dashboard + alerts + E2E 커버 closeout.

## 결정

### Part 1 — Instrument wrap helpers (`src/observability/metrics/instrument.ts`)

3종 closed wrappers + 1종 generic proxy:

```ts
// Typed wrappers (slice-specific)
instrumentLlmProvider(provider, metrics, opts?): LlmProvider
   // counters: stream.total / stream.failures.total
   // histograms: stream.ttft_ms / stream.duration_ms

instrumentSubagentScheduler(scheduler, metrics, opts?): BackgroundSubagentScheduler
   // counters: subagent.fork.total / subagent.cancel.total
   // histograms: subagent.duration_ms (status label)

// Generic
withCallCounter<T>(target, {metrics, metricName, methods, labels?}): T
   // Proxy-based; counts named methods + pass-through others
```

**불변**:
- 모든 wrap은 *pure forwarding* (메서드 contract 유지, return value passthrough)
- `safe(metrics, () => ...)` helper로 metrics.increment 실패 swallow (`MetricsSink` no-throw + 추가 defensive belt+suspenders)
- exactOptional: `opts` absent → wrap 그대로
- Plane-clean: 슬라이스가 metrics import 안 함 (caller-wire-time wrap)

### Part 2 — Grafana dashboard (`docs/observability/grafana-quanta.json`)

24 panels, 1 dashboard:
- LLM (4): calls/failures stat + TTFT p95 + duration p95
- Sandbox (3): spawn/degraded stats + backend pie
- LSP (3): requests stat + duration p95 + EXDEV count
- Subagent (4): fork/cancel stats + duration p95 + persist restored
- Shadow ODB (2): checkpoints + rewinds
- Conversation/Budget (3): checkpoint count + breach count + breach table
- Plan/Web/Tools (5): plan-queue + web fetch + web search + image + pdf

`templating.list`로 `$provider` + `$model` 변수 → 다중 series 필터. PromQL `histogram_quantile` p95 패턴.

### Part 3 — Alert rules (`docs/observability/alerts-quanta.yaml`)

Prometheus AlertManager rule groups, 3 severity tiers (critical/warning/info):

| Group | Alert | Trigger | Severity |
|---|---|---|---|
| budget | `BudgetSessionHardBreach` | `increase[5m] > 0` | critical |
| budget | `BudgetDailyHardBreach` | `increase[15m] > 0` | critical |
| budget | `BudgetSoftBreachSpike` | `rate[10m] > 0.5` | warning |
| llm | `LlmFailureRateHigh` | `failures/total > 10%` | warning |
| llm | `LlmTtftP95High` | `p95 > 3s` sustained | warning |
| sandbox | `SandboxDegradedHigh` | `degraded/total > 50%` | warning |
| lsp | `LspExdevFallbackFrequent` | `>100 in 1h` | warning |
| subagent | `SubagentPersistRestoreLossSpike` | `>5 in 1h` | warning |
| session | `SessionImportVersionMismatchSpike` | `rate > 0.1/s` sustained | info |

### Part 4 — E2E coverage test (`tests/integration/instrumentation-coverage-e2e.test.ts`)

3 cases:
1. **Required metric coverage**: 1-turn simulated flow (LLM stream + subagent fork→await) → assert ALL 5 expected metric names present in `m.snapshot()`. Catches "added slice, forgot wire" regression.
2. **Wrap survives broken metrics**: throwingMetrics → flow completes (no-throw invariant proven end-to-end).
3. **Zero-instrument baseline**: unwrapped scheduler → snapshot empty (byte-identical default-OFF proof).

## Default-OFF

`instrument.ts` 자체는 import해야 동작. caller가 wrap 호출 안 하면 슬라이스 byte-identical (case 3 증명). 즉 *추가 obs cost = caller가 명시적으로 선택할 때만*.

## Hellgate

`tests/unit/observability-metrics-instrument-hellgate.test.ts` — 14 cases:
- LLM: 6 (total/TTFT/duration/failures-label/meta-passthrough/no-throw)
- Scheduler: 5 (fork/cancel-existed/duration-status/await-null-skip/passthrough-non-instrumented)
- Generic proxy: 3 (selective-count/labels-builder/no-throw)

+ E2E 3 cases = **17 pass / 0 fail** (combined).

## Alternatives rejected

1. **각 슬라이스가 metrics 자체 import + record** — plane-clean 깨짐 + circular import 위험.
2. **AOP code-gen / babel macro** — 결정성 < 명시성. grep으로 어디서 emit되는지 안 보임.
3. **Histogram을 가짜 시간으로 record** — TTFT 실측이 의미 없어짐. 실 시계 의존이 정직.
4. **각 wrap을 별도 file로 split** — 3종이라 단일 파일에 묶음 (보일러 줄임). Generic proxy도 같은 파일이 hexagonal.
5. **Grafana provisioning yaml** vs JSON dashboard — JSON 직접 import가 더 흔한 워크플로 (Grafana UI → import).
6. **OpenMetrics format export 별도** — Prometheus exporter sink가 이미 OTel→Prometheus로 처리.

## SOTA matrix

| Agent | Built-in metrics | Dashboard provided | Alert rules provided | Coverage E2E |
|---|---|---|---|---|
| Cursor | IDE panel | ❌ | ❌ | ❌ |
| Codex | logs | ❌ | ❌ | ❌ |
| Claude Code 2.1 | transcript | ❌ | ❌ | ❌ |
| v0.dev | ❌ | ❌ | ❌ | ❌ |
| **quanta** | **MetricsRegistry+4sinks** | **24-panel Grafana JSON** | **9 alert rules** | **coverage E2E** |

= "agent metric의 end-to-end (registry + sink + wrap + dashboard + alerts + drift-catching E2E) 전부 typed로 박은 첫 OSS agent". Cline `$50/afternoon` 시나리오를 `BudgetSessionHardBreach` 알람이 page 단계로 차단.

## Follow-up

- Grafana folder import / provisioning manifest
- AlertManager routing config (`receivers: [pagerduty, slack-on-call]` 등)
- 더 많은 typed wrap (`instrumentShadowOdb`, `instrumentLspClient`, `instrumentReadImage`)
- Histogram bucket override per metric (정확한 SLO 측정)
- 추가 E2E: 모든 wrap 활성 후 전체 dashboard 쿼리가 non-empty인지 (`bun fc validate`-style cross-check)

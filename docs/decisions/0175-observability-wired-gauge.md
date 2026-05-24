# ADR-0172: Observability wired-status gauge — `observability.wired.total{slice}` machine-readable counterpart to ADR-0169 log

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0144 (MetricsRegistry typed port), ADR-0161 (withFullObservability composition-root helper), ADR-0169 (skipped-slice warning — operator-facing sibling), ADR-0158 (24-metric recipe)
- **참조**: `src/observability/metrics/observability-helper.ts`, `tests/unit/observability-metrics-wired-gauge-hellgate.test.ts`

## 맥락

ADR-0169가 `warnOnSkipped`로 startup 시점 unwired-slice를 사람이 읽는 로그로 알림 — 그 자체의 follow-up bullet에 명시:

> **Machine-readable observability-health metric**: `observability.wired.total{key}` 0/1 gauge per bag key. log는 사람용, gauge는 alerting용. 분리해서 각각의 SLO 다르게.

운영 관점에서 **두 개의 다른 audience**가 있다:

1. **사람 (operator)** — startup 직후 콘솔 로그를 보고 "어, llmProvider가 빠졌네" 인지. ADR-0169가 처리.
2. **기계 (PromQL/AlertManager)** — `observability_wired_total{slice="llmProvider"} == 0` 같은 alerting rule로 모니터링 시스템이 페이지를 호출. 로그 scraping (Loki/CloudWatch Logs Insights)은 가능하지만 string match는 high-cardinality + 부정확.

이 ADR이 (2)를 typed gauge로 분리.

### Research grounding — "no SOTA agent exposes this"

- `docs/analysis/경쟁사리뷰/may-21-claude-desktop-feature-catalog.md` §7.4 "Skills API 버전" 인근의 observability stack 분석: Claude Desktop은 **Sentry + Statsig + growthbook 3-tier** (lines 481-485)를 enterprise-grade로 사용하지만 모두 **internal product-side experiment/error reporting** — production process에 "이 slice가 wired인가" 를 묻는 typed gauge는 없음. Sentry breadcrumb은 event-on-error이지 helper-wiring-health point-in-time이 아님.
- 메모 `claude-desktop-1-7196-catalog.md`: 22개 `cowork_memory_sync_*` event tracked되고 system prompt section cache hit/miss가 추적되지만 모두 **implicit** (event 발생 시 카운트), helper-wiring-health gauge **없음**.
- `docs/analysis/경쟁사리뷰/code-agent-loop/cursor.md` lines 192, 784: `TurnEndedUpdate{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}` — **usage accounting** (얼마나 썼나)이지 **wiring health** (어떤 subsystem이 wire됐나)이 아님. 별개의 concern.
- Codex round-2/3 dive (memory `codex-otel-attribute-vocabulary`): 70+ OTel attribute keys (`codex.{conversation,thread,turn,mcp,tool,...}.*`)로 per-event tracing은 풍부하지만 "subsystem X is wired Y/N" gauge 없음.

**핵심 인사이트**: 어느 SOTA 에이전트도 per-slice wiring health를 first-class typed introspection surface로 노출하지 않음. quanta first. Kubernetes `process.status.healthy` / OTel resource semantic convention (`service.instance.id`) 의 정신을 single-process composition root에 옮기는 패턴.

## 결정

`ObservabilityOpts`에 1 신규 flag 추가 (default-OFF):

```ts
export interface ObservabilityOpts {
  // ... 기존 ...
  /** ADR-0172: when true, emit one gauge per ObservabilityBag key with
   *  value 1 (wired) or 0 (unwired) under metric name
   *  `observability.wired.total` with label `{slice: <key>}`. */
  readonly emitWiredGauge?: boolean
}
```

`withFullObservability` 동작:

1. 기존대로 7 slice wrap (or undefined 통과).
2. ADR-0169 warning path 그대로.
3. `opts.emitWiredGauge === true` 인 경우 **construction time에 1번**:
   - `ALL_BAG_KEYS` 7개 각각 순회:
     - `metrics.gauge("observability.wired.total", out[k] === undefined ? 0 : 1, { slice: k })`
   - 합계 7 gauge emit, slice 라벨로 구분.
   - 각 gauge call은 try/catch (broken adapter가 1 slice 던져도 나머지 6은 계속).

**Gauge name은 항상 `observability.wired.total` 고정**, `opts.prefixes` 영향 받지 않음 — meta-metric (helper 자체의 health)이지 sliced subsystem metric (LLM call rate 같은)이 아님.

### skippedExpected-vs-gauge-truth 분리

ADR-0169의 `skippedExpected`는 **운영자-facing warning을 침묵**시키는 allowlist지, **gauge를 truth와 다르게 거짓말**시키는 mechanism이 아님.

- `skippedExpected: Set([llmProvider])` 가 있어도 `observability.wired.total{slice="llmProvider"}` 는 여전히 **0** emit.
- 이유: 모니터링 dashboard는 ground truth를 봐야 함. "deployment-intent에서 의도된 skip"은 dashboard 레벨에서 **alert exclusion rule**로 표현 (PromQL: `observability_wired_total{slice!="llmProvider"} == 0`).
- 운영자 로그와 alerting metric을 다른 채널로 분리하는 것이 hexagonal의 정신 — 두 채널이 같은 데이터를 보지만 audience가 다름 → policy 분리.

## Default-OFF (byte-identical 증명)

`emitWiredGauge` 미지정 → `if (opts.emitWiredGauge === true)` false → return. ADR-0161/0169 호출 경로 0건 변경. snapshot에 `observability.wired.total` 0건 (Case [1] 증명).

## Hellgate

`tests/unit/observability-metrics-wired-gauge-hellgate.test.ts` — **8 신규 case**:

1. **[1]** `emitWiredGauge` 생략 (default) → snapshot에 `observability.wired.total` 0건 (byte-identical baseline).
2. **[2]** `emitWiredGauge: true` + empty bag → 7 gauge, 전부 value 0, slice 라벨 7개 distinct.
3. **[3]** `emitWiredGauge: true` + all 7 wired (Proxy-stub) → 7 gauge, 전부 value 1.
4. **[4]** partial (3 wired: `planQueue`/`budgetLedger`/`tools`, 4 missing) → bySlice Map으로 검증, wired 3개 value 1, missing 4개 value 0.
5. **[5]** gauge slice label set이 `ObservabilityBag` 7 키와 정확히 일치 (drift catcher).
6. **[6]** `skippedExpected: Set([llmProvider])` + `emitWiredGauge: true` → `llmProvider` gauge **여전히 0으로 emit** (gauge는 truth, skippedExpected는 warning만 영향) — **핵심 분리 case**.
7. **[7]** custom registry의 `gauge`가 첫 call에 throw → swallowed, 나머지 6 slice는 정상 record (try/catch per-key 증명).
8. **[8]** `opts.prefixes` 7개 custom 지정 → `observability.wired.total` name은 그대로, custom prefix 어디에도 안 묻음 (meta-metric 분리 증명).

## Operator query examples

```promql
# 단일 slice unwired 알람
observability_wired_total{slice="llmProvider"} == 0

# 임의 required slice unwired 알람 (필요 slice를 selector로)
sum(observability_wired_total{slice=~"llmProvider|scheduler|planQueue"}) by(slice) == 0

# wiring completeness ratio (dashboard SLO)
count(observability_wired_total == 1) / count(observability_wired_total)

# deployment-intent 기반 alert exclusion (의도된 skip 제외)
observability_wired_total{slice!~"llmProvider|lspClient"} == 0
```

## Alternatives rejected

1. **JSON `/health` endpoint** — quanta는 오늘 HTTP server 없음. `/metrics` 슬라이스 (ADR-0144 family)가 future endpoint를 깔지만 그건 별 ADR. gauge는 기존 metrics pipeline (Prometheus scrape / OTel push)에 무료로 따라감.
2. **Counter increments on every wire** — counter는 cumulative monotonic. wiring은 point-in-time presence (지금 wired인가?) → **gauge가 정확한 shape**. counter라면 "wire 횟수"가 되고, "현재 wired 상태"를 알려면 last sample 시각 + counter delta로 추론해야 함 — Prometheus model에 맞지 않음.
3. **`skippedExpected`도 gauge에 반영 (intent된 slice는 value=1 emit)** — gauge가 distorted truth가 되면 alert rule이 무의미. "wired health" 가 ground truth고, "deployment intent"는 dashboard alert rule selector로 표현 — concern 분리.
4. **Auto-refresh every N seconds (background timer)** — composition-root는 한 번 wire되고 끝 (생명주기 동안 wire 상태 변하지 않음). refresh가 필요한 use case (hot-reload slice)는 Phase 2 follow-up. 오늘 use case는 startup audit이 100%.
5. **Single counter `observability.wired.count` (값 = wired slice 갯수)** — slice 라벨 잃음 → "어떤 slice 가 unwired인가?" 답 못함. 7개 series가 정확한 cardinality, label-set bounded (key 7개 fixed = closed enum).
6. **ADR-0169 안에 patch** — 다른 audience (operator vs machine), 다른 lifecycle (log: ephemeral, metric: scraped/stored), 다른 sink. 독립 ADR이 추적/롤백/SLO 모두 깔끔.

## SOTA matrix (좁은 갱신)

| Agent | per-slice wiring health surface | machine-readable |
|---|---|---|
| Claude Desktop 1.7196 | Sentry breadcrumb (event-on-error) + Statsig/growthbook (feature flag side) | ❌ (no helper-wiring gauge) |
| Cursor 3.2.16 | `TurnEndedUpdate` (token usage), heartbeat | ❌ (usage ≠ wiring) |
| Codex Desktop 0.131 | 70+ OTel attribute (event tracing) | ❌ (event ≠ point-in-time presence) |
| **quanta** (본 ADR) | **`observability.wired.total{slice}` typed gauge** | ✅ PromQL-grepable |

= "composition-root wiring health을 typed gauge로 노출한 첫 single-process agent observability surface."

## Follow-up (이 ADR이 닫지 않는 것)

- **HTTP `/health` endpoint**: gauge 상태를 JSON으로 mirror하는 read-only endpoint. orthogonal — gauge는 이미 PromQL로 query 가능하므로 우선순위 낮음. quanta에 HTTP server 자체가 도입될 때 같이.
- **Periodic refresh hook**: `withFullObservability(bag, { emitWiredGauge: true, refreshIntervalMs: 30_000 })` — hot-reload slice가 등장하면 필요. 오늘은 composition-root immutable이므로 deferred.
- **Per-slice latency histogram**: `observability.wire_time_ms{slice}` — wrap construction cost 측정. orthogonal concern (wiring health vs wiring cost).
- **`deployment-profile` integration with gauge**: ADR-0169의 `skippedExpected` 자동 주입과 같은 구조로 dashboard rule selector를 export. selector는 운영 데이터 (Prometheus rule file)지 코드 아님.
- **Gauge → counter 추가 `observability.wired.skipped.total` (cumulative)**: composition-root reinit (subagent fork 등) 마다 +1로 누적. 오늘은 한 번 wire되면 끝이므로 (singleton) 의미 없음.

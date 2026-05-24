# ADR-0162: Budget per-event cost histogram — RecordResult shape + wrap emit

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0138 (BudgetLedger primitive — defined `record(event) → ReadonlyArray<BudgetBreach>`), ADR-0161 (monitoring full coverage — listed this as follow-up: "Budget per-event cost histogram: `BudgetLedger.record` cost 반환 추가 → metric emit")
- **참조**: `src/agent/budget-ledger.ts`, `src/observability/metrics/instrument-budget.ts`, `tests/unit/budget-ledger-hellgate.test.ts`, `tests/unit/observability-metrics-instrument-extra-hellgate.test.ts`

## 맥락

ADR-0161 박은 `instrumentBudgetLedger` wrap 은 `budget.record.total{model}` counter + `budget.breach.total{kind,scope}` counter 만 emit 했다. **per-event USD cost histogram** 은 wrap 안에서 정확히 계산 불가능했기 때문이다:

- `BudgetLedger.record(event)` 가 `ReadonlyArray<BudgetBreach>` 만 반환 — 비용은 내부에서 계산해 aggregate 에만 fold.
- Wrap 은 ledger 내부의 pricing table 에 접근 불가. snapshot delta 로 추정하려면 race-prone (다른 record 가 그 사이에 들어오면 delta 가 두 event 합).
- 결과: ADR-0161 은 이 갭을 명시적 follow-up 으로 박았다 ("Budget per-event cost histogram").

본 ADR 이 그 갭을 닫는다.

## 결정

### Part 1 — `RecordResult` 2-field shape

`BudgetLedger.record` 의 반환 타입을 확장:

```ts
export interface RecordResult {
  readonly cost: number                            // USD billed by THIS event
  readonly breaches: ReadonlyArray<BudgetBreach>   // unchanged semantics
}

export interface BudgetLedger {
  record(event: UsageEvent): RecordResult
  // ... rest unchanged
}
```

- `cost` 는 **REQUIRED on every return** (exactOptional 하에서도 항상 set). 정책 미설정 / 빈 breach / 알 수 없는 모델 모든 path 에서 cost 가 number.
- `cost` 계산 = `computeEventCost(event, resolvePricing(event.model)).totalCost` — aggregate 가 사용하는 것과 정확히 같은 path (unknown-model fallback 포함). 동일 이벤트의 wrap-side histogram 과 aggregate-side perModel 이 byte-equal.
- 방어 swallow path (malformed event) 도 `{ cost: 0, breaches: [] }` 를 반환 — 1-field 일관성 위배 없음.

### Part 2 — `instrumentBudgetLedger` per-event histogram emit

```ts
record(event) {
  const result = ledger.record(event)
  safe(metrics, () => metrics.increment("budget.record.total", 1, { model: event.model }))
  safe(metrics, () => metrics.observe("budget.event.cost_usd", result.cost, { model: event.model }))
  for (const b of result.breaches) {
    safe(metrics, () => metrics.increment("budget.breach.total", 1, { kind: b.kind, scope: b.scope }))
  }
  return result
}
```

`budget.event.cost_usd` 는 24-metric recipe (ADR-0158) 의 누락 슬롯 — 본 ADR 로 채워짐. labels=`model`.

## Default-OFF

ledger 자체의 wiring 행태 변화 없음. Wrap 미장착 → metric 0건 emit. 본 ADR 은 API surface 만 확장; 동작은 캐리어가 결정.

## Hellgate

- `tests/unit/budget-ledger-hellgate.test.ts` — Section C 8 케이스를 `r.breaches` 로 갱신; **신규 Section G (4 케이스)** 추가:
  - HELL-27: record 가 `{cost, breaches}` 반환; cost = pricing × tokens
  - HELL-28: malformed event 의 cost = 0 (방어 swallow 도 2-field 유지)
  - HELL-29: per-event cost 가 snapshot 누적과 독립
  - HELL-30: unknown-model event 도 sonnet fallback 으로 non-zero cost 반환
- `tests/unit/observability-metrics-instrument-extra-hellgate.test.ts` — 기존 3 케이스를 `{cost, breaches}` shape 으로 갱신 + **신규 1 케이스** ("ADR-0162: record → event.cost_usd histogram with model label").
- 사이드-이펙트 callers (cross-workspace-isolation / concurrent-primitives-stress / multi-plane-e2e / signal-mid-flight) 도 새 shape 으로 갱신 — 모두 0 fail.

총 영향: 45 + 30 + 29 = **104 pass / 0 fail** (직접 영향 받은 테스트 파일 합).

## Alternatives rejected

1. **snapshot delta 계산** — wrap 이 record 전/후 `ledger.snapshot().totalCost` delta 로 cost 추정. 거부: 동시 호출 시 다른 record 의 cost 가 delta 에 섞임 (race-prone); snapshot 도 매 호출 fold 라 비싼 호출. 정확성과 비용 모두 잃음.
2. **separate `recordWithCost` 메서드** — `record` 는 그대로 두고 cost-반환 variant 추가. 거부: API surface 가 2배가 되고, 둘 다 똑같이 비용을 계산하는데 호출자가 선택을 강요받음. 모든 record 호출에 cost 가 자연 — 분리할 이유 없음.
3. **`cost?: number` optional** — 거부: optional 은 caller 가 분기 처리 필요 (`result.cost ?? 0`). REQUIRED 로 박으면 wrap 도 직선 (`result.cost` 바로 observe). 방어 swallow path 는 `0` 으로 정직히 보고하면 충분.
4. **pricing table 을 wrap 으로 노출 + wrap 이 계산** — 거부: 같은 계산 logic 이 두 곳에 (ledger aggregate + wrap histogram). drift hazard. ledger 가 권한 있는 곳에서 한 번만 계산 후 결과를 emit.
5. **breakdown by token-type (input/output/cache_read/cache_write)** — out of scope. histogram 1개의 USD total 이 운영용 첫 metric 으로 충분; 분해는 follow-up.

## SOTA matrix

| Agent | per-event cost API | per-event cost metric | aggregate consistency |
|---|---|---|---|
| Cline | post-hoc UI | ❌ | n/a |
| Claude Code 2.1 | session total UI | ❌ | n/a |
| Cursor 3.2 | session total UI | ❌ | n/a |
| Codex Desktop | OTel per-model (aggregate) | aggregate only | aggregate |
| v0.dev | ❌ | ❌ | n/a |
| **quanta (이전 ADR-0138/0161)** | 내부 only (snapshot delta) | ❌ | aggregate |
| **quanta (본 ADR-0162)** | **RecordResult.cost (typed, REQUIRED)** | **`budget.event.cost_usd{model}` histogram** | aggregate = sum of per-event cost (byte-equal pricing path) |

= "per-event USD cost 를 typed primitive 반환에 박고 + 같은 값을 histogram 으로 emit 하는 첫 OSS agent. aggregate 와 per-event 가 동일 pricing path 를 공유 — drift 불가능."

## Follow-up (본 ADR 이 닫지 않는 것)

- **token-type cost breakdown**: `cost` 를 `{ input, output, cacheRead, cacheWrite, total }` 분해 형태로 surface. 별도 histogram (`budget.event.cost_usd_input` 등) 또는 단일 histogram 에 labels=`token_type` 추가. 본 ADR 은 `total` 만.
- **per-turn rollup**: `UsageEvent.turnId` 가 optional 로 있음 — turn 단위 cost histogram 가능. 본 ADR 은 model label 만.
- **histogram bucket tuning**: `defaultMetricsRegistry` 의 default bucket boundaries 가 cost 분포 (~$0.001 ~ $5/event)에 맞는지 SLO doc (ADR-0161 Part 3) 작성 시 검토.
- **dispatch wire**: ADR-0138 Follow-up 의 "dispatch.ts auto-record" 가 들어오면 본 histogram 이 자동으로 채워짐. 본 ADR 은 ledger ↔ wrap layer 만.

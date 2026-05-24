# ADR-0167: PlanQueue enqueue collapse metric — `EnqueueResult` + dedicated counter

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**: ADR-0128 (PlanQueueStore primitive), ADR-0161 (monitoring full coverage — deferred this follow-up), ADR-0144 (metrics registry), ADR-0162 (budget cost histogram — sibling "expand return shape so wrap can emit" pattern)
- **참조**: `src/agent/plan-queue.ts`, `src/observability/metrics/instrument-plan-queue.ts`, `tests/unit/plan-queue-hellgate.test.ts`, `tests/unit/observability-metrics-instrument-extra-hellgate.test.ts`

## 맥락

ADR-0161 (monitoring full coverage) listed "PlanQueue collapse-count metric" as a deferred follow-up:

> **PlanQueue dedup-collapsed count metric** — `enqueue` 반환값이 id이므로 collapsed 여부 알 수 없음 (id 동일하면 collapse). 정확한 collapse count는 ledger 확장 필요.

`PlanQueueStore.enqueue(input): string` returned just the id. When ADR-0128's dedup rule collapsed a same-`(threadId, textHash)` enqueue into an existing live entry, the wrap (`instrumentPlanQueue`) had no signal — the same string id could mean "new entry created" or "existing entry returned via dedup". Same id ≠ proof of collapse (counter happens to match? rare but possible to confuse), and a comparison-against-prior-snapshot strategy would require the wrap to hold per-thread state — coupling it to ADR-0128's per-thread semantics.

Result: collapse-rate — a load-bearing signal for "is the mid-turn surface generating spam keystrokes?" — was unobservable.

## 결정

### Part 1 — Expand `enqueue` return shape

`PlanQueueStore.enqueue(input): string` → `enqueue(input): EnqueueResult`:

```ts
export interface EnqueueResult {
  readonly id: string
  /** True when this enqueue collapsed into an existing live entry
   *  (same threadId + same textHash, both with drainedIntoTurn===null).
   *  When true, `id` is the existing entry's id. */
  readonly collapsed: boolean
}
```

Impl: dedup branch returns `{id: existing.id, collapsed: true}`; new-entry branch returns `{id, collapsed: false}`. `EnqueueResult.collapsed` is **required** (exactOptional — never optional/undefined). All callers using the bare-string id update to `result.id`.

### Part 2 — `instrumentPlanQueue` collapse counter

```
plan_queue.enqueue.collapsed.total      counter   (no labels)
```

Labels intentionally omitted (no `threadId`, no `source`, no `pausedReason`) — cardinality risk would explode (per-thread × source × pausedReason = unbounded series). Single counter; collapse rate is `collapsed.total / enqueue.total`.

Existing `plan_queue.enqueue.total{source, pausedReason, urgent}` still fires for **every** enqueue (collapsed or not — it measures attempts, not commits). Wrap logic:

```ts
const result = store.enqueue(input)
if (result.collapsed) {
  safe(metrics, () => metrics.increment(`${prefix}.enqueue.collapsed.total`))
}
return result
```

### Part 3 — Plane-clean & default-OFF

- `plan-queue.ts` slice still imports only `node:crypto`.
- `instrument-plan-queue.ts` wrap still imports only the `PlanQueueStore` type + `MetricsRegistry` port.
- No automatic instantiation — `EnqueueResult` is just a typed shape; callers who never wrap pay zero (the slice always returns the object, but no metric flows unless the wrap is composed in).

## Hellgate (4-case summary)

`tests/unit/plan-queue-hellgate.test.ts` — 2 new cases on top of the 22 existing (now 24 total; existing tests using bare-string `enqueue` updated to `result.id`):

- **HELL-NEW-1**: 2 sequential enqueue same text → first `collapsed:false`, second `collapsed:true`, ids equal (proves the dedup branch returns `collapsed:true` and reuses the existing id).
- **HELL-NEW-2**: 2 different threads same text → both `collapsed:false`, distinct ids (proves per-thread isolation from ADR-0128 #4 is preserved by the new return shape).

`tests/unit/observability-metrics-instrument-extra-hellgate.test.ts` — 2 new cases on top of the existing (fake `enqueue` updated to return `{id, collapsed}`):

- **HELL-PQ-NEW-1**: wrap with fake returning `{collapsed:true}` → `plan_queue.enqueue.collapsed.total` increments AND `plan_queue.enqueue.total` still fires (attempts vs commits).
- **HELL-PQ-NEW-2**: wrap with fake returning `{collapsed:false}` → ONLY `plan_queue.enqueue.total` fires; no `collapsed.total` series exists.

## Alternatives rejected

1. **Snapshot delta (`enqueue.total` vs `peek.length` delta)** — wrap would have to hold per-thread last-known-size state, then on each `enqueue` call `store.peek(threadId).length` before & after. Race-prone (other callers may also enqueue/drain), allocates a snapshot array per call (`peek` returns `ReadonlyArray<FollowUp>`), and couples the wrap to ADR-0128's `peek` semantics. Rejected: wrap should be O(1) state-free.
2. **Always-emit `enqueue.collapsed.total{collapsed:"true"|"false"}`** — would double the cardinality on a hot counter for zero analytical gain (the `false` series is already `enqueue.total - collapsed.total`). Rejected: redundant series violates 24-metric recipe minimalism (ADR-0158).
3. **Event-bus pattern (`store.on("collapse", ...)`)** — adds an EventEmitter dependency + listener-leak hazard to a pure-Map primitive. Rejected: contradicts ADR-0128 #1 (pure store, 0 I/O, 0 side-channels). The whole point of `EnqueueResult` is "return-value carries the signal" — caller decides what to do, no coupling.
4. **Mutate the existing entry to record collapse-count** — would change `FollowUp` shape (add `collapseCount: number`) and force readers to differentiate "1 enqueue + 0 collapses" from "1 enqueue + 1 collapse" everywhere. The collapse count is a **wrap-side observability concern**, not a queue-state concern. Rejected: ADR-0128's 12-field FollowUp stays untouched.
5. **`enqueue` returns `string | { id; collapsed }` (union)** — would allow callers to opt in. Rejected: dual shapes = TWO code paths in the wrap and every consumer. The cost of "all callers do `.id`" is one trivial migration (8 callsites in repo, all updated this round). Forever cost of dual-shape is higher.

## Follow-up (이 ADR이 닫지 않는 것)

- **Per-thread collapse-rate metric** — high-cardinality risk (one series per `threadId`). Defer until either (a) downsampling/aggregation pipeline (Prometheus recording rules — ADR-0144 family) lands, or (b) a concrete operator query proves the per-thread breakdown is load-bearing. Right now the global `collapsed.total / enqueue.total` rate is the SLO signal.
- **`pausedReason` breakdown on collapse counter** — same cardinality concern; 6-arm closed enum is bounded, so could be added later without unbounded growth. Defer until the global rate alert hits its threshold and operators need a "where are the dup keystrokes coming from?" drill-down.
- **Histogram of inter-enqueue collapse latency** — "how fast does the duplicate arrive after the original?" — would require timestamp delta tracking. Out of scope for this ADR; possible signal for keystroke-debounce calibration if mid-turn surfaces wire in.
- **`FollowUp.collapseCount` field on the entry itself** — useful if a future UI wants "this entry was retyped N times". Different concern from observability (per-entry display state vs aggregate counter). Separate ADR if/when surfaced.

## SOTA matrix (좁은 갱신)

| Agent | mid-turn enqueue collapse signal | observable as metric |
|---|---|---|
| Codex Desktop | implicit (id-equality after dedup) | ❌ |
| Claude Code 2.1 / Cursor 3.2 / v0 | — (no mid-turn queue) | — |
| **quanta** (ADR-0128 baseline) | implicit | ❌ |
| **quanta** (본 ADR) | **typed `EnqueueResult.collapsed`** | **`plan_queue.enqueue.collapsed.total` counter** |

= "PlanQueue primitive의 dedup 경계를 typed return signal + 별도 counter로 노출한 첫 closed-port observability slice. wrap is O(1) state-free; primitive remains pure (0 I/O)."

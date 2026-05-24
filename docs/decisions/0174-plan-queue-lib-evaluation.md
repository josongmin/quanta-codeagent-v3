# ADR-0174: `p-queue` library evaluation — KEEP self-implementation for `PlanQueueStore`

- **상태**: Accepted (decision: keep self-implementation)
- **날짜**: 2026-05-25
- **관련**: ADR-0128 (PlanQueue 12-field FollowUp + per-thread LRU + dedup — sibling, the artifact under evaluation), ADR-0167 (PlanQueue collapse counter — extends the same artifact)
- **참조**: `src/agent/plan-queue.ts` (~345 LOC, unchanged by this ADR), `tests/unit/plan-queue-hellgate.test.ts` (22-case hellgate sealing the surface)

## 맥락

User principle: **"외부에 잘 만들어진 거 있으면 외부 거 써."** Following that principle, `p-queue` (sindresorhus, ~1.6k★, mature) was evaluated as a candidate replacement for the hand-rolled `PlanQueueStore` shipped by ADR-0128.

The name `PlanQueueStore` and the verb `enqueue`/`drain` superficially suggest a "queue library" use case. The honest comparison below shows the API shapes do **not** overlap.

| Axis | `p-queue` | our `PlanQueueStore` |
|---|---|---|
| What is stored | `() => Promise<T>` task functions | 12-field **typed `FollowUp` records** (id, threadId, text, source, enqueuedAtMs, pausedReason, arrivedDuringTurn, urgent, drainedIntoTurn, metadata, textHash, label) |
| When work runs | Async — library invokes the task with a concurrency limit | Never — store is a passive container; the consumer (turn-boundary replayer) decides when to drain |
| Method shape | `add(fn, {priority})`, `pause()`, `start()`, `onIdle()`, `size`/`pending` | `enqueue(input)`, `drain(threadId, currentTurn)`, `peek(threadId)`, `clear(threadId)`, `inspect()` — all **synchronous** |
| Partitioning | Single global queue | **Per-`threadId` isolation** (independent queues, per-thread LRU cap) |
| Dedup | None | `(threadId, textHash)` collapse window restricted to **live** entries (`drainedIntoTurn === null`); urgent OR-in on collapse |
| Eviction | None (queue grows unbounded; user must rate-limit upstream) | `maxPerThread` LRU with **2-tier policy**: drop oldest non-urgent → all-urgent fallback drops oldest urgent (documented hard-ceiling trade-off, HELL-16) |
| Lifecycle annotation | None | `drainedIntoTurn` zombie-tracking — drained entries are removed atomically; dedup window must exclude them; `peek`/`inspect` filter them out |
| Output typing | `T` (caller-defined) | `EnqueueResult { id, collapsed }` (ADR-0167 — `collapsed` is the load-bearing observability signal) + `ReadonlyArray<FollowUp>` snapshots |
| Optional-field policy | N/A | `exactOptionalPropertyTypes` — `label` **omitted** (not `undefined`) when absent (HELL-22) |

## 결정

**KEEP the self-implementation in `src/agent/plan-queue.ts`.** No `bun add p-queue`. No adapter file. No src changes from this ADR.

### Rationale

`p-queue` is a **task scheduler** (async functions, concurrency limits, priority order, idle signals). Our slice is a **typed record store** (synchronous CRUD over a domain record, dedup, per-thread LRU, drain semantics tied to a `currentTurn` integer). The 22 hellgate cases enforce contract obligations that have **no corresponding primitive in `p-queue`**:

- **HELL-5/6/7 (dedup window restricted to live entries)** — `p-queue` does not store records to dedup against; tasks vanish once executed.
- **HELL-8/9 (urgent OR-in on dedup)** — requires mutating the existing entry in place; `p-queue` has no entries to mutate.
- **HELL-13 (urgent-first sort within same enqueuedAtMs)** — `p-queue` supports `priority`, but that's a one-shot dequeue order, not a stable sort with a secondary tiebreak by enqueuedAtMs and a tertiary tiebreak by insertion index.
- **HELL-14/15/16 (LRU 2-tier eviction with all-urgent fallback)** — `p-queue` has no cap and no eviction.
- **HELL-11 (drain stamps `drainedIntoTurn = currentTurn`)** — bespoke domain mutation tied to an integer the caller passes in.
- **HELL-22 (`exactOptionalPropertyTypes` — `label` omitted, not `undefined`)** — `p-queue`'s task functions don't expose such a field.

Concretely, a `p-queue`-backed adapter would need to:

1. Maintain our own `Map<threadId, FollowUp[]>` **alongside** `p-queue` (because `p-queue` doesn't store our records).
2. Run all dedup / urgent-OR-in / LRU / drain logic on **our** structure (because `p-queue` exposes none of it).
3. Never actually `.add(fn)` anything — the only "task" is the synchronous record append, and `p-queue` always wraps via `Promise.resolve`, adding microtask latency and an unused concurrency dimension.

That is **100% of the existing ~345 LOC reimplemented**, with `p-queue` sitting dormant as a dependency that contributes nothing. Per-line LOC saving estimate: **0 lines**, net change: **+1 transitive dependency** + a wrapper that must keep proving the same 22 hellgate invariants.

### Honesty check

The user's principle exists specifically to prevent NIH bias. The honest answer here is: the artifact's name ("queue") triggers the principle, but the artifact's **shape** is a typed record store, not a task queue. Adopting `p-queue` to honor the surface noun would be cargo-culting the principle, not following it.

## Alternatives rejected

| Lib | Why rejected |
|---|---|
| `p-queue` | Wrong abstraction layer (async task scheduler, not typed record store). 0% API overlap with our 5-method surface. Adapter would re-implement everything. |
| `bull` / `bee-queue` | Redis-backed persistent job queues — orders of magnitude heavier; require external infra (Redis); built for cross-process distributed work, not in-process per-turn replay. |
| `bottleneck` | Rate-limiting / throttling primitive (token-bucket, reservoir) — orthogonal concern (we don't rate-limit follow-ups; we dedup + LRU-cap them). |
| `async` (caolan) `queue` | Same shape as `p-queue` (async task runner with concurrency); same mismatch. |
| `denque` / `mnemonist` `LRUCache` | Generic data structures — would save ~30 LOC of LRU bookkeeping but lose the 2-tier urgent-fallback policy (HELL-16) and force re-implementation anyway. Net LOC saving < the cost of an extra dependency for a hot-path module. |

## Re-evaluation triggers

Revisit this decision **if any** of the following becomes a requirement:

1. **Concurrency limits on follow-up processing** (e.g. "only N follow-ups may be replayed concurrently across all threads") — would map cleanly onto `p-queue`'s `concurrency` knob.
2. **Async preprocessing per follow-up** (e.g. each follow-up runs a Promise-returning validator before entering the queue) — `p-queue` is built for this.
3. **Priority scheduling that exceeds binary urgent/non-urgent** (e.g. integer 0–9 priority with weighted-fair dequeue) — `p-queue`'s `priority` would beat our hand-rolled sort.
4. **Pause/resume of the dispatching wire as a first-class state machine** (`pause()` / `start()` / `onIdle()` semantics) — currently the loop owns this state; if it moved into the queue, `p-queue` would carry its weight.

Until then: keep the self-implementation. The 22 hellgate cases already prove the surface; adding a dependency layer underneath them would only multiply the maintenance surface without changing what they guard.

## 결과

- **src change**: none. `src/agent/plan-queue.ts` and `tests/unit/plan-queue-hellgate.test.ts` unchanged.
- **dependency change**: none (`p-queue` NOT installed).
- **doc change**: this ADR only.
- **Reversibility**: a future revisit (per the triggers above) can introduce a `plan-queue-pqueue-backed.ts` sibling without touching the existing module — the `PlanQueueStore` interface is the seam.

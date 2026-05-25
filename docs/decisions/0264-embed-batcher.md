# ADR-0264: EmbedBatcher — 50ms window + single-flight dedupe + provider batch_size honoured

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**:
  ADR-0159 (`@/retrieval` 5-axis SOTA stack — Axis D `EmbeddingPort`),
  ADR-0254 (retrieval slice — semantic / lexical / engines / reranker / cache
  sibling on which the batcher composes when wired by an assembler).
- **References**:
  `src/retrieval/batching/types.ts` (typed `EmbeddingVector`, `BatchConfig`, `BatchError`),
  `src/retrieval/batching/port.ts` (closed `EmbedBatcher` port),
  `src/retrieval/batching/single-flight.ts` (pure `Map<text, Promise<Vector>>` dedupe),
  `src/retrieval/batching/default-batcher.ts` (production adapter — accumulate during
  `windowMs`, single-flight within window, split on `maxBatchSize`, parallel-flight chunks),
  `src/retrieval/batching/index.ts` (barrel),
  `tests/unit/retrieval/embed-batcher-hellgate.test.ts` (15 cases).

## Context

`@/retrieval` Axis D ships an `EmbeddingPort` whose only method is
`embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>`
— each adapter (openai / voyage / 6 stubs) talks to the provider in
**batch shape** because every embedding API charges per call, not per
text, and most enforce a per-request `batch_size` cap (openai 96,
voyage 128, etc.).

Callers above the port (commit-embedder, hybrid-query, future memory
retrievers, …) often want to embed **one text at a time** in their own
control flow:

```ts
const vec = await embed.embed([userQuery])   // 1-call-per-text
```

Three failure modes follow from this pattern unless we interpose:

1. **N-call amplification.** A loop / `Promise.all` over 50 distinct
   texts → 50 HTTP calls instead of 1. At openai pricing this is
   ~50× the per-call overhead (TLS + JSON parse + headers) for the
   same total tokens.
2. **Duplicate-text fan-out.** Two unrelated callers asking for the
   same query string at the same tick → 2 identical HTTP calls.
   Pure single-flight (Map-keyed by text) would coalesce them, but
   today every caller talks to the port directly.
3. **Provider batch-size violation.** A caller that *does* pre-build a
   100-text array against openai's 96 cap gets a 400 — the adapter
   loops internally but there's no shared coalescing across callers.

This ADR ships the slice primitive that fixes all three under a single
closed port. It is **wire-shape only** — no production caller is
re-pointed in this round (default-OFF / byte-identical landing per
RFC §1.2).

## Decision

### Slice layout

```
src/retrieval/batching/
  types.ts           — EmbeddingVector, BatchConfig, BatchError (4-arm)
  port.ts            — EmbedBatcher { embed, flush, pending }
  single-flight.ts   — pure Map<text, Promise<Vector>> dedupe helper
  default-batcher.ts — production adapter (window timer + chunk split + parallel)
  index.ts           — barrel
```

### Types (`types.ts`)

```ts
export type EmbeddingVector = readonly number[]

export interface BatchConfig {
  readonly windowMs: number      // accumulation window; 0 → next microtask flush
  readonly maxBatchSize: number  // provider batch_size cap; per-flight chunk size
}

export type BatchError =
  | { kind: "underlying-failed"; detail: string }
  | { kind: "aborted" }
  | { kind: "vector-missing"; text: string }
  | { kind: "config-invalid"; detail: string }
```

`EmbeddingVector` is an alias, not a brand — it matches the existing
`EmbeddingPort.embed()` return-element shape verbatim so the batcher
can wrap any of the 8 vendor adapters without a converter.

`BatchError` is a closed 4-arm union; the hellgate proves
exhaustiveness via `assertNever`.

### Port (`port.ts`)

```ts
export interface EmbedBatcher {
  /** Submit one text. Resolves with the embedding vector or a typed
   *  BatchError. Coalesces with any other in-window calls and any
   *  in-flight identical text (single-flight). */
  embed(
    text: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Result<EmbeddingVector, BatchError>>

  /** Trigger an immediate flush of any pending texts. Idempotent. */
  flush(): Promise<void>

  /** Number of texts currently queued (not yet flushed). Observability. */
  pending(): number
}
```

The port returns a typed `Result` — every other call-site in the
codebase that wraps an `EmbeddingPort` either throws (legacy) or
returns a result; the batcher chooses the result shape because it
introduces *new* error arms (`aborted`, `vector-missing`,
`config-invalid`) that don't naturally lift to existing throws.

### Single-flight (`single-flight.ts`)

A pure helper, no I/O, no timers:

```ts
export interface SingleFlight<T> {
  run(key: string, factory: () => Promise<T>): Promise<T>
  size(): number
}

export const createSingleFlight = <T>(): SingleFlight<T> => { /* … */ }
```

Semantics: at most one in-flight `Promise<T>` per `key`. New `run(k)`
calls during the flight subscribe to the same promise. The map slot
is **deleted on settle** (success or fail) so the next call starts a
fresh flight — no stale-value retention.

### Default adapter (`default-batcher.ts`)

- Accumulator: `pending: Array<{ text: string; resolve; reject }>`.
- Timer: a single `setTimeout(flush, windowMs)` armed on first
  `embed()` after empty, cleared on flush. `windowMs === 0` schedules
  on `queueMicrotask` instead (still asynchronous — multi-`embed()`
  calls within the same tick coalesce).
- On flush:
  1. Drain pending into local `batch`.
  2. Apply single-flight by text — duplicate texts in the same batch
     share one slot in the outgoing array; each duplicate caller's
     `resolve` is invoked with the same vector.
  3. Chunk by `maxBatchSize` — one outgoing `embedder.embed(chunk)`
     call per chunk; chunks are issued in parallel via
     `Promise.all`.
  4. Map vectors back by index; if the provider returns fewer
     vectors than asked (truncation), missing slots get
     `{ ok: false, error: { kind: "vector-missing", text } }`.
- Underlying throw → every pending caller for this flush gets
  `{ ok: false, error: { kind: "underlying-failed", detail } }`.
- AbortSignal: if a caller's `opts.signal` is already aborted at
  `embed()` time → resolve immediately with
  `{ ok: false, error: { kind: "aborted" } }` (no enqueue). If
  aborted *after* enqueue but before flush, the abort listener
  invokes the caller's `resolve` with `{ kind: "aborted" }` AND
  removes them from the pending list. Other callers in the same
  batch are unaffected.
- Config validation: `windowMs < 0` or `maxBatchSize < 1` →
  every `embed()` immediately resolves
  `{ kind: "config-invalid", detail }`. The factory itself does
  *not* throw, so the caller's wire-up doesn't need a try/catch.

### Barrel (`index.ts`)

Re-exports the closed port, the production factory, the single-flight
helper, and the public types. The slice's own `index.ts` is the
public surface; nothing is re-exported from `src/retrieval/index.ts`
this round (the top-level barrel is on the **unchanged** list per the
constraint envelope, and a caller is free to import
`@/retrieval/batching` directly).

## Consequences

**Positive**

- N concurrent same-tick `embed(text)` calls → 1 HTTP call (vs N).
- M concurrent same-text calls during one flight → 1 HTTP call
  (single-flight dedupe), all M callers see the same vector.
- Caller-side stays single-text-API; the cost amplification fix is
  invisible above the port.
- Default-OFF: no existing caller is re-pointed. A wire-up round
  swaps the embedder reference in commit-embedder / hybrid-query
  composition — until then, byte-identical.
- `pending()` plus `flush()` give the test surface a deterministic
  drain — no real-time `setTimeout` waits in unit tests; production
  uses the timer, tests use `flush()`.

**Negative / accepted trade-offs**

- `windowMs > 0` adds up to `windowMs` of latency to the *first*
  text in a batch. Default `windowMs` is not set by this ADR —
  the caller supplies a `BatchConfig`. Reasonable values are 0
  (microtask coalesce only) or 50 (one human-perceivable frame).
- The single-flight key is the exact text string — different
  capitalisation / whitespace are different keys. This matches what
  the provider would charge for anyway (the vectors differ); we
  don't normalise.
- No retry / no rate-limit awareness. Underlying-throw → all
  callers in that flush get `underlying-failed`. Retry policy is a
  caller concern; layering retry inside the batcher would conflate
  two responsibilities and is explicitly out of scope.
- The slice is shipped **default-OFF**. No production caller swaps
  to it in this round (RFC §1.2 byte-identical landing).

## Rejected alternatives

- **Default-ON: rewire `EmbeddingPort` to be the batcher.** Breaks
  byte-identical landing and changes the per-call latency profile
  of every caller without a per-caller knob.
- **Use a third-party batcher (`p-batch`, `dataloader`).** Both add
  a runtime dependency for ~80 lines of logic that's tighter when
  the seam is custom (windowMs=0 microtask + abort propagation +
  single-flight purity-on-settle don't all align with either lib's
  defaults).
- **Single-flight only (no window).** Coalesces identical-text
  fan-out but not N-distinct-text fan-out — i.e. fixes 1 of the 3
  failure modes. Both are common; both deserve the fix.
- **Throw on `config-invalid` from the factory.** Forces every
  caller into a try/catch at composition time. Resolving the
  promise with a typed error keeps the call-site shape uniform.

# ADR-0262: Reranker port — closed seam + Cohere/Voyage REST adapters + identity default

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0159 (`@/retrieval` slice — Axes A/B/C/D/E), ADR-0254
  (retrieval composition wire — registry-based reranker dispatch this slice
  composes into without changing).
- **References**:
  `src/retrieval/reranker/types.ts` (`RerankedHit`, `RerankerCapabilities`,
  `RerankError` 5-arm),
  `src/retrieval/reranker/port.ts` (closed `Reranker` port —
  `rerank(query, hits, k)` returns `Result<readonly RerankedHit[], RerankError>` +
  `capabilities()`),
  `src/retrieval/reranker/identity-reranker.ts` (default, pass-through),
  `src/retrieval/reranker/cohere-reranker.ts` (POST `https://api.cohere.com/v1/rerank`,
  model `rerank-v3.5`),
  `src/retrieval/reranker/voyage-reranker.ts` (POST `https://api.voyageai.com/v1/rerank`,
  model `rerank-2`),
  `src/retrieval/reranker/headless-stub.ts` (deterministic hash-based scoring),
  `src/retrieval/reranker/registry.ts` (env-driven selection via
  `QUANTA_RERANKER=cohere|voyage|identity|headless`),
  `src/retrieval/reranker/index.ts` (barrel),
  `tests/unit/retrieval/reranker-hellgate.test.ts` (15 cases).

## Context

`@/retrieval` (ADR-0159) shipped four built-in reranker strategies tied to a
slice-internal `RerankPort` shape (`identity` / `bm25-secondary` /
`tier-aware` / `score-fusion-rrf`). All four are PURE — they reorder a list
of `RetrievalCandidate` using their own scoring with NO external call. That
leaves a gap: managed-service rerankers (Cohere `rerank-v3.5`, Voyage
`rerank-2`) that take a query + N candidate texts over HTTP and return
relevance scores trained for retrieval. These deliver materially better
precision@k on RAG pipelines and are the de-facto industry default once
embedding recall is in place.

Adding them to the existing `RerankPort` would (a) leak vendor concerns —
HTTP, API keys, model names — into a pure async port, (b) force every
existing call-site through a `Result`-vs-throw shape change, and (c)
conflate "reorder by score I already have" (the existing strategies) with
"call a vendor that ASSIGNS scores given query + text" (the new ones). The
clean break is a SECOND closed port — `Reranker` — that is `Result`-shaped,
declares vendor capabilities (`provider` / `model` / `maxDocsPerCall` /
`maxInputTokens`), and lives next door at `src/retrieval/reranker/`.

## Decision

### Slice layout

```
src/retrieval/reranker/
  types.ts              — RerankedHit, RerankerCapabilities, RerankError (5-arm)
  port.ts               — Reranker { rerank, capabilities }
  identity-reranker.ts  — default, pass-through (byte-identical)
  cohere-reranker.ts    — POST https://api.cohere.com/v1/rerank (rerank-v3.5)
  voyage-reranker.ts    — POST https://api.voyageai.com/v1/rerank (rerank-2)
  headless-stub.ts      — deterministic (hash-based)
  registry.ts           — env-driven swap (QUANTA_RERANKER=…)
  index.ts              — barrel
```

### Types

`RerankedHit { originalIndex: number; score: number; hit: T }` — preserves
the caller's index so the caller can correlate back to the input list
without an extra lookup. The hit payload is generic so the port works
against `RetrievalCandidate`, `MemoryHit`, file-search rows — anything the
caller has. `RerankerCapabilities { provider; model; maxDocsPerCall;
maxInputTokens }` is required (no optionals leaking `undefined` under
`exactOptionalPropertyTypes`).

`RerankError` is a 5-arm closed union:
- `"auth-failed"` — vendor returned 401/403. Never retry, never fall back.
- `"rate-limited"` — vendor returned 429. Caller may back off and retry.
- `"empty-query"` — caller passed `""` or whitespace-only. Boundary refuses
  before any HTTP — the vendors charge for the call and return useless
  scores.
- `"too-many-docs"` — `hits.length > capabilities().maxDocsPerCall`. Caller
  must chunk; the adapter refuses rather than silently dropping.
- `"transport"` — every other failure (5xx, network, malformed JSON). The
  cause is attached for diagnostics; the kind is exhaustively switchable.

### Port shape

```ts
export interface Reranker<T = unknown> {
  rerank(
    query: string,
    hits: readonly T[],
    k: number,
  ): Promise<Result<readonly RerankedHit<T>[], RerankError>>
  capabilities(): RerankerCapabilities
}
```

### Boundary contract

- `k === 0` → `ok([])` without any vendor call.
- `k > hits.length` → caller receives all hits ranked (the adapter clamps
  internally).
- `hits.length === 0` → `ok([])` without any vendor call.
- `query` empty/whitespace → `err({ kind: "empty-query" })` synchronously.
- `originalIndex` always points back to the index inside the INPUT `hits`
  array — never the post-sort index.

### Default-OFF wiring

The `Reranker` port is unwired in the composition root in this ADR.
`identityReranker` is the default; consumers that opt in MUST select via
`createRerankerFromEnv()` or instantiate Cohere/Voyage directly with their
own HTTP injection. With `QUANTA_RERANKER` absent or set to `identity`,
the slice is byte-identical to "no reranker present" — HELL-RR-14 seals
this invariant.

### Adapter pattern (HTTP injection)

External library installs are blocked. Both Cohere and Voyage adapters
inject a small `CohereHttp` / `VoyageHttp` interface exposing only
`rerank(body, opts?)`. Production wires a `fetch`-based implementation
(see `cohere-reranker.ts`'s `defaultCohereHttp`); tests inject a fake. The
slice never imports a vendor SDK directly.

### Why a NEW port instead of extending `RerankPort`

| Concern                | Existing `RerankPort`                          | New `Reranker`                                       |
|------------------------|------------------------------------------------|------------------------------------------------------|
| Shape                  | `rerank(input) → readonly RetrievalCandidate[]`| `rerank(query, hits, k) → Result<RerankedHit[], …>`  |
| Failure model          | Throws (pure functions can't fail)             | `Result` (vendor failures are EXPECTED)              |
| Element type           | `RetrievalCandidate` (slice-local)             | Generic `T` (caller-defined)                         |
| Capabilities introspection | n/a                                        | `capabilities(): RerankerCapabilities`               |
| Existing strategies    | identity / bm25-secondary / tier-aware / RRF   | identity / cohere / voyage / headless                |

Both ports coexist. Mixing them is a non-goal — pure rerankers stay where
they are (`src/retrieval/rerank/`); vendor rerankers live here
(`src/retrieval/reranker/`). The plural-vs-singular directory name is the
file-system discriminator.

## Hellgate (15 cases)

`tests/unit/retrieval/reranker-hellgate.test.ts`:

- HELL-RR-01 identity → hits returned in order with original index/score.
- HELL-RR-02 cohere mock → score reorders the list.
- HELL-RR-03 voyage mock → score reorders the list.
- HELL-RR-04 k=0 → empty result (no HTTP).
- HELL-RR-05 k > hits.length → all hits returned.
- HELL-RR-06 originalIndex accurately refers to input index.
- HELL-RR-07 4xx auth → `err("auth-failed")`.
- HELL-RR-08 429 → `err("rate-limited")`.
- HELL-RR-09 empty/whitespace query → `err("empty-query")` (no HTTP).
- HELL-RR-10 empty hits → `ok([])` (no HTTP).
- HELL-RR-11 capabilities round-trip (provider/model/maxDocsPerCall/maxInputTokens).
- HELL-RR-12 maxDocsPerCall exceeded → `err("too-many-docs")`.
- HELL-RR-13 registry env swap (`QUANTA_RERANKER=…`) returns expected provider.
- HELL-RR-14 default (no env) → identity → byte-identical pass-through.
- HELL-RR-15 RerankError 5-arm exhaustive (switch covers each kind exactly once).

## Negative invariants

- **No vendor SDK import.** Both Cohere and Voyage adapters inject HTTP. A
  `defaultCohereHttp` / `defaultVoyageHttp` factory exists but uses raw
  `fetch`. Adding `import "cohere-ai"` or `import "voyageai"` is a slice
  violation.
- **No silent fallback.** The registry never falls back from a configured
  provider to identity on error — the operator asked for `cohere` by
  name; if Cohere is mis-configured, the error surfaces.
- **No cross-port mixing.** The `Reranker` port does NOT extend the
  existing `RerankPort`. The element types differ; the failure models
  differ; the methods differ. Mixing them is a design error.

## Catalog

`tools/feature-catalog/features/04-context-management/reranker-port.yaml`
records the slice with `adrs: [262, 254]` and `deliberate_hold` noting
that composition-root wiring (selecting the port in the retrieval pipeline
when an env says so) is deferred — this ADR ships port + adapters + env
selector + hellgate, not a re-plumbing of `runHybridQuery`.

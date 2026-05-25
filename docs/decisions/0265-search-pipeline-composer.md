# ADR-0265: SearchPipeline composer + 5 pre-built presets

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0159 (`@/retrieval` slice fence), ADR-0136 (token budget
  ledger — opt-in budget-gate integration), ADR-0254/0260/0262/0263/0264
  (retrieval / rerank / index siblings the composer never imports), the
  legacy `runHybridQuery` 3-stage funnel which this composer generalizes
  (kept unchanged — sibling slice).
- **References**:
  - `src/retrieval/pipeline/types.ts` — `SearchPipeline`, `SearchQuery`,
    `SearchHit`, `Stage` 5-arm union, `PipelineError` 6-arm union, 7 inline
    duck-typed ports (`LexicalSearch`, `SemanticIndex`, `Embedder`,
    `Reranker`, `EmbedCache`, `EmbedBatcher`, `BudgetProbe`).
  - `src/retrieval/pipeline/port.ts` — narrow re-export of `SearchPipeline`
    for callers that only want the contract.
  - `src/retrieval/pipeline/compose.ts` — pure `compose(stages)` DAG
    composer + per-arm runners + inline `fuseByRrf` (Cormack 2009 k=60,
    formula byte-identical with the sibling `rerank/score-fusion-rrf`).
  - `src/retrieval/pipeline/lexical-only.ts`,
    `src/retrieval/pipeline/semantic-only.ts`,
    `src/retrieval/pipeline/parallel-rrf.ts`,
    `src/retrieval/pipeline/semantic-then-rerank.ts`,
    `src/retrieval/pipeline/budget-aware.ts` — 5 pre-built presets.
  - `src/retrieval/pipeline/index.ts` — sub-barrel.
  - `tests/unit/retrieval/pipeline-hellgate.test.ts` — 20 adversarial
    cases (HELL-PI-01 … HELL-PI-20).

## Context

`runHybridQuery` (ADR-0159 Axis E) ships a 3-stage funnel hard-coded to
"bm25 ∥ semantic → optional rerank → optional limit". It works for the
default flow but composes poorly when callers want:

- semantic-only (no bm25 source available),
- N-way RRF over more than two sources,
- a budget-gated retrieval that aborts before spending another \$X on
  embedding/rerank API calls (Cline `$50 in one afternoon` cautionary tale),
- a reranker chain with a non-vector first stage,
- sibling pipelines composed transitively (rrf(lex, rrf(sem1, sem2))).

Adding each capability as a new top-level helper (the "one function per
combinator" trap) explodes the surface area. A composer is the OCP exit
without touching the sibling slice files.

## Decision

Ship a pure DAG composer in a brand-new sub-slice `src/retrieval/pipeline/`
that:

1. Defines `SearchPipeline { search(query): Promise<Result<SearchHit[],
   PipelineError>> }` — the single contract every retrieval pipeline
   honours. No-throw on the public surface; the 6-arm `PipelineError`
   enumerates every failure mode (`empty-pipeline`, `unknown-stage`,
   `stage-failed`, `budget-exceeded`, `invalid-config`, `no-results`).
2. Defines `Stage` as a 5-arm discriminated union:
   `lexical | semantic | rerank | rrf | budget-gate`. `rrf` and
   `budget-gate` are RECURSIVE — they carry inner stage(s) — so the
   composer is genuinely a DAG, not a flat pipeline.
3. Provides `compose(stages: readonly Stage[]): SearchPipeline` — a pure
   reducer with NO I/O, NO clock, NO module-level state. The same `stages`
   array produces byte-identical results on repeated invocations (modulo
   caller-injected side effects).
4. Ships five pre-built presets so the caller does not need to know the
   `Stage` shape for the common cases:
   - `lexicalOnlyPipeline({ lex })`
   - `semanticOnlyPipeline({ sem, embedder, cache?, batcher? })`
   - `parallelRrfPipeline({ lex, sem, embedder, cache?, batcher?, rrfK? })`
     — runs lex + sem in parallel, fuses with RRF.
   - `semanticThenRerankPipeline({ sem, embedder, reranker, cache?, batcher? })`
   - `budgetAwarePipeline({ inner, maxUsd, probe })` — wraps any inner
     Stage with a budget gate.
5. Every sibling-slice port (`LexicalSearch`, `SemanticIndex`, `Embedder`,
   `Reranker`, `EmbedCache`, `EmbedBatcher`, `BudgetProbe`) is INLINE
   DUCK-TYPED in `types.ts`. The composer never imports
   `src/retrieval/{lexical,semantic,embedders,reranker,cache,batching}.ts`
   nor `src/agent/budget-ledger.ts`. The slice fence in `biome.json`
   (`@/retrieval` → `@/shared` only) stays honest. Callers in `@/agent`
   adapt their concrete implementations to the duck-typed shape at the
   assembly site.

### RRF formula

`score(d) = Σ 1/(k + rank_i(d))`, `k = 60` (Cormack 2009 published
constant — `[[no-heuristics-only-validated]]`). The formula is INLINED in
`compose.ts` rather than imported from `src/retrieval/rerank/score-fusion-rrf.ts`
because that import would cross the sibling-slice fence. The numeric
formula is locked by HELL-PI-04.

### Budget-gate integration

The `BudgetProbe` port has one method: `usdSoFar(): number`. Callers wire
it to `defaultBudgetLedger()` (ADR-0136) at the assembly site:

```ts
const ledger = defaultBudgetLedger({ policy: { sessionHardUsd: 5 } })
const pipe = budgetAwarePipeline({
  inner: { kind: "lexical", impl: bm25 },
  maxUsd: 1.0,
  probe: { usdSoFar: () => ledger.snapshot().totalUsd },
})
```

The composer NEVER imports `@/agent/budget-ledger` — duck-typing keeps the
fence clean while preserving the integration.

### Default-OFF

Nothing in `@/agent`, `@/runner`, or `@/apps` constructs a pipeline at
ship time. HELL-PI-14 enforces this via a source-text grep against
`from "@/retrieval/pipeline`. Callers opt in by importing the sub-barrel
explicitly.

## Alternatives rejected

1. **Extend `runHybridQuery` with optional knobs.** Would break the
   "every dependency is injected" pattern — `runHybridQuery` would need
   to accept either a bm25 source OR a budget probe OR an RRF list, with
   the combinatorics encoded as defaults. Composer DAG is cheaper.
2. **Import `fuseByRrf` from the sibling.** Would cross the sub-slice
   boundary the constraint forbids. Inlining 20 lines with a comment
   pointing at the canonical implementation is cheaper than a slice-fence
   carve-out.
3. **Make `Stage` open (any shape).** Would silently drop a future arm at
   the runtime switch. The closed union + the runtime mirror
   (`RUNTIME_OK_KINDS`) catches the cast-through-`unknown` drift that the
   compile-time `never` can't see.

## Hellgate

`tests/unit/retrieval/pipeline-hellgate.test.ts` ships 20 adversarial
cases:

| ID | Invariant |
|----|-----------|
| HELL-PI-01 | `lexicalOnlyPipeline` returns lex source hits |
| HELL-PI-02 | `semanticOnlyPipeline` embeds then queries |
| HELL-PI-03 | RRF lex+sem fuses both pipelines |
| HELL-PI-04 | RRF formula uses Cormack-2009 k=60 (numeric lock) |
| HELL-PI-05 | semantic-then-rerank chains the reranker |
| HELL-PI-06 | `budget-gate` ABOVE limit → `Err("budget-exceeded")` |
| HELL-PI-07 | `budget-gate` UNDER limit → passes through |
| HELL-PI-08 | nested rrf — `rrf(lex, rrf(sem1, sem2))` fuses transitively |
| HELL-PI-09 | `compose([])` → `Err("empty-pipeline")` |
| HELL-PI-10 | sub-stage error → propagates as `PipelineError` |
| HELL-PI-11 | `k=0` → empty result, no work done |
| HELL-PI-12 | Stage 5-arm runtime exhaustive (cast-through-unknown) |
| HELL-PI-13 | `compose` PURE — same stages produce same results |
| HELL-PI-14 | default-OFF — no `from "@/retrieval/pipeline"` imports in agent/runner/apps |
| HELL-PI-15 | `PipelineError` 6-arm closed (TS `never` on missing arm) |
| HELL-PI-16 | RRF k cap applied at the boundary |
| HELL-PI-17 | semantic + cache mock — cache hit avoids embed |
| HELL-PI-18 | semantic + batcher mock — batcher receives the call |
| HELL-PI-19 | 1000 doc × multi-stage perf sanity (< 200 ms) |
| HELL-PI-20 | all 5 presets execute with minimal default args |

## Consequences

- **+** Composer DAG covers the 5 mainstream presets PLUS arbitrary
  nesting. New combinators ship as new presets without touching
  `compose.ts`.
- **+** Slice fence honoured — every sibling integration is a one-method
  duck-typed port.
- **+** Default-OFF preserved by source-text invariant (HELL-PI-14).
- **−** Inlined `fuseByRrf` is a deliberate code duplicate of
  `src/retrieval/rerank/score-fusion-rrf.ts`. The numeric formula is
  locked by HELL-PI-04; a future divergence is caught at the boundary,
  not silently merged.
- **−** Multi-stage linear arrays (`compose([s1, s2])` without an
  explicit `rrf` wrapper) ship only the last stage's hits. The presets
  document this and HELL-PI-08 covers the nested-rrf path.

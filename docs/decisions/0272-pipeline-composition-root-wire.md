# ADR-0272: Pipeline composition-root wire — `assemblePipeline(env)` + `search_codebase` tool

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0265 (SearchPipeline composer + 5 presets — the leaf
  primitive this ADR wires at the composition root), ADR-0260
  (lexical-search BM25/ripgrep), ADR-0261 (pluggable embedder/store
  registry), ADR-0262 (reranker port + env factory), ADR-0263 (embed-cache
  env factory), ADR-0264 (embed-batcher single-flight), ADR-0266
  (model-tag versioning). ADR-0159 / ADR-0236 (composition-root wire
  discipline at `src/apps/agent/index.ts`).
- **References**:
  - `src/apps/agent/pipeline-wire.ts` — `assemblePipeline(env): SearchPipeline | null` +
    7-arm preset selector + adapter glue from slice ports (`@/retrieval/lexical`,
    `@/retrieval/semantic`, `@/retrieval/reranker`, `@/retrieval/cache`,
    `@/retrieval/batching`) to the pipeline's INLINE DUCK-TYPED ports
    (`LexicalSearch`, `SemanticIndex`, `Embedder`, `Reranker`, `EmbedCache`,
    `EmbedBatcher`, `BudgetProbe`). Each preset wires only the siblings
    it needs; failures collapse to `null` + a `logger.warn` line so a
    misconfigured env never crashes the surface.
  - `src/apps/agent/index.ts` — extension: `buildBaseFromArgs` calls
    `assemblePipeline(env)` and spreads `searchPipeline` onto the
    `AgentConfig` base under `exactOptionalPropertyTypes` discipline.
  - `src/agent/types.ts` — new slot `AgentConfig.searchPipeline?: SearchPipeline`
    (helper-only — loop never reads it; future consumer in `search_codebase`
    tool reads it through `ToolContext.searchPipeline` when wired).
  - `src/tool/search_codebase.ts` — `searchCodebaseTool(pipeline?)` defineTool
    factory. The provider-less form yields a typed `ok:false` "no pipeline wired"
    result (mirrors `web_search`); when wired, the tool delegates to
    `pipeline.search({ text, k })` and formats the ranked hits.
  - `tests/unit/apps/agent/pipeline-wire-hellgate.test.ts` — 12 adversarial
    cases (HELL-PW-01 … HELL-PW-12).

## Context

Phase 7 (ADR 0260-0266) shipped 7 retrieval slices default-OFF. Each is a
leaf primitive — the SearchPipeline composer (ADR-0265) is the seam that
turns these primitives into a usable retrieval pipeline. But there is no
**composition root wire**: nothing in `src/apps/agent/index.ts`
instantiates a pipeline, no `AgentConfig` slot holds one, and no tool
exposes it to the model. The 7 slices are dead-code from the agent's
perspective until the operator manually composes them — which means in
practice nobody uses them.

This is the same gap ADR-0236 closed for 6 capability slots (sticky-model,
tool-profile, focus-chain, delegation, fork-session, etc.): the surface
projects ENV → typed input, the composition root assembles the right
sibling-slice helpers based on a single closed-enum preset, and the
resulting handle rides into the AgentConfig as an optional slot the
downstream consumer reads when present.

## Decision

Ship the wire in three layers:

1. **`assemblePipeline(env)`** — a pure function (`src/apps/agent/pipeline-wire.ts`)
   that reads ONE env var, `QUANTA_PIPELINE`, and returns either a
   `SearchPipeline` (when the operator opted into a preset) or `null`
   (default-OFF byte-identical). The 7-arm closed enum:

   - `none` (default / absent / unknown value) → `null`
   - `lexical-only` → wires `headlessLexicalStub` adapted to the pipeline's
     `LexicalSearch` port; uses `lexicalOnlyPipeline`.
   - `semantic-only` → wires `createHeadlessEmbedder` + `createInMemoryIndex`
     adapted to the pipeline's `Embedder` + `SemanticIndex` ports; consults
     `resolveEmbedCacheFromEnv` for the cache; uses `semanticOnlyPipeline`.
   - `parallel-rrf` → composes the two above into `parallelRrfPipeline`.
   - `semantic-then-rerank` → semantic + `createRerankerFromEnv(...)` adapted
     to the pipeline's `Reranker` port; uses `semanticThenRerankPipeline`.
   - `budget-aware` → semantic-only inner stage gated by an inline
     `BudgetProbe` that always reports 0 USD (test wire; production hosts
     replace via `searchPipelineProbe` follow-up); uses `budgetAwarePipeline`.

   On adapter-build failure (e.g. invalid embedder env, throwing reranker
   factory), the helper emits a `logger.warn` line, falls back to `null`,
   and the agent runs as if the operator had not set the knob. This
   mirrors the existing `buildRetrievalStackFromEnv` discipline (no
   startup crash on optional knob misconfiguration).

2. **`AgentConfig.searchPipeline`** — optional slot on AgentConfig holding
   the assembled `SearchPipeline` handle. Helper-only — the loop does NOT
   read this slot. Future consumers (the `search_codebase` tool today,
   and any future retrieval-aware feature) read it via the dispatch seam
   onto `ToolContext.searchPipeline` (sibling slot, also optional).

3. **`searchCodebaseTool(pipeline?)`** — `defineTool` factory in `src/tool/`.
   When invoked WITHOUT a pipeline, yields a typed `ok:false` "no pipeline
   wired" (mirrors `webSearchTool()`). When wired, delegates to
   `pipeline.search({ text, k })` and formats the ranked hits as a numbered
   block (matching `web_search` output). Default-OFF posture: the tool is
   NOT auto-registered by `buildDefaultTools`; the composition root opts
   it into a per-mode runner's tool set as a follow-up (deferred to keep
   this ADR's surface focused on the wire chain).

## Env knobs

| Env | Default | Effect |
|---|---|---|
| `QUANTA_PIPELINE` | `none` | `lexical-only` / `semantic-only` / `parallel-rrf` / `semantic-then-rerank` / `budget-aware` — selects the assembled preset. Any other value (including `unknown`) collapses to `null` with a `logger.warn` line. |
| `QUANTA_EMBED_CACHE` | `none` | Forwarded to `resolveEmbedCacheFromEnv` when a preset wires an embedder. `in-memory` / `sqlite` / `none`. |
| `QUANTA_RERANKER` | `identity` | Forwarded to `createRerankerFromEnv` when `semantic-then-rerank` is selected. `identity` / `headless` / `cohere` / `voyage`. |

The wire NEVER reads its own embedding HTTP / vendor API keys — it uses
the deterministic `headlessLexicalStub` + `createHeadlessEmbedder` for
the first pass so the wire path is testable + ships without coupling to a
specific vendor. Production hosts that want a real embedder / lexical
backend follow up by passing their own adapter through the helper's
optional `overrides` parameter (kept narrow on purpose — ports only, no
ENV-readers).

## Posture

- **Default-OFF byte-identical**. With no env set, `assemblePipeline`
  returns `null`, the slot is OMITTED on the AgentConfig (spread-conditional
  under `exactOptionalPropertyTypes`), and the surface is bit-for-bit
  identical to the pre-ADR path.
- **Slice fence preserved**. `pipeline-wire.ts` lives in `src/apps/agent/`
  — the composition-root layer that may freely import from `@/retrieval`,
  `@/agent`, `@/tool`. The pipeline primitives themselves stay leaf-only
  (`@/shared` only). The tool slice never imports `@/retrieval` (the
  `searchCodebaseTool` accepts a duck-typed pipeline shape that mirrors
  `SearchPipeline` structurally).
- **No-throw**. Adapter build failure (invalid env, missing API key) is
  caught at the helper boundary, logged via `logger.warn`, and surfaces
  as `null` — the operator gets a diagnostic line, the agent runs.
- **Closed-enum preset selector**. The 6-arm preset switch is a
  discriminated union; adding a 7th preset is a 1-file edit forcing every
  consumer that switches on the enum to add the missing arm (TS `never`).

## Non-goals

- Production-grade lexical / embedder adapters (the headless stubs are
  the surface contract — production hosts inject real adapters as a
  follow-up ADR).
- Auto-registration of `search_codebase` into the default tool fence
  (separate ADR; this ADR ships the factory + the wire, not the
  registration).
- Reading the pipeline output back into the agent's working memory (a
  retrieval-aware compaction or auto-recall slot is a separate ADR).

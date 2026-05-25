# ADR-0278: `search_codebase` tool + auto-register wire

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0265 (SearchPipeline composer), ADR-0277
  (codebase indexer slice), ADR-0159 (`@/retrieval` slice fence),
  ADR-0260 / ADR-0261 / ADR-0263 / ADR-0264 (retrieval siblings).
- **References**:
  - `src/tool/search-codebase/index.ts` — `searchCodebaseTool(pipeline)`
    factory. Read-only + concurrency-safe; wraps a
    `SearchPipeline.search(query)` into the `Tool<I, O>` surface.
  - `src/agent/types.ts` — single new optional slot
    `searchPipeline?: SearchPipeline` on `AgentConfig`. Default-OFF.
  - `src/apps/agent/index.ts` — `buildSearchPipelineFromEnv(env)` reads
    `QUANTA_PIPELINE`, `QUANTA_INDEX`, `QUANTA_INDEX_GLOB`,
    `QUANTA_INDEX_INTERVAL_MS`; when active, constructs the indexer +
    in-memory `SemanticIndex` adapter + `semanticOnlyPipeline(...)` and
    registers `searchCodebaseTool(pipeline)` into the default tool set.
  - `tests/unit/retrieval/indexer-hellgate.test.ts` HELL-IDX-22 …
    HELL-IDX-25 — wire cases (`QUANTA_INDEX=off` byte-identical,
    one-knob-only does NOT register tool, both-on registers tool,
    end-to-end mock search).

## Context

ADR-0277 ships the indexer slice; ADR-0265 ships the pipeline
composer. Neither is wired to the agent loop. The pre-existing
`AgentConfig.retrievalStack` slot (ADR-0159) is read by memory
recall and the localize tool — not by a tool the model can call to
ask "where in the codebase is X?". The result is dead-code-shaped
infrastructure: the model has no way to invoke semantic search.

We need a single closed-port wire that:

1. Builds a populated pipeline when (and only when) the operator
   opts in.
2. Surfaces a `search_codebase` tool to the model so retrieval is
   reachable from the dispatch loop.
3. Stays default-OFF — every legacy caller byte-identical.

## Decision

Ship two minimal artifacts:

### 1. `searchCodebaseTool(pipeline)` factory

A thin `Tool<I, O>` wrapper that forwards `query` + `k` (default 10,
max 50) to the injected pipeline and renders the resulting
`SearchHit[]` as `path:startLine-endLine  (score=…)  snippet`
ordered by descending score. The tool:

- declares `isReadOnly() ⇒ true` (every consumer port is read-only),
- declares `isConcurrencySafe() ⇒ true` (queries do not mutate the
  pipeline; the indexer's write surface is owned by the polling
  loop, not the tool),
- on `pipeline.search(...)` returning `Err`, yields a typed
  `ToolFailure { mode: "error", modelVisibleError: error.kind }` so
  the model can branch by `PipelineError.kind` rather than regex on
  text,
- honours `ctx.signal` at every async boundary (the underlying
  pipeline's stages already do — the wrapper only forwards).

### 2. Composition-root wire (`src/apps/agent/index.ts`)

Two env knobs gate the wire (closed-port, default-OFF):

- `QUANTA_PIPELINE` — set to `"on"` to enable pipeline construction.
- `QUANTA_INDEX` — set to `"on"` to enable indexer construction.

The wire applies the **closed truth table**:

| `QUANTA_INDEX` | `QUANTA_PIPELINE` | Behaviour                                                             |
| -------------- | ----------------- | --------------------------------------------------------------------- |
| (unset / off)  | (unset / off)     | Default tool set byte-identical; no indexer, no pipeline.             |
| on             | (unset / off)     | Indexer is created (background process), but **no tool registered**. |
| (unset / off)  | on                | Pipeline slot may be populated by other future helpers; no tool yet. |
| on             | on                | Indexer scans + populates a private `SemanticIndex` adapter;          |
|                |                   | `searchCodebaseTool(pipeline)` is added to `buildDefaultTools()`     |
|                |                   | output AND `AgentConfig.searchPipeline` is set.                       |

The wire schedules `scanDelta()` on a `setInterval` using
`QUANTA_INDEX_INTERVAL_MS` (default 5000 ms); the interval handle is
held in module-local state and cleared on process `beforeExit`.

The composition root is the **only** site that constructs the
indexer or the pipeline — sibling slices remain unchanged. Total
new lines in the composition root: ~30 (one helper + one slot spread
+ one default-tool append), well within the "1–3 → reasonable"
budget the slice contract allows.

### 3. AgentConfig slot

A single optional field is added to `AgentConfig`:

```ts
searchPipeline?: SearchPipeline
```

Read by no slice today — it is published purely so future tools and
the dispatch seam can detect a wired pipeline without re-reading
env. (ADR-0265 left a `retrievalStack` slot for reranker-only use;
this slot is the pipeline-as-a-whole sibling.) Default-OFF discipline
is the same: when unset, every legacy caller is byte-identical.

## Slice fence

The wire is at the composition root only. Sibling slices
(`@/agent`, `@/runner`, `@/tool/*`) keep their existing imports
untouched. The new tool file (`src/tool/search-codebase/index.ts`)
sits in `@/tool` and imports `@/retrieval/pipeline` (allowed by the
biome `noRestrictedImports` table; `@/tool → @/retrieval` is open).

## Knobs

- `QUANTA_PIPELINE` (on|off, default off) — pipeline gate.
- `QUANTA_INDEX` (on|off, default off) — indexer gate.
- `QUANTA_INDEX_GLOB` (default `src/**/*.ts`) — glob the default
  scanner consumes.
- `QUANTA_INDEX_INTERVAL_MS` (default 5000) — polling cadence for
  `scanDelta`.

## Consequences

- **Positive**: The model now has a first-class semantic search
  tool. The wire respects the "operator opts in once" principle —
  one env knob each for pipeline and indexer, no toggles per
  subsystem. The closed truth table is locked by HELL-IDX-22 …
  HELL-IDX-25.
- **Negative**: The default `SemanticIndex` adapter the wire builds
  is in-memory — large monorepos (10k+ files) will see process RSS
  grow. The wire is a starting point; ADR-0277's promotion path
  enables swapping to a disk-backed `SemanticIndex` without touching
  the tool or the dispatch seam.

## Deliberate hold

The wire does not currently call any of the production embedders
(OpenAI / Voyage / etc.) — it uses a deterministic in-memory
embedder (hash-of-token-bag → fixed-dim vector) so the wire is
runnable without an API key. The embedder slot is constructor-
injectable on the indexer; promoting to a production embedder is
a one-line swap at the composition root.

## Notes

- The default-tool builder (`buildDefaultTools`) is NOT changed by
  this ADR — the conditional registration happens AFTER
  `buildDefaultTools()` in the composition root, so sessions with
  the wire OFF see byte-identical tool ids in the registry. This
  preserves the structural invariant Phase 4 RFC §1.2 enforces.
- The composition root caller is the surface entry
  (`src/apps/agent/index.ts`). Mode presets that build their own
  registry (interactive / headless) are unchanged; they will pick
  up the tool when the surface threads it through
  `AssembleRequest.base.registry` — a follow-up wiring beyond this
  ADR's scope.

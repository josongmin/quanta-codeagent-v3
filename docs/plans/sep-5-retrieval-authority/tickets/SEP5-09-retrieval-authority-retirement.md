# SEP5-09 — retrieval authority and legacy retirement

**Priority:** P2 design-and-removal
**Status:** PLANNED; removal gated on public-consumer inventory
**Depends on:** SEP5-00
**Finding coverage:** D15

## Goal

End the parallel embedding/reranking authority without hiding incompatible
contracts behind re-exports. Prefer deleting the unconsumed legacy composition
path; introduce adapters only for proven external/public consumers.

## Current truth

- Live semantic indexing uses `src/retrieval/engines/embedder` through
  `runner/assemble/search-index-backend.ts`.
- Live vendor reranking uses `src/retrieval/reranker` through
  `runner/assemble/pipeline.ts`.
- `runner/assemble/retrieval.ts#buildRetrievalStackCore` states that it has no
  in-tree consumer.
- Legacy `EmbeddingPort` throws/returns a different shape from the newer
  `Embedder` `Result` contract.
- `rerank/` contains pure ranking/fusion strategies; `reranker/` contains a
  different generic/vendor contract. The directory names alone do not prove all
  contents should merge.

## Phase 0 — authority manifest

Create a checked manifest before deleting code:

```ts
export interface RetrievalAuthorityManifest {
  readonly productionEmbedderFactory: "engines/embedder/createEmbedderFromEnv"
  readonly productionVendorRerankerFactory: "reranker/createRerankerFromEnv"
  readonly legacyAssemblerConsumers: readonly string[]
  readonly publicLegacyExports: readonly string[]
}
```

The implementation may use a test-local inventory rather than shipping this
type. It must resolve imports/calls structurally and assert a non-zero live
production floor.

## Decision gate

For each legacy symbol, classify:

1. live internal consumer — migrate via an explicit adapter;
2. package/public export with external compatibility commitment — deprecate and
   retain a tested adapter for one release boundary;
3. no consumer/no commitment — delete;
4. algorithm still used under the new stack — move the algorithm only, not the
   old port/factory.

Do not proceed to removal until package exports and repository imports are both
checked.

## Write set

| File/path | Change |
|---|---|
| `src/runner/assemble/retrieval.ts` | Delete the unconsumed assembler, or convert it to an explicit new-contract adapter only if a consumer is proven |
| `src/runner/assemble/index.ts` | Remove obsolete export after callers reach zero |
| `src/retrieval/index.ts` | Remove/deprecate legacy exports; eliminate ambiguous `identityReranker` export |
| `src/retrieval/embedding-port.ts` | Retire only after every consumer is classified |
| `src/retrieval/embedders/**` | Delete or adapt provider implementations based on the manifest |
| `src/retrieval/rerank/**` | Retain pure BM25/RRF/fusion algorithms that are still consumed; rename contract-specific identity helper |
| `src/retrieval/engines/embedder/**` | Canonical embedding runtime; avoid unrelated rewrite |
| `src/retrieval/reranker/**` | Canonical vendor reranker runtime; avoid unrelated rewrite |
| `tests/unit/retrieval-authority-manifest.test.ts` | New non-vacuous authority/caller inventory |
| search-index/pipeline integration tests | Prove production composition remains reachable |

The exact deletion list is an output of Phase 0, not a presupposition.

## Migration logic

If a real legacy consumer exists, place an adapter at `@/runner` composition:

```ts
const legacyEmbeddingPortFrom = (embedder: Embedder): EmbeddingPort => ({
  async embed(texts) {
    const result = await embedder.embed(texts)
    if (!result.ok) throw mapLegacyEmbeddingError(result.error)
    return result.value
  },
})
```

This is temporary compatibility, not a second provider factory. Record the
removal condition next to the adapter.

## RED rails

- Live search-index assembly cannot resolve an embedder through the canonical
  engine.
- Live pipeline cannot resolve the canonical vendor reranker.
- A production module imports a retired provider factory.
- The manifest matches zero production factories or silently scans zero files.
- Removing a legacy export with a proven public consumer breaks a compatibility
  fixture before an adapter exists.
- Two public symbols named `identityReranker` remain with incompatible types.

## Test and ratchet implementation

- Implement the authority manifest test with the TypeScript compiler AST. Walk
  production source files, resolve imports/exports, and count call expressions;
  do not count comments, type references, imports, or bare identifiers.
- Require at least two known live canonical calls in aggregate:
  `createEmbedderFromEnv(...)` from search-index assembly and
  `createRerankerFromEnv(...)` from pipeline assembly. Require zero production
  calls to `buildRetrievalStackCore(...)` before deleting it.
- Inventory package/barrel exports separately from call sites and classify each
  legacy symbol as internal, public compatibility, or dead. The test fixture
  serializes this explicit classification; an unclassified export fails.
- Mutation A adds a type-correct synthetic production AST fixture that calls the
  legacy assembler; the zero-legacy-call assertion must name it. Mutation B
  changes a call to a bare reference/import; it must not satisfy the canonical
  call floor. Mutation C scans an empty file set; the scanned-file/factory floors
  must fail.
- Runtime proof remains behavioral: `search-index-backend.test.ts` must execute
  the canonical embedder seam and `search-pipeline.test.ts` the canonical
  reranker seam. Removing either composition call must make its integration test
  fail independently of the AST inventory.
- After deletion, rerun the AST manifest and `rg`; neither an empty glob nor a
  zero-test selection is accepted as a green receipt.

## Proof rails

```sh
rg -n 'buildRetrievalStackCore|EmbeddingPort|create[A-Za-z]+Embedder|identityReranker' src tests
bun test tests/unit/retrieval-authority-manifest.test.ts
bun test tests/unit/retrieval
bun test tests/unit/runner/search-index-backend.test.ts tests/unit/runner/search-pipeline.test.ts
bun test tests/unit/retrieval/engines-hellgate.test.ts tests/unit/retrieval/reranker-hellgate.test.ts
bun run typecheck
bun run lint:debt
bun test tests/unit/retrieval-slice-boundary.test.ts
```

Use only paths that exist after the Phase-0 inventory; do not treat an empty
glob/test selection as green.

## Definition of done

- One runtime embedding provider factory and one vendor reranker factory remain.
- Pure ranking algorithms remain reusable without restoring the legacy factory.
- Every deleted symbol has zero classified consumer or a tested compatibility
  adapter.
- Production search-index and pipeline integrations are green.

## Stop conditions

- Public export compatibility cannot be determined.
- The proposed change converts `Result` to throw, or throw to silent fallback,
  without a boundary adapter.
- The only proof is a source regex requiring one preferred identifier.

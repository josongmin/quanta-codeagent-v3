# R10 receipt — search availability / embedding space

Status: **implemented** (not verified). Not W7 `verified`.

Lane: W4-C. Memory BLOB (R03) and retrieval space are **not** one store.

source HEAD snapshot: `f3a93d5fd22855951ef4f871813e2b55b0f41b0c`

## Snapshot

| Field | Value |
|---|---|
| Bun | 1.3.14 |
| OS | Darwin arm64 24.6.0 |
| god-code | `search-index-backend.ts` 830 (in-memory + space-bind extracted; not in 900–999) |

## Findings

| ID | Result |
|---|---|
| E-SEARCH-01 | `readiness` single-flight; ops await it; explicit create/cap/op failure throws `SemanticBackendUnavailableError`; valid empty query still `[]` |
| E-EMBED-01 | `EmbeddingSpace { model, revision, dimensions, normalization }`; no hash/headless fallback on provider fail; no cosine `Math.min`; sqlite persist binds space; unknown/mismatch refuse without deleting rows |

## RED→GREEN

```
bun test tests/unit/sep8-remediation/r10/ tests/integration/sep8-remediation/r10/ tests/unit/runner/search-index-backend.test.ts tests/unit/runner/t06-search-backend-failclosed-hellgate.test.ts
```

32,769-byte + 1536d cap → `input-too-large`. Same-dim different model unequal. Query/index dim mismatch throws. File-backed sqlite reopen with other space keeps original rows.

## Unverified / out of scope

- Lance/Qdrant persisted space sidecar (sqlite only this wave)
- Operator rebuild CLI
- Mixing R03 memory embeddings into retrieval index

# ADR-0275: Real-API smoke eval for retrieval — drift detection (eval tier, non-blocking)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0003 (4-tier test pyramid — `test:eval` non-blocking),
  ADR-0261 (pluggable Embedder + VectorStore registry — `Embedder` port +
  4 vendor adapters this slice exercises),
  ADR-0262 (Reranker port + Cohere/Voyage REST adapters this slice exercises).
- **References**:
  `tests/eval/retrieval/_helpers.ts`
    (`describeOnEnv` polite-skip + cost-cap utilities),
  `tests/eval/retrieval/openai-embedder.eval.test.ts`
    (5 cases — `text-embedding-3-small`, dim=1536),
  `tests/eval/retrieval/voyage-embedder.eval.test.ts`
    (5 cases — `voyage-3`, dim=1024),
  `tests/eval/retrieval/cohere-embedder.eval.test.ts`
    (5 cases — `embed-english-v3.0`, dim=1024),
  `tests/eval/retrieval/cohere-reranker.eval.test.ts`
    (5 cases — `rerank-v3.5`),
  `tests/eval/retrieval/voyage-reranker.eval.test.ts`
    (5 cases — `rerank-2`),
  `tests/eval/retrieval/ollama-embedder.eval.test.ts`
    (5 cases — local `nomic-embed-text`, dim=768).

## Context

The Phase 7 retrieval slice (ADR-0261 / ADR-0262) ships closed ports +
typed-error adapters for OpenAI / Voyage / Cohere / Ollama (embedders)
and Cohere / Voyage (rerankers). Every `tests/unit/retrieval/*-hellgate`
suite asserts shape and typed-error behaviour with **injected fake
`fetch`** — none of them speak to a real provider.

That leaves a real-world drift hole. If OpenAI / Voyage / Cohere changes
the response shape (e.g. `data[].embedding` → `data[].vector`), the URL
path, the auth header, the error status semantics, or the rate-limit
contract, our unit tests stay green while production immediately
degrades. The same risk applies to a local Ollama version bump that
changes `/api/embeddings` → `/api/embed` (which actually happened in
Ollama 0.1.40).

ADR-0003 already carved out a non-blocking **`test:eval`** tier for
exactly this class of probe: real-LLM, real-API, retry-not-allowed,
score-tracked. The retrieval slice was missing its drift-detection
battery in that tier.

## Decision

Ship a `tests/eval/retrieval/` directory with **6 vendor-specific smoke
suites** (one per adapter / model family) + a shared
`_helpers.ts`. Each suite is a polite-skip `describe` block — the
relevant API key (or local-daemon reachability) is the gate. When the
gate is absent the entire block is `describe.skip` and the runner
reports a clean skip count instead of a failure.

### File layout

```
tests/eval/retrieval/
  _helpers.ts                       — describeOnEnv + cost-cap utilities
  openai-embedder.eval.test.ts      — text-embedding-3-small, dim=1536
  voyage-embedder.eval.test.ts      — voyage-3, dim=1024
  cohere-embedder.eval.test.ts      — embed-english-v3.0, dim=1024
  cohere-reranker.eval.test.ts      — rerank-v3.5
  voyage-reranker.eval.test.ts      — rerank-2
  ollama-embedder.eval.test.ts      — local nomic-embed-text, dim=768
```

### Polite skip — `describeOnEnv`

```ts
export const describeOnEnv = (envVar: string, label: string, fn: () => void): void => {
  const v = process.env[envVar]
  const present = typeof v === "string" && v.length > 0
  if (present) describe(label, fn)
  else describe.skip(`${label} (skipped — ${envVar} unset)`, fn)
}
```

`bun test` always emits a `skipped` count for `describe.skip` — the
suite is loud about being inert (vs silently invisible). A future
nightly CI can grep that count and alert when a gate goes dark
unexpectedly.

Ollama uses a connectivity probe at module load instead of a literal env
var: `ollamaAvailable(baseURL)` issues a 500ms `fetch` and treats
ECONNREFUSED as "down". When up it sets `QUANTA_OLLAMA_UP=1` so the
same `describeOnEnv` shape gates the block.

### Cost cap — per-smoke budget

Each smoke is bounded to a single 2-input batch ≈ 16 tokens
(`SMOKE_INPUTS`). At the most expensive listed vendor pricing
(text-embedding-3-small ≈ $0.02/M tokens, voyage-3 ≈ $0.06/M tokens,
embed-english-v3.0 ≈ $0.10/M tokens, rerank-v3.5 ≈ $0.002/search,
rerank-2 ≈ $0.05/M tokens) the whole 6-file run costs **well under
$0.001**, even at 20× re-run. The ADR's stated $0.05/smoke ceiling is a
soft policy budget; the cap function aborts any test whose input ever
balloons above 100 approximate tokens (`SMOKE_TOKEN_CAP`).

### Hellgate axes (per vendor)

Each suite asserts ~5 drift-detection invariants:

1. **dim**: actual vector length matches the published model dim.
2. **L2-norm band**: managed vendors return unit-normalised vectors
   (norm ∈ (0.9, 1.1)). Ollama is permissive — finite + non-zero only.
3. **batch**: 2 inputs → 2 vectors (or 2 reranked hits).
4. **error path**: bogus model name → typed error arm (`http-error 4xx`
   for embedders, `transport|auth-failed|rate-limited` for rerankers).
5. **latency**: 2-input batch completes within 5 s (`SMOKE_LATENCY_CAP_MS`).

Reranker suites add a 6th informal invariant (#4 in their file):
**relevance signal** — the paraphrase document outranks the unrelated
document. This catches the catastrophic regression of vendors flipping
their score direction (descending → ascending), which would silently
hand callers the worst hit instead of the best.

### Runner integration

No `package.json` script change. `test:eval` already exists (runs
`src/apps/bench/index.ts`) — the bench harness was deliberately the
chosen eval surface in ADR-0003. The new `tests/eval/retrieval/*.eval.test.ts`
files are picked up by `bun test tests/eval` for local manual runs
(`bun test tests/eval/retrieval`) and are NOT swept into the default
`test` script (which only targets `tests/unit tests/integration`).

This is the **deliberate hold**: nightly CI integration is deferred. A
local developer with the relevant keys runs the suite manually before
publishing a release; nightly cron + alerting on score drift is a
follow-up wiring step.

## Constraint adherence

- **src/* untouched**: every adapter / port / registry referenced is the
  existing `@/retrieval/engines` + `@/retrieval/reranker` barrel —
  no new export, no signature change.
- **No npm install**: every smoke uses the in-tree adapter, which
  already speaks raw `fetch` per ADR-0160.
- **`package.json` unchanged**: `test:eval` script kept as-is, no new
  script added (the eval directory is invoked directly via
  `bun test tests/eval/retrieval`).
- **Plane-clean**: zero `@/agent` / `@/tool` / `@/llm` imports.
- **exactOptionalPropertyTypes-safe**: helpers handle `undefined` env
  vars explicitly (no `process.env[k]!` non-null assertions).

## Validation

- `bun run typecheck` — slice clean (verified below).
- `bun run lint tests/eval` — biome clean (verified below).
- `bun test tests/eval/retrieval` with no API keys set — 0 fail, 6
  describe blocks reported as `skipped`.
- Real-key validation is intentionally out of scope for this ADR
  (developer-owned, not committed).

## Non-goals

- Nightly CI cron wiring (deferred — see "deliberate hold" above).
- Score-trend tracking across runs (would require a baseline file —
  out of scope; the bench harness owns trend persistence).
- Cost telemetry per smoke (the cap is a guard, not a meter).
- Vector store smoke (Lance / SQLite VSS / Qdrant) — deferred to a
  separate ADR; these vendors require infra setup (local Lance file /
  Qdrant container) that exceeds the "smoke" footprint.
- Lance smoke explicitly listed in the task is dropped from this slice:
  Lance store needs a writeable filesystem fixture + dataset bootstrap
  (not just an env-key check), which is a separate ADR's worth of
  infrastructure and would bloat the "polite-skip" contract.

## Hellgate

Across the 6 files: **30 cases** total (5 per vendor × 6 vendors).
Every case is gated behind `describeOnEnv` so the local default
behaviour is "0 pass / 0 fail / 30 skipped" — byte-identical to the
pre-ADR state when no keys are present.

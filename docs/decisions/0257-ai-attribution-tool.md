# ADR-0257: AI-attribution tool — training-data attribution search MVP

- **Status**: Superseded (2026-06-04) — the `ai_attribution` tool was REMOVED.
  It was a pure orphan: built (factory + closed port + types) but registered in
  NO assembly path, with only a no-op `headlessStub` backend (no real
  `AIAttributionSearch` implementation), and a niche use case. The tool slice
  (`src/tool/ai_attribution.ts`, `src/tool/ai-attribution/`), its hellgate test,
  the tool-surface manifest row, and the feature-catalog entry were all deleted
  on 2026-06-04. Retained as historical record; the decision is reverted. See
  the `tool-surface-ssot` memory (jun-04 orphan resolution).
- **Date**: 2026-05-25
- **Related**: ADR-0127 (`web_*` cluster — caller-wired closed-port sibling),
  ADR-0130 (subagent-bg — caller-wired tools-trio pattern this slice mirrors),
  Cursor `CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION` (reference shape).
- **References**:
  `src/tool/ai-attribution/types.ts` (closed `License` + `SearchError` unions,
    `AttributionMatch`, `SearchOpts`, `SNIPPET_MAX_BYTES`),
  `src/tool/ai-attribution/port.ts` (closed `AIAttributionSearch` port),
  `src/tool/ai-attribution/headless-stub.ts` (deterministic FNV-1a stub +
    `applyFilters` helper),
  `src/tool/ai-attribution/index.ts` (barrel),
  `src/tool/ai_attribution.ts` (`defineTool`-based registration accepting an
    injected port),
  `tests/unit/tool/ai-attribution-hellgate.test.ts` (15 cases).

## Context

Cursor ships `CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION` — an in-IDE tool that
searches a code snippet against an external training-data / public-code
corpus and surfaces ranked matches with source + license + similarity. The
host wires the search adapter; the tool layer is plane-clean.

quanta has no equivalent today. The use case is two-fold:

1. **License-risk surfacing** — when the agent emits a non-trivial snippet,
   the user / host wants to know whether that snippet is substantively a
   copy of an OSS / proprietary source the resulting file would inherit
   license obligations from.
2. **Provenance trace** — when reading existing code, the model can ask
   for likely prior-art context (paper, repo, blog) without leaving the
   loop.

This ADR ships the slice primitive only:

- closed `AIAttributionSearch` port (`search(snippet, opts) → Result<…>`),
- deterministic headless stub (no network, hash-seeded matches),
- `ai_attribution` tool registered via `defineTool` accepting the port,
- 15-case hellgate sealing every closed-union arm + default-OFF posture.

Real search adapters (BigCode / Sourcegraph / GitHub Code Search) +
license enforcement gating (e.g. "refuse to write a GPL-3.0 match into an
MIT project") are deliberate follow-ups — the slice is shipped
**default-OFF byte-identical** so a session that does not opt in is
unchanged.

## Decision

### Slice layout

```
src/tool/ai-attribution/
  types.ts          — License (5-arm), SearchError (4-arm), AttributionMatch,
                      SearchOpts, SNIPPET_MAX_BYTES, anchor tuples
  port.ts           — AIAttributionSearch { search }
  headless-stub.ts  — deterministic FNV-1a stub + applyFilters helper
  index.ts          — barrel
src/tool/ai_attribution.ts
                    — defineTool wrapper accepting AIAttributionSearch port
```

### Types (`types.ts`)

```ts
export type License = "MIT" | "Apache-2.0" | "GPL-3.0" | "proprietary" | "unknown"

export interface AttributionMatch {
  readonly source: string
  readonly license: License
  readonly similarity: number    // [0, 1]
  readonly url?: string          // OPTIONAL — some sources have no fetchable URL
}

export interface SearchOpts {
  readonly minSimilarity?: number  // [0, 1]
  readonly maxResults?: number     // > 0
}

export type SearchError =
  | { kind: "empty-snippet" }
  | { kind: "snippet-too-large"; sizeBytes: number; maxBytes: number }
  | { kind: "search-failed"; cause: string }
  | { kind: "aborted" }

export const SNIPPET_MAX_BYTES = 10_000
```

Both unions ship with **anchor tuples** (`LICENSES`, `SEARCH_ERROR_KINDS`)
and in-file `satisfies` checks so a 5th arm is a compile error at the
anchor — the hellgate's HELL-AA-15 sorts the tuple to seal the runtime
ordering as well.

### Port (`port.ts`)

```ts
export interface SearchPortOpts extends SearchOpts {
  readonly signal?: AbortSignal
}

export interface AIAttributionSearch {
  search(snippet: string, opts?: SearchPortOpts):
    Promise<Result<AttributionMatch[], SearchError>>
}
```

`Result`-shaped (no thrown errors); a misbehaving network call becomes
`{ ok:false, error:{ kind:"search-failed", cause } }`. The wrapper
enforces byte-cap / empty / abort BEFORE invoking the adapter, so real
adapters only need to handle the actual search.

### Tool registration (`src/tool/ai_attribution.ts`)

`aiAttributionTool(port: AIAttributionSearch): Tool` —
`defineTool`-built, **read-only** + **concurrency-safe**, NOT part of
`buildDefaultTools` (caller-wired, same posture as `shadow_*`, `subagent_*`,
`mcp_*`). The tool:

1. validates the snippet locally (empty / > 10 KB) BEFORE calling the port,
2. propagates `ctx.signal` to `SearchPortOpts.signal`,
3. maps the closed `SearchError` arm-by-arm to a stable code-prefixed
   `output` (`empty-snippet: …` / `snippet-too-large: …` /
   `search-failed: …` / `aborted: …`),
4. defense-in-depth filters out-of-range `similarity` from a misbehaving
   adapter (HELL-AA-09).

### Headless stub (`headless-stub.ts`)

- FNV-1a-32 hash of the snippet seeds a 5-row base table (one per License
  arm). Same snippet ⇒ same matches (HELL-AA-07); different snippets get
  bounded jitter so scores differ without swapping order.
- Wrapper enforces every error arm so the hellgate can exercise
  `empty-snippet` / `snippet-too-large` / `aborted` without monkey-patching;
  `search-failed` is reachable via the factory's `failOnSnippet` option.
- `applyFilters(matches, opts)` is exported for reuse — a real adapter
  that returns unfiltered matches can compose it.

### Hellgate (15 cases)

| ID         | Seals                                                          |
|------------|----------------------------------------------------------------|
| HELL-AA-01 | snippet → AttributionMatch[]                                    |
| HELL-AA-02 | empty snippet → `Err("empty-snippet")`                          |
| HELL-AA-03 | snippet > 10 KB → `Err("snippet-too-large")`                    |
| HELL-AA-04 | `minSimilarity` filter — every kept row's score ≥ threshold     |
| HELL-AA-05 | `maxResults` cap                                                |
| HELL-AA-06 | adapter failure → `Err("search-failed", cause)`                 |
| HELL-AA-07 | determinism — same snippet ⇒ same matches                       |
| HELL-AA-08 | every License arm reachable (MIT/Apache-2.0/GPL-3.0/prop/unk)   |
| HELL-AA-09 | similarity ∈ [0, 1] enforced (adapter liars dropped)            |
| HELL-AA-10 | default-OFF — `ai_attribution` not in `buildDefaultTools()`     |
| HELL-AA-11 | URL optional — some rows have URL, some do not                   |
| HELL-AA-12 | results sorted by similarity DESC                                |
| HELL-AA-13 | 1000-snippet perf sanity (< 2 s on stub)                         |
| HELL-AA-14 | AbortSignal cancellation → `Err("aborted")`                      |
| HELL-AA-15 | SearchError 4-arm closed exhaustive (anchor tuple sealed)        |

## Consequences

**Positive**

- The slice primitive lands as a closed port with one deterministic stub
  and one DI factory — same shape as `shadow_*` / `subagent_*`, so the
  audit reflex transfers.
- The 4-arm `SearchError` + 5-arm `License` unions are CLOSED with
  literal anchors; a future widening fails at `tsc` (anchor) and at the
  hellgate (runtime expectation).
- Default-OFF: `src/tool/index.ts` is unchanged, the tool is NOT in
  `buildDefaultTools()`, so every existing session is byte-identical.
- The 10 KB snippet cap + UTF-8 byte accounting matches the existing
  conventions (web_fetch, document readers).

**Negative / accepted trade-offs**

- No real search adapter is shipped this round — the tool is wired only
  to the headless stub in tests. A composition root that instantiates
  `aiAttributionTool(headlessStub())` would surface deterministic fake
  matches; production adapters (BigCode / Sourcegraph / GitHub Code
  Search) are explicit deliberate-hold in the catalog entry.
- License enforcement (refuse to write a GPL-3.0 match into an MIT
  project, surface license-conflict to the user) is NOT in scope — this
  slice only retrieves attribution; gating is a separate ADR.
- `MUTATING_TOOL_TABLE` is NOT amended this round. The tool is read-only
  and caller-wired; a host that wires it MUST add the entry as part of
  its assembly (same posture as `shadow_*` / `subagent_*` whose entries
  were added when their composition root started registering them).

## Rejected alternatives

- **Add to `buildDefaultTools()`**. Violates RFC §1.2 byte-identical
  landing. A host that has no search adapter would either get a tool
  whose `search-failed` arm always fires (noise) or a global stub binding
  in a production build (wrong default).
- **Open SearchError union**. Lets adapters surface custom codes the tool
  cannot map. Closed-union forces every adapter to map into the small
  vocabulary the dispatch layer / UI can reason about.
- **Skip the headless stub** and require a real adapter to even run the
  tests. The hellgate needs deterministic input across `License` arms
  and `minSimilarity` / `maxResults` semantics — a real adapter would
  add network flakiness and a CI dep with no test ROI.

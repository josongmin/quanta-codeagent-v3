# ADR-0266: ModelTag versioning — cache + index invalidation when the embedder model changes

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0254 (retrieval cache surface this invalidator targets),
  ADR-0263 (embedder-index storage that must be rebuilt when the model
  generation bumps), ADR-0159 (the retrieval SOTA stack — multi-vendor
  embedding port this versioning rides on top of).
- **References**:
  `src/retrieval/versioning/types.ts` (typed `ModelTag`,
  `InvalidationDecision`, `ParseError`),
  `src/retrieval/versioning/port.ts` (closed `ModelTagger` +
  `Invalidator` ports),
  `src/retrieval/versioning/tag-codec.ts` (canonical
  `{provider}-{model}-v{version}-d{dim}` codec — tag / parse / escape),
  `src/retrieval/versioning/invalidator.ts` (default invalidator —
  provider / model / major-version / dim rules),
  `src/retrieval/versioning/registry-callbacks.ts` (callback registry
  for cache + store invalidation hooks),
  `src/retrieval/versioning/index.ts` (barrel),
  `tests/unit/retrieval/model-tag-hellgate.test.ts` (15 cases).

**ADR-number reconciliation.** Initially booked into the 0250..0266 range
before any collision was observed; landed at **0266** as the next-free
slot for this slice and to avoid the user-deference renumber dance with
parallel-track work. Catalog YAML, hellgate suite, and source headers all
reference 0266 atomically.

## Context

The retrieval slice (ADR-0159) embeds chunks / commits / arbitrary text
through a multi-vendor port. The embedder is swappable —
`openai/text-embedding-3-small` (d=1536), `voyage/voyage-3` (d=1024),
`cohere/embed-v3`, etc. Every cached vector and every persisted index
is **only valid for the exact model that produced it**. Cross-model
cosine similarity is meaningless; cross-dimension comparison is a type
error in disguise (the cache happily returns `length=1024` vectors to
a query embedded at `length=1536`).

quanta today does NOT tag stored vectors with the producing model. When
the user (or a config sweep, or a sticky-per-mode policy) changes the
embedder, the cache silently hands back stale vectors and the index
silently mixes generations. The user-visible symptom is "recall got
worse for no reason" — a class of bug that is unobservable without
tagging.

This ADR ships the slice primitive: a canonical model tag, a parse /
serialise codec with round-trip, a default invalidator with explicit
rules, and a callback registry that the cache / index layers hook to
flush themselves when a mismatch is detected. Wiring into a specific
cache or store is **deferred** to the consuming slice — this ADR is
purely the versioning + decision + notification primitive.

## Decision

### Slice layout

```
src/retrieval/versioning/
  types.ts                — ModelTag, InvalidationDecision, ParseError
  port.ts                 — ModelTagger { tag, parse }; Invalidator { check, invalidateAll }
  tag-codec.ts            — canonical {provider}-{model}-v{version}-d{dim} codec
  invalidator.ts          — default rules (provider / model / major version / dim)
  registry-callbacks.ts   — registerInvalidationCallback(cb)
  index.ts                — barrel
```

### Canonical format (`tag-codec.ts`)

```
{provider}-{model}-v{version}-d{dim}
```

Examples:

```
openai-text-embedding-3-small-v3-d1536
voyage-voyage-3-v1-d1024
cohere-embed-multilingual-v3.0-v3-d1024
```

The format is hyphen-delimited. Because model names themselves contain
hyphens (`text-embedding-3-small`), the codec parses **structurally**:

1. Split on `-`.
2. The last segment matches `^d(\d+)$` → `dim`.
3. The segment before it matches `^v(.+)$` → `version`.
4. The first segment is `provider`.
5. Everything between is the `model` (re-joined with `-`).

This means the model may contain any hyphens; the `v` / `d` prefixes
disambiguate the trailer. Special characters in provider / model
(whitespace, control chars, separators `-` `v` `d` at boundary
positions) are rejected at `tag()` time with a normalized error so
the canonical string is always round-trippable.

### Types (`types.ts`)

```ts
export interface ModelTag {
  readonly provider: string
  readonly model: string
  readonly version: string
  readonly dim: number
  readonly canonical: string
}

export interface InvalidationDecision {
  readonly stale: boolean
  readonly reason?: string
}

export type ParseError =
  | { kind: "malformed"; raw: string }
  | { kind: "missing-dim"; raw: string }
  | { kind: "missing-version"; raw: string }
  | { kind: "empty-field"; raw: string; field: "provider" | "model" }
```

`ParseError` is a closed 4-arm union so callers get exhaustive
`switch` coverage (hellgate HELL-MT-15).

### Port (`port.ts`)

```ts
export interface ModelTagger {
  tag(input: {
    provider: string
    model: string
    version: string
    dim: number
  }): ModelTag
  parse(canonical: string): Result<ModelTag, ParseError>
}

export interface InvalidationCallback {
  readonly name: string
  invalidate(reason: string): Promise<void>
}

export interface Invalidator {
  check(stored: ModelTag, current: ModelTag): InvalidationDecision
  invalidateAll(callbacks: ReadonlyArray<InvalidationCallback>): Promise<void>
}
```

### Default invalidator rules (`invalidator.ts`)

`check(stored, current)` returns `stale: true` if **any** of:

- `stored.provider !== current.provider` → different vendor entirely.
- `stored.model !== current.model` → same vendor, different model.
- `stored.dim !== current.dim` → dimension mismatch (hard fail — cosine
  is undefined across dims).
- `major(stored.version) !== major(current.version)` — major bump signals
  a breaking model change (semver-style). Minor bump is **not** stale
  (HELL-MT-08) to avoid flushing the cache on every model patch.

`invalidateAll(callbacks)` iterates the registered callbacks and calls
`invalidate(reason)`. **One callback throwing must not prevent the
others from running** (HELL-MT-12). Failures are collected and (in the
default impl) logged via a single `console.warn` so the OPS surface
can see them; the function itself never throws.

### Callback registry (`registry-callbacks.ts`)

A process-local list (default-OFF — if nothing is registered, the
invalidator becomes a no-op observer). The cache slice registers a
callback that drops its LRU; the index slice registers a callback that
deletes the persisted vectors and queues a re-embed. Neither callback
is constructed by this slice — that wiring is the consumer's
responsibility (ADR-0254 / ADR-0263 own those seams).

### Default-OFF byte-identical guarantee

If no `Invalidator` is constructed and no callback is registered, the
retrieval slice runs **byte-identical to pre-ADR**. The versioning
files are pure code — importing the barrel does nothing observable.
Only callers that explicitly compose `createDefaultInvalidator()` and
call `check` / `invalidateAll` see the new behaviour. OPS warn on
mismatch is also gated on this composition (otherwise the project has
no opinion on whether a mismatch is bad — caller decides).

## Consequences

**Positive**

- Cache + index can now refuse to return cross-model vectors instead of
  silently degrading recall.
- Canonical format is human-readable in logs / OTel attributes / on-disk
  state — no opaque IDs.
- Closed port + DI matches the rest of `@/retrieval` (Axes A–E).
- Tests are deterministic (`tag()` is pure; `parse()` is pure;
  invalidator decision is pure; only `invalidateAll` is async because
  the registered callbacks are I/O).

**Negative / accepted**

- `exactOptionalPropertyTypes` is intentionally omitted on
  `InvalidationDecision.reason` to keep the call-site ergonomic
  (`{ stale: false }` is valid without explicit `reason: undefined`).
- Major-version bump as the stale-trigger is a policy choice — a project
  that wants minor-bump invalidation can supply its own `Invalidator`
  implementation; the default is conservative.
- Provider-name validation is permissive (any non-empty string is
  accepted). A typo (`openai` vs `openAI`) will produce a mismatch and
  invalidate the cache — surface the typo via the canonical string in
  the warn log, do not block at parse time.

## Hellgate

`tests/unit/retrieval/model-tag-hellgate.test.ts` — 15 cases:

- HELL-MT-01: `tag(...)` produces the canonical string format.
- HELL-MT-02: `parse(tag(x).canonical)` round-trips to the same fields.
- HELL-MT-03: malformed input → `Err({ kind: "malformed" })`.
- HELL-MT-04: unknown / unusual provider names are accepted (allow-list
  is the consumer's choice — codec does not gatekeep providers).
- HELL-MT-05: different provider → stale.
- HELL-MT-06: different model → stale.
- HELL-MT-07: major version bump → stale.
- HELL-MT-08: minor version bump → NOT stale.
- HELL-MT-09: dimension mismatch → always stale.
- HELL-MT-10: every field equal → fresh.
- HELL-MT-11: `invalidateAll` calls every registered callback.
- HELL-MT-12: one callback throws, the others still run; the call does
  not throw.
- HELL-MT-13: canonical-format integrity — model names with hyphens
  round-trip; whitespace / control chars in provider or model are
  rejected at `tag()` time.
- HELL-MT-14: default-OFF byte-identical — nothing observable happens
  when no `Invalidator` and no callback are constructed.
- HELL-MT-15: `ParseError` 4-arm exhaustive (`malformed`,
  `missing-dim`, `missing-version`, `empty-field`).

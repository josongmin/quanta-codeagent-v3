# ADR-0260: LexicalSearch — BM25 + ripgrep pluggable retrieval engine

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0159 (retrieval slice — five-axis surface this engine plugs
  into), ADR-0163 (rerank/registry sibling — `bm25-secondary` reuses Lucene
  defaults but on the rerank axis, not as a first-stage index),
  ADR-0238 (Bun.spawn production-spawner idiom this slice mirrors for the
  ripgrep adapter).
- **References**:
  `src/retrieval/lexical/types.ts` (typed `LexicalHit`, `LexicalError`,
  `LexicalDegradeReason`),
  `src/retrieval/lexical/port.ts` (closed `LexicalSearch` port — `index` /
  `query` / `clear` / `size`),
  `src/retrieval/lexical/bm25-impl.ts` (pure BM25 with configurable k1 / b
  and a UTF-8 word-boundary tokenizer that includes CJK),
  `src/retrieval/lexical/ripgrep-impl.ts` (`rg --json` shell-out adapter
  with `grep` fallback),
  `src/retrieval/lexical/headless-stub.ts` (deterministic test adapter — no
  real spawn),
  `src/retrieval/lexical/index.ts` (barrel),
  `tests/unit/retrieval/lexical-hellgate.test.ts` (15 cases).

## Context

ADR-0159 ships the retrieval slice as five axes: chunk-bucket, embedders,
commit-embedder, rerank, hybrid-query. The hybrid-query axis already accepts
a `bm25Source` callback but the slice does NOT yet ship a first-stage
lexical engine — every caller has to bring their own (in-memory map, custom
ripgrep wrapper, etc.). The result is that bm25 sources are inconsistent:
one site tokenizes ASCII-only, another splits on whitespace, a third
shells out to ripgrep without a fallback.

Phase 7 wants a **single pluggable lexical engine** with two production
adapters (pure-BM25 for in-memory docs, ripgrep for on-disk corpora) so
every retrieval pipeline can wire one of them and get consistent scoring +
UTF-8 tokenization (including CJK / Korean) + a graceful degrade path when
`rg` is not on PATH.

This ADR ships the slice primitive: closed port + two production adapters
+ deterministic test stub + 15-case hellgate. Wiring into the
`hybrid-query` `bm25Source` slot and the composition root is deliberately
deferred (the catalog entry records the hold).

## Decision

### Slice layout

```
src/retrieval/lexical/
  types.ts         — LexicalHit, LexicalError (5-arm), LexicalDegradeReason
  port.ts          — LexicalSearch { index, query, clear, size }
  bm25-impl.ts     — pure BM25 (configurable k1/b) + UTF-8 tokenizer
  ripgrep-impl.ts  — rg --json shell-out adapter + grep fallback
  headless-stub.ts — deterministic test adapter (no spawn)
  index.ts         — barrel
```

The slice does NOT introduce a path alias; callers import from
`@/retrieval` (existing barrel) which re-exports the slice members.

### Types (`types.ts`)

```ts
export interface LexicalHit {
  readonly id: string
  readonly score: number
  readonly text: string
  readonly metadata?: Readonly<Record<string, string>>
}

export type LexicalError =
  | { kind: "no-search-binary"; detail: string }
  | { kind: "spawn-failed"; binary: "rg" | "grep"; detail: string }
  | { kind: "parse-failed"; binary: "rg" | "grep"; detail: string }
  | { kind: "invalid-query"; raw: string; reason: "empty" | "too-large" }
  | { kind: "aborted"; binary?: "rg" | "grep" }

export type LexicalDegradeReason = "rg-missing" | "grep-missing"
```

`LexicalError` is a **5-arm closed union**. New arms (if ever needed)
MUST update the `ALL_LEXICAL_ERROR_KINDS` tuple in `types.ts` so the
hellgate's exhaustive-switch test compile-fails until every consumer
covers the new arm.

### Port (`port.ts`)

```ts
export interface LexicalDoc {
  readonly id: string
  readonly text: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface LexicalQueryOptions {
  readonly signal?: AbortSignal
}

export interface LexicalIndexResult {
  readonly docs: number
  readonly tokens: number
  readonly degradeReason?: LexicalDegradeReason
}

export interface LexicalSearch {
  index(docs: ReadonlyArray<LexicalDoc>): Promise<Result<LexicalIndexResult, LexicalError>>
  query(q: string, k: number, opts?: LexicalQueryOptions):
    Promise<Result<ReadonlyArray<LexicalHit>, LexicalError>>
  clear(): void
  size(): number
}
```

`index` is async because the ripgrep adapter materialises an on-disk corpus
manifest; the BM25 adapter resolves synchronously-fast but still returns a
`Promise` so the two implementations are substitutable byte-for-byte.

`size()` is sync — every adapter knows its doc count without I/O (the
ripgrep adapter caches the indexed manifest).

### BM25 adapter (`bm25-impl.ts`)

- Pure JS, no shell-out. Suitable for in-memory corpora (loaded
  conversation transcripts, search-as-you-type widgets, test fixtures).
- BM25 with Lucene defaults (`k1 = 1.5`, `b = 0.75`), both configurable
  via factory options. Same `idf = ln(1 + (N - df + 0.5) / (df + 0.5))`
  smoothing as the sibling `rerank/bm25-secondary` so a corpus scored
  twice (first-stage + rerank) sees stable numbers.
- Tokenizer: UTF-8 word-boundary using `\p{L}\p{N}+` (Unicode property
  classes). This includes CJK / Korean / Cyrillic / Arabic letter runs in
  addition to ASCII — the existing `bm25-secondary` reranker is
  ASCII-only and is NOT changed (the reranker is a different axis and
  has its own tokenizer contract). Lowercased via `String#toLowerCase()`.
- Stable sort: score desc, then `byteCompare(id)` asc — same idiom as
  the rest of the slice so output is reproducible across hosts.

### Ripgrep adapter (`ripgrep-impl.ts`)

- Shell-out to `rg --json -e <query>` rooted at the indexed corpus
  directory. Each `--json` event is a single-line JSON object; the
  adapter parses the line stream and accumulates `match` events into
  `LexicalHit` records (one hit per file with `score = matchCount`).
- Special chars in the query are passed through `rg`'s `--fixed-strings`
  flag (`-F`) so regex metachars are taken literally — no shell escape
  required, no surprise patterns.
- The spawner is **injected** (`createRipgrepLexicalSearch({ spawner })`)
  so tests substitute a deterministic spawner without invoking real
  subprocesses. The bare factory wires a `Bun.spawn`-backed default
  (same pattern as `shell-snapshot/bun-spawner.ts`).
- Degrade order: `rg` first; if `spawn` throws `node-missing`-shaped
  error (ENOENT), fall back to `grep -F -r -c <query> <dir>`. If
  `grep` is also missing, the call resolves to
  `err({ kind: "no-search-binary", detail })`. The first call records
  the binary discovery into `degradeReason` of the next `index` result
  so observability can see the fallback once without re-probing every
  query.
- AbortSignal: pre-aborted → resolves with
  `{ kind: "aborted", binary: <chosen> }` without spawning. In-flight
  abort kills the process and resolves with the same shape.

### Headless stub (`headless-stub.ts`)

- Returns the closed `LexicalSearch` port with deterministic behaviour:
  - `index` resolves synchronously-fast and stores the docs in a
    `Map<string, LexicalDoc>` private to the stub instance.
  - `query` runs the same BM25 scoring as `bm25-impl` over the stored
    docs — so the stub's scoring matches the production BM25 adapter
    byte-for-byte (the hellgate cross-references the two).
  - Caller-injectable degrade reason + caller-injectable error so the
    hellgate can drive every arm of `LexicalError` without a real
    subprocess.
- Production callers MUST NOT wire this stub.

### Barrel (`index.ts`)

Re-exports the closed port, the two production factories
(`createBm25LexicalSearch`, `createRipgrepLexicalSearch`), the headless
stub factory, and the public types + `ALL_LEXICAL_ERROR_KINDS` tuple.
The top-level `@/retrieval` barrel re-exports these under their public
names so callers do not reach into `@/retrieval/lexical/*`.

## Consequences

**Positive**

- The slice primitive lands as a closed port with three adapters (two
  production, one stub) — same shape as `src/runtime/shell-snapshot/`
  and `src/runtime/node-repl/`, so the audit reflex is transferable.
- Tokenizer is UTF-8 word-boundary, so a CJK / Korean query indexes and
  retrieves correctly — the existing ASCII-only reranker tokenizer was
  a latent bug for non-Latin corpora.
- Ripgrep adapter degrades gracefully to `grep` when `rg` is missing;
  the `degradeReason` is surfaced on the FIRST `index` result so the
  caller can log it once instead of re-probing every query.
- Stub matches BM25 production scoring byte-for-byte — switching from
  stub to real adapter in tests reveals no scoring drift.

**Negative / accepted trade-offs**

- Query escaping uses `rg --fixed-strings` (literal match). Phrase /
  regex / boolean queries are NOT supported in this round — the caller
  must split a multi-token query at the tokenizer level if they want
  multi-term semantics. A future ADR can add a query DSL on top.
- The slice is shipped **default-OFF**. No `hybrid-query` consumer is
  pre-wired — composition-root wiring is a follow-up. Byte-identical
  landing per RFC §1.2.
- The headless stub re-implements BM25 scoring (mirror of `bm25-impl`)
  to keep the stub self-contained (no production import from a test
  fixture). The two implementations are kept in lock-step by a
  hellgate cross-reference (HELL-LX-01 round-trip + HELL-LX-13
  10k-doc performance sanity both run against both adapters).

## Rejected alternatives

- **Single adapter (BM25 only).** Lexical search on a large on-disk
  monorepo without ripgrep is unbearably slow; an in-memory BM25 is
  the wrong tool. We need both — the closed port is the seam that
  lets the caller pick per use-case.
- **No-degrade ripgrep adapter.** Failing hard when `rg` is absent
  breaks the CI image that ships without `ripgrep`. The degrade-to-grep
  path is one extra factory branch and recovers a real surface that
  would otherwise be dead.
- **Default-ON.** Violates RFC §1.2 byte-identical landing. The
  `hybrid-query` axis already works with caller-supplied
  `bm25Source` callbacks; wiring a default lexical engine into every
  pipeline without opt-in would change scoring numbers across the
  codebase in a single PR — too much surface for one ADR.
- **Reuse `rerank/bm25-secondary` as the engine.** The reranker scores
  a candidate set; the engine indexes a corpus. Different axes,
  different APIs. The two implementations share BM25 formula but the
  tokenizer differs (the reranker is ASCII-only and is NOT changed in
  this round).

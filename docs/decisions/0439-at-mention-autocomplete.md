# ADR-0439 — CLI `@`-mention autocomplete dropdown (input-surface wire)

**Status:** Accepted (2026-06-02)
**RFC:** `docs/plans/jun-2-misc/12-at-mention-autocomplete.md`
**Extends:** ADR-0418 (async 5-kind mention parser/resolver) + ADR-0422/0423
(mention wire-up into the agent loop). NO supersede: the mention parser,
resolver port, and `mentionInjector` consumption (`loop.ts:1036`) are
UNCHANGED. This ADR adds an INPUT-SURFACE affordance only — a CLI dropdown
that helps the user TYPE a correct `@target`; the existing submit-time
parse+resolve+inject path round-trips the inserted text byte-for-byte.
**Slices:** `src/apps/cli/at-autocomplete/` (new leaf: `port` / `provider` /
`file-list` / `symbol-list` / `fuzzy` / `state-machine` / `env` / `index`) +
`src/apps/cli/raw-line-reader.ts` (`@`-keypress integration, default-OFF) +
`src/apps/cli/repl/prompt-pipeline.ts` + `repl/surface-compose.ts` +
`repl/session-loop.ts` + `repl.ts` (wire) + two hellgate batteries.

## Context

The mention BACKEND was already complete and already consumed by the agent
loop: a user who hand-types `@src/foo.ts` and submits gets it resolved +
injected today (RFC §2.1). The only gap was the INPUT surface — the CLI
`raw-line-reader` had autocomplete for `/` slash commands only
(`buf.startsWith("/")`), with no `@`-trigger.

Two concrete holes (RFC §2.3):

1. **No `@`-trigger dropdown** in `raw-line-reader.ts`.
2. **No way to ENUMERATE candidates.** The existing `MentionResolverPort` is
   `target → body` one-directional; it cannot list candidates from a partial
   query. A NEW listing port was required.

## Decision

### New `AtCandidateProvider` listing port (orthogonal to resolve)

`src/apps/cli/at-autocomplete/port.ts` defines `AtCandidate` (`kind`,
`insertText` (sigil-bearing), `label`, `detail?`, `score?`) and
`AtCandidateProvider.list(query, signal) → Promise<readonly AtCandidate[]>`.
Async (file glob / LSP I/O), NO-THROW, cancellable. The resolve port is
untouched.

### Per-kind adapters reuse existing backends

- **file** (`file-list.ts`): a prefix-directory `fs.readdir` walk (NOT a full
  recursive scan), jailed with the SAME `is-path-inside` + symlink-canonicalise
  idiom as `createFileResolver` / `fs-jail-lib`. `fileRoot` == the resolver
  root, so listed candidates are exactly the ones the resolver can later read.
- **symbol** (`symbol-list.ts`): reuses the EXISTING `SymbolLookupLspPort`
  (`createLspSymbolLookup` over LSP `workspaceSymbol`). The wire shares the SAME
  lazy union-LSP port the agent loop's `@symbol` resolver uses
  (`buildMentionSymbolDeps`) — one installed language server lights both
  surfaces.
- **skill / plugin / app**: OPTIONAL injected `list*` callbacks. Those
  registries expose `lookup` but no `list()` today, so absent ⇒ that kind is
  graceful-empty. Wiring them is a one-line change when a registry `list()`
  lands. (Honest scope: file is live; symbol is live when an LSP server is
  installed; the kebab kinds await a registry `list()`.)

`createCompositeAtProvider` (`provider.ts`) infers the kind from the query
shape mirroring the parser cascade (`/`→file, uppercase→symbol,
lowercase→kebab+file probe) and merges per-kind results.

### Deterministic 2-tier ranking — NO new heuristic

`fuzzy.ts` ranks by `(tier, originalIndex)` where tier 0 = prefix match,
tier 1 = substring match — the SAME `startsWith`-then-stable idiom the slash
palette uses (`slash-engine.ts:44`), extended with a conservative substring
fallback. No weighted score is invented (`no-heuristics-only-validated`).

### Pure keypress state machine

`state-machine.ts` is a PURE module (left-boundary check, char/backspace
classification, selection nav, accept-edit). `raw-line-reader.ts` owns only
the impure parts (async `list()` with an `atQueryEpoch` stale-guard, redraw,
buffer splice). The dropdown renders kind-grouped below the prompt, reusing the
existing reserved-band / scroll-stability machinery + `stringColumns` CJK width.

### Default-OFF byte-identical

`readLine` gains `atProvider?`. Absent ⇒ `@` is an ordinary input char and
EVERY keypress path is byte-identical (proven by the §7-12 regression anchor:
identical stdout bytes + result with vs without a provider for non-`@` input
AND for the slash palette). The env gate `QUANTA_AT_AUTOCOMPLETE=1` (read off
the injected `env` in `buildPromptUx`, no `process.*` in the build helper per
ADR-0297) is the only thing that constructs + injects a provider.

## Consequences

- The mention backend (parser/resolver/injector) is mutated by ZERO bytes.
- A test-only `ReadLineTestIO` seam drives an injected keypress stream so the
  integration is provable without a real TTY/fs/LSP.
- `@path:line` line-suffix parsing (RFC §4.7) is deferred — it requires a
  parser change under ADR-0418's lock and a separate ADR.
- MCP-resource mentions are out of scope (outside the 5-kind enum).

## Negative invariants

- No DOM overlay / inline-chip tokenisation (webview-only; TTY keeps raw
  `@target` text).
- No new fuzzy scorer; ranking is prefix→substring deterministic only.
- `@` and `/` stay independent triggers, byte-identical isolated.

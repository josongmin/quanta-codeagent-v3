# ADR-0423 — Production `@symbol`: deterministic LSP anchor synthesis + semantic wire

**Status:** Accepted (2026-05-29)
**Extends:** ADR-0422 (mention wire-up: `@symbol` adapters + DRY builder +
CLI/host-runtime injector). This closes ADR-0422's two honest holes — the LSP
adapter had no anchor at config-assembly time, and the semantic strategy was
not wired at the assemble/CLI layer — so production `@Symbol` is now WIRED at
both call sites (graceful-null without an installed language server / a
populated index) instead of being unconditionally `null` by construction. NO
supersede: ADR-0418's
ports + ADR-0422's adapters/builder are unchanged; this only adds an anchor
synthesizer, a union LSP lookup, a host-composition deps builder, and fills
the two existing `buildDefaultMentionResolver` call sites.
**Slices:**
`src/agent/lsp-bridge.ts` (`LSP_SUPPORTED_EXTENSIONS` + `lspExtensionToLanguage`
exports off the single `SERVERS` table) +
`src/agent/mention-injection/` (`anchor-synth` synthesizer + `symbol-lookup-lsp`
`createUnionLspSymbolLookup` + `index` barrel) +
`src/host/runtime/internal/mention-symbol-deps.ts` (host-composition deps
builder) + the two existing call sites (`apps/agent/assemble.ts`,
`host/runtime/internal/mention-wire.ts`) + three hellgate batteries.

## Context

ADR-0422 wired the env → builder → composite → `mentionInjector` path and
shipped two graceful-null `@symbol` adapters, but documented two honest holes:

1. **No LSP anchor.** `createLspSymbolLookup` needs an anchor file (the nav
   provider selects pyright / typescript by the file's extension), and ADR-0422
   refused to *guess* one ("no heuristic scan"). With no anchor the adapter
   short-circuited to `null`, so production LSP `@symbol` never fired.
2. **Semantic not wired.** A freshly-built index would be empty and return
   misleading misses, so the semantic strategy was left for callers to thread.

So production `@Symbol` was always `null` — the deliberate hold.

## Decision

### 1. Deterministic LSP anchor synthesizer (no heuristics)

`src/agent/lsp-bridge.ts` exports the single source of truth off the existing
`SERVERS` table: `LSP_SUPPORTED_EXTENSIONS` (the lowercase extensions) and
`lspExtensionToLanguage()` (extension → server *binary*, so the extensions one
server handles — typescript: `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` — collapse
to one key). Adding a language stays a one-line `SERVERS` edit (OCP).

`synthesizeLspAnchors({ cwd, extensionToLanguage, lister, maxEntries? })`
(`mention-injection/anchor-synth.ts`) applies a **fully deterministic rule**:

> Walk the workspace rooted at `cwd` **breadth-first**. At each directory read
> its entries and **sort them lexicographically** (`<` on the raw name). The
> **first file** encountered in that order whose lowercase extension maps to a
> language becomes **that language's anchor**; later files of the same language
> are ignored. Files in a directory are examined before its subdirectories are
> descended, so a shallower file always out-ranks a deeper one. Each supported
> language *present* in the workspace yields exactly one anchor.

No scores, no thresholds. The walk early-exits once every distinct language has
an anchor; `maxEntries` (default 50_000) is a hard NO-THROW backstop that only
*bounds* work — it never changes which anchor a tree yields below the bound. A
`readdir` rejection on any subtree is swallowed (skip it); a total failure
yields `[]`. The directory lister is an injected port (`AnchorDirLister`) so the
core is hermetic in tests and `node:fs`-free.

### 2. Union LSP lookup

`createUnionLspSymbolLookup({ provider, cwd, anchorFiles, maxHits? })`
(`symbol-lookup-lsp.ts`) builds one `createLspSymbolLookup` per synthesized
anchor and **merges** their `workspaceSymbol(name)` hits, deduped by first
occurrence, in `anchorFiles` order. A multi-language repo (`.ts` + `.py`) thus
probes both language servers under a single `@symbol` lookup. Each per-anchor
port keeps the ADR-0422 NO-THROW / always-stop-session contract, so a thrown /
`null` anchor simply contributes nothing. Empty across all anchors ⇒ `null`.

### 3. Host-composition deps builder

`buildMentionSymbolDeps(cwd, env, seams?)`
(`src/host/runtime/internal/mention-symbol-deps.ts`) lives at the host
composition root (the layer permitted to compose BOTH the agent-slice
`lsp-bridge` engine AND the `@/runner/assemble` semantic backend). It returns the
two SymbolLookup ports:

- **LSP** — `synthesizeLspAnchors` (over a `node:fs` lister) → union lookup over
  `lspNavProvider()`.
- **semantic** — `selectIndexEmbedder(env)` + `buildSemanticBackend(env, embed)`
  (the SAME embedder + backend the search pipeline uses) →
  `createSemanticSymbolLookup`.

Both are **lazy + synchronous**: `assembleAgentConfig` / `installCliMentionInjector`
are synchronous, so the builder returns ports *synchronously*; the fs walk and
backend build run on the **first** `findSymbol` (memoized for the port's
lifetime), riding the already-async `findSymbol` signature. Config assembly stays
sync and zero-cost when no `@symbol` is ever mentioned.
`QUANTA_MENTION_SYMBOL=off` short-circuits to `{}` (no ports). NO-THROW: any
build failure degrades that strategy to a port answering `null`.

### 4. Both call sites filled

`apps/agent/assemble.ts` `mentionResolverDep` and
`host/runtime/internal/mention-wire.ts` `installCliMentionInjector` now spread
`...buildMentionSymbolDeps(cwd, env)` into `buildDefaultMentionResolver`, so
both `lsp` and `semantic` deps are present (previously only an anchor-less LSP
adapter that always returned `null`). Priority stays `auto` (LSP first, semantic
fallback).

## Consequences

- Production `@Symbol` is now WIRED: given a supported source file (anchor
  synthesized) + an installed language server it returns LSP hits; otherwise it
  falls back to the semantic index (when populated via `QUANTA_INDEX`). In a
  fresh checkout with no language server installed and an empty index it still
  resolves `null` — the wire is present, the backing data is not (see residual).
- **Honest residual:** LSP hits still require an installed `pyright` /
  `typescript-language-server` (graceful-null without one — unprovable in CI,
  hence the fake-provider tests); the semantic strategy only hits once the index
  has entries; `@skill` is still wired only by callers that thread a registry.
- Byte-identical preserved: zero-mention input and `QUANTA_MENTION_SYMBOL=off`
  inject nothing; `@file` / `@skill` paths are untouched.

## Tests

- `mention-injection/__tests__/anchor-synth.hellgate.test.ts` (14 — `.ts`-only /
  `.py`-only / both / none / multi-ext collapse / lexicographic determinism /
  breadth-first / NO-THROW readdir / maxEntries backstop, fake fs tree)
- `mention-injection/__tests__/symbol-lookup-lsp.hellgate.test.ts` (+7 union —
  empty anchors / fan + merge across languages / one-miss-one-hit / dedup / all
  miss / throwing anchor; 20 total)
- `host/runtime/internal/__tests__/mention-symbol-deps.hellgate.test.ts` (11 —
  real temp workspace + fake LspNavProvider for the LSP path, REAL `@/runner`
  in-memory semantic backend for the semantic path, `auto` fallback,
  `=off` byte-identical, NO-THROW, full production-wire end-to-end proof)

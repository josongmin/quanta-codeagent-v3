# ADR-0422 — Mention wire-up: `@symbol` adapters + DRY builder + CLI/host-runtime injector

**Status:** Accepted (2026-05-29)
**Extends:** ADR-0418 (async 5-kind mention resolver + `@file`/`@symbol`
ports). This is the production wire-up that closes ADR-0418's
`deliberate_hold` (env → DI → composite → `mentionInjector`, plus the
`@symbol` adapters over `lsp-bridge` / `search-index-backend`). NO supersede:
ADR-0418's ports + logic are unchanged; this only adds adapters, a shared
builder, and the surface wires.
**Slices:**
`src/agent/mention-injection/` (`symbol-lookup-lsp` + `symbol-lookup-semantic`
adapters, `index` barrel) +
`src/agent/mention-runner/` (`default-resolver` shared builder, `index`
barrel) +
`src/apps/agent/assemble.ts` (`mentionResolverDep` → builder) +
`src/host/runtime/internal/` (`mention-wire` leaf + `context-binding`
`buildAgentConfigFromBase` call) + the four hellgate batteries.

## Context

ADR-0418 shipped the async 5-kind mention slice default-OFF with three holes
called out in its `deliberate_hold`:

1. **`@symbol` had no backends.** `createSymbolResolver` consumes two injected
   ports (`SymbolLookupLspPort` / `SymbolLookupSemanticPort`) but no adapter
   existed over the real engines (`@/agent/lsp-bridge`'s nav provider /
   `@/runner/assemble/search-index-backend`).
2. **`@skill` was unwired** in the production composite (the `skills` dep was
   omitted, so `@skill` resolved `null`).
3. **The CLI REPL never reached the wire.** Only the unified-agent
   `apps/agent` interactive surface (via `assembleAgentConfig` →
   `mentionResolverDep`) got `@file`; the CLI REPL flows through the host
   runtime (`buildAgentConfigFromBase`) and `src/runner/assemble/config.ts`,
   which has no `mentionInjector` slot.

## Decision

### 1. Two `SymbolLookup` adapters (port/adapter, graceful-null)

- **`createLspSymbolLookup({ provider, cwd, anchorFile?, maxHits? })`** —
  adapts an `LspNavProvider` (`lspNavProvider()` from `@/agent/lsp-bridge`,
  which knows pyright / typescript-language-server) into `SymbolLookupLspPort`.
  Symbol lookup = `session.workspaceSymbol(name)`. The nav provider resolves a
  session BY FILE (extension → server), so the adapter opens against an
  injected **anchor file**; with no anchor it returns `null` (no heuristic
  scan to guess one). `NavSymbolInfo` → `SymbolHit` (`range.start.line + 1`
  for the 1-indexed line; `containerName`/`kind` fold into the snippet). The
  session is ALWAYS stopped in a `finally`.
- **`createSemanticSymbolLookup({ index, embed, topK? })`** — adapts a
  vector index (`SemanticBackend.port` shape) + an embed fn into
  `SymbolLookupSemanticPort`. Lookup = embed the name → query the index →
  project each hit's `metadata.path`/`metadata.startLine`. Hits without a
  usable path are dropped; all-dropped ⇒ `null`. Declares its `SemanticQueryPort`
  / `SemanticSearchHitLike` shapes LOCALLY so the agent slice does not import
  `@/retrieval` — the composition root passes the concrete backend in.

Both are NO-THROW: unavailable / throw / reject / miss ⇒ `null`.

### 2. DRY builder `buildDefaultMentionResolver`

`src/agent/mention-runner/default-resolver.ts`:

```
buildDefaultMentionResolver({ cwd, env, skills?, lsp?, semantic? }): MentionResolverPort
```

Reads the `QUANTA_MENTION_*` env (all **default-ON**; `=off` per kind), then
composes `createCompositeMentionResolver`:

| kind     | env knob               | dep                         | omit behaviour          |
|----------|------------------------|-----------------------------|-------------------------|
| `@file`  | `QUANTA_MENTION_FILE`  | `cwd` (always available)    | knob `=off` ⇒ skipped   |
| `@symbol`| `QUANTA_MENTION_SYMBOL`| `lsp` and/or `semantic` port| no port ⇒ kind not wired|
| `@skill` | `QUANTA_MENTION_SKILL` | `SkillRegistryReadOnly`     | no registry ⇒ null      |

File caps (`QUANTA_MENTION_FILE_MAX_BYTES` / `_TAIL_RATIO`) + symbol strategy
(`QUANTA_MENTION_SYMBOL_RESOLVER`) + timeout (`_TIMEOUT_MS`) map onto the
sub-resolver knobs. **Graceful omit** is the central invariant: a kind whose
dep is absent is simply not attached — never a regression. With every knob
`=off` (or every dep absent) the composite answers `null` for every mention,
so the loop injects nothing (byte-identical to the legacy 3-kind path).

### 3. Surface wires (DRY — both share the builder)

- **`apps/agent/assemble.ts`** — `mentionResolverDep(cwd)` now calls the
  builder with the LSP symbol adapter wired (graceful-null until a language
  server + anchor are present). `@skill` is omitted (no read-only registry at
  config-assembly time; the per-turn inventory is built inside the loop).
- **CLI REPL / host runtime** — a new `src/host/runtime/internal/mention-wire.ts`
  exposes `installCliMentionInjector(cfg)`, called from
  `buildAgentConfigFromBase` for BOTH the turnAssembler and direct-spread
  paths. It builds the same composite and threads it through
  `installCodexR2Wires(cfg, { mentionResolver })` — which is idempotent and
  caller-override-precedence, so a surface that already wired mention is left
  byte-identical.

## Consequences

- `@file` + `@symbol` now work on the CLI (the primary surface) and every
  host-runtime surface; `@symbol` activates the moment a language server +
  anchor (LSP) or a populated index (semantic) is threaded in.
- **Honest holes (documented, not faked):** the LSP adapter has no anchor at
  config-assembly time, so `@symbol` LSP is graceful-null until a surface
  supplies one (no heuristic scan). The semantic adapter is NOT wired at the
  assemble/CLI layer because a freshly-built index would be empty and return
  misleading misses; it is wired by any caller that threads a populated
  `SemanticBackend.port` into the builder. `@skill` is omitted at the
  assemble/CLI layer for the same reason (no read-only registry there).
- Default-OFF preserved: every kind is independently env-gated and every knob
  defaults ON, but the GRACEFUL-OMIT contract means absent deps never inject —
  zero-mention input and all-off env are both byte-identical to the legacy
  path.

## Tests

- `mention-injection/__tests__/symbol-lookup-lsp.hellgate.test.ts` (13)
- `mention-injection/__tests__/symbol-lookup-semantic.hellgate.test.ts` (12)
- `mention-runner/__tests__/default-resolver.hellgate.test.ts` (17 — env 3×3,
  graceful omit, byte-identical all-off, file caps, symbol strategy)
- `host/runtime/internal/__tests__/mention-wire.hellgate.test.ts` (9 —
  attached / override-precedence / mention-free `[]` / `@file` injects /
  all-off injects nothing / NO-THROW)

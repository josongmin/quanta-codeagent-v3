# RFC — Syntax-aware (tree-sitter) chunking + in-file outline/skeleton read

> Status: PROPOSED (design only — no source changed by this RFC)
> Date: 2026-06-06
> Slice: `src/retrieval/indexer/` (new sibling variant) + `src/code-parser/` (NEW) + `src/tool/read/` (outline mode)
> Default posture: OFF (byte-identical chunking + byte-identical `read` when the knobs are unset)
> Feature axis: code-structure (one parser serves BOTH the indexer chunker and the outline read)

---

## 1. 요약

Two features, ONE underlying primitive. quanta's retrieval indexer chunks files with a **pure line-window slicer** (`src/retrieval/indexer/chunker.ts`, ADR-0277: `windowLines=50`, `overlapLines=20`) — it splits a 120-line function across three chunks mid-body, so a retrieved chunk routinely begins `  return acc + …` with no signature, no class context. And the `read` tool (`src/tool/read/index.ts`) can only return a **contiguous line range** — to understand a 2000-line file the model must either read all 2000 lines (token-expensive) or guess offsets blind. Both gaps share a root cause: quanta has **no self-contained syntactic view of source**. This RFC proposes a small `CodeParserPort` backed by **`web-tree-sitter` (WASM, zero native build)** that powers (a) a default-OFF **syntax-aware chunker** that aligns chunks to function/class/method boundaries (slots BEHIND the existing `chunkFile`/`FileChunk` contract, byte-identical when off), and (b) a **`read … outline:true`** mode that returns a COLLAPSED signatures+structure view (bodies elided, `// …` indicators) sized to a token budget — "read a 2000-line file for a fraction of the tokens." Both reuse the same parse. Both default-OFF, both NO-THROW with a line-window / raw-text fallback.

---

## 2. 경쟁사 레퍼런스 (verified evidence)

### 2.1 Cursor 3.5.33 — `@anysphere/tree-chunk-napi` (verified, round-2 absorption audit)

Cursor bundles a native module `@anysphere/tree-chunk-napi` exposing:

- **`ChunkerRouter({ maxSize }).parseFile(path, basename, contents) → FileTree`** then **`.chunk(minLines, maxLines) → Chunk[]`**. The chunks are aligned to **AST node boundaries** — the router walks the tree-sitter parse and cuts at declaration nodes (`function`, `class`, `method`, `interface`, `lexical_declaration`), **never** splitting a function mid-body. Small adjacent siblings merge up toward `maxLines`; an oversized single node (a 400-line function) is split internally but only as a last resort.
- **`CompressedFileOutline`** — fields `prefix` / `suffix` / `inner` / `trailingIndicator`. A COLLAPSED file view: the signature lines are kept (`prefix`/`suffix` around a declaration), the body becomes `inner` elided to a `trailingIndicator` (`// …`). Sized to a `maxSize` budget so a huge file collapses to its skeleton.
- **`PartialFileContext`** — a budget-sized partial view of a file built from the same outline machinery (the read-side primitive).

**What it does (summary):** ONE tree-sitter parse drives both the index-time chunker (AST-aligned chunks) and the read-time outline (collapsed signatures). This RFC adopts both in spirit. The KEY divergence is the **parser dependency** (§3.4 / §4.1): Cursor uses a **native napi** module; quanta should use **WASM** (`web-tree-sitter`) to preserve its zero-native-dep multi-surface portability posture.

### 2.2 Codex / Claude Code — outline analogues (context, not copied)

- Codex `apply_patch` V4A context hunks and Claude Code's file reads both lean on contiguous ranges; neither ships a self-contained AST chunker in the on-disk corpus we audited. The signatures-only "outline" pattern is also what an LSP `textDocument/documentSymbol` produces — but that requires a **running language server** (see §3.3): quanta's `lsp_document_symbol` already does this for languages with an installed server. The candidate here is **dependency-light and self-contained** (a bundled WASM grammar, no server spawn), which is why it complements rather than duplicates LSP.

---

## 3. 현재 quanta 상태 (grep-verified — RE-AUDIT)

### 3.1 Syntax-aware chunking — ABSENT (confirmed)

- `grep -rniE "tree.?sitter|web-tree-sitter|@anysphere|tree-chunk|syntax.*chunk" src/ package.json` → **ZERO matches**. No tree-sitter dependency, no WASM grammar, nothing vendored (`ls node_modules/web-tree-sitter` → not present).
- `src/retrieval/indexer/chunker.ts` (read in full): a **pure line-window slicer**. `chunkFile(input, opts)` splits `input.text` on `\n`, emits `windowLines`-sized windows (default 50) with `overlapLines` overlap (default 20). **ZERO syntax awareness** — it has no notion of a function, never inspects token content, cuts purely on line index. Header comment is explicit: "Pure line-window chunker (ADR-0277)."
- `src/retrieval/chunk-bucket.ts` (read in full): a **token-budget re-chunker** (`rechunk(text, {bucket})`) that walks the byte stream asking an injected `TokenizerPort.count` for prefix sizes (DPR/RAG sliding window). Also **byte/token-based, zero syntax awareness** — it cuts on token count, not AST.
- The indexer **port already anticipates this**: `src/retrieval/indexer/port.ts` names a **"future LSP-symbol chunker"** as an intended concrete impl behind the `CodebaseIndexer`/`FileChunk` contract. The seam to slot a syntax-aware variant behind the existing `FileChunk` contract is already designed.

**Verdict: syntax-aware chunking is NOT built. Both chunkers are line/token-based.**

### 3.2 In-file outline / skeleton read — ABSENT (confirmed, with one nuance)

- `src/tool/read/index.ts` (read in full): the `read` tool returns a **line-numbered contiguous slice** only — `path` + optional `offset` (1-based start line) + `limit` (line count, default 2000), rendered by `renderReadOk` as `<n>\t<line>`. It has notebook (`.ipynb`) cell rendering and H9 dedup, but **NO outline/skeleton/signatures-only mode**. `grep -rniE "outline|skeleton|CompressedFileOutline|signatures.?only|collapsed.*file|PartialFileContext" src/` (excluding LSP, below) → no in-file collapse primitive.
- `src/tool/file-tree-summary/` is **directory-level** (a ranked file tree with per-file purpose/noise annotation) — NOT an in-file signatures view. Confirmed: it summarizes which files exist, not what's inside one file. Different axis.

**Verdict: in-file outline read is NOT built.**

### 3.3 The ONE nuance — `lsp_document_symbol` (a RUNTIME tool, not this)

quanta HAS `src/tool/lsp_nav/` exposing `lsp_document_symbol` (`index.ts:348`), backed by `src/lsp/` adapters (`typescript.ts`/`pyright.ts`) that **spawn a real external language server** via `Bun.spawn` (`src/lsp/adapters/base.ts:644`) and call `textDocument/documentSymbol`. This produces a document outline (`src/lsp/types.ts:57` "document outline"; `src/lsp/ports.ts:41` `documentSymbol`). It is genuinely an outline — BUT it is categorically different from the candidate, and **does not make this RFC redundant**:

| | `lsp_document_symbol` (exists) | This RFC (proposed) |
|---|---|---|
| Backing | spawns an **external LSP server** (tsserver/pyright must be installed) | **self-contained WASM grammar**, no spawn, no install |
| Surface | a model-facing **nav tool** returning a symbol LIST (name/kind/range) | (a) index-time **chunker** + (b) a **collapsed-text read** view |
| Output | structured symbol info, no source text | actual source skeleton (signatures + `// …` bodies), budget-sized |
| Languages | only where a server is installed & wired | any bundled grammar, offline, deterministic |
| Determinism | server-version dependent | pinned grammar `.wasm` → deterministic |

`lsp_document_symbol` gives a symbol index when a heavy server is available; it does NOT chunk the corpus and does NOT return a token-budgeted collapsed-text view of a file with zero external dependency. The two are complementary (the RFC can even reuse the LSP `SymbolInfo` *shape* for its outline node type — §4.3). **No part of this RFC is already built.**

### 3.4 Dependency posture (the honest cost)

- **Nothing vendored.** No tree-sitter / WASM grammar is in `package.json` or `node_modules`. The dependency is the **main cost of this RFC** and is weighed in §4.1 / §8.
- quanta's posture is **zero-native-build portability** across surfaces (CLI / Web-Tauri / CLI-embedded browser — see memory `surface-model`). A napi module (Cursor's choice) would add a per-platform native build + a prebuild-or-compile step that breaks the Web-Tauri / WASM-target surface. This is the decisive constraint behind the §4.1 recommendation.

---

## 4. 설계

### 4.1 Parser dependency decision (the key open question) — RECOMMEND `web-tree-sitter` (WASM)

**Recommendation: `web-tree-sitter` (the official tree-sitter WASM runtime) + per-language grammar `.wasm` files, lazy-loaded. NOT a napi module.**

| Option | Build | Multi-surface | Determinism | Size | Verdict |
|---|---|---|---|---|---|
| `web-tree-sitter` (WASM) | **none** (pure WASM, runs in Bun + browser/Tauri) | **all surfaces** (CLI, Web-Tauri, embedded browser) | pinned `.wasm` ⇒ deterministic | runtime ~1 MB + ~0.2–0.5 MB/grammar | **RECOMMENDED** |
| `tree-sitter` napi (Cursor's `@anysphere/tree-chunk-napi`) | per-platform native build / prebuild | CLI only — **breaks Web-Tauri/WASM** | native-version dependent | smaller per grammar | rejected (portability) |
| vendoring `@anysphere/tree-chunk-napi` | as above + a 3rd-party native blob | as above | opaque vendored binary | n/a | rejected (closed binary + native) |

Justification against quanta's portability posture: the WASM runtime executes identically under Bun (CLI) and inside a Tauri webview / embedded browser — **one artifact, every surface**, no platform matrix, no postinstall compile. A napi module would force a native build that the Web-Tauri surface cannot run, violating the multi-surface invariant (memory `surface-model`: do NOT gate absorption ROI on surface availability — so the parser must work on ALL surfaces). The size cost (runtime + grammars) is mitigated by lazy-load (below).

**Languages (Phase 1):** `typescript`, `tsx`, `javascript`, `python`, `rust`, `go`, `bash`. These cover quanta's own corpus (TS) + the common agent-edited languages. Grammar `.wasm` files are **vendored under `vendor/tree-sitter-wasm/<lang>.wasm`** (NOT npm-installed at runtime), pinned by sha for determinism, and the dep `web-tree-sitter` is the only new `package.json` entry. **Lazy-load:** a grammar `.wasm` is loaded on first parse of a file with that extension (a `Map<lang, Promise<Language>>` cache) — a session that never touches Rust never loads the Rust grammar. **Total disk:** runtime ~1 MB + 7 grammars ≈ 2–3.5 MB vendored, loaded on demand. This is the honest cost; §8 weighs it.

**Language detection** is by extension only (`.ts/.tsx/.js/.jsx/.py/.rs/.go/.sh`), a pure closed table. Unknown extension ⇒ no grammar ⇒ fallback (NO-THROW).

### 4.2 `CodeParserPort` (closed-port contract)

The parser sits behind a narrow port so unit tests inject a fake (no real WASM in unit tests) and the WASM init cost stays out of the test path.

```ts
// src/code-parser/types.ts
export type ParseLang = "typescript" | "tsx" | "javascript" | "python" | "rust" | "go" | "bash"

/** A declaration node lifted out of the AST. 1-based inclusive line bounds —
 *  matches FileChunk + the editor convention. `kind` mirrors the LSP
 *  SymbolKind vocabulary (src/lsp/types.ts) so the outline node type is
 *  shared with lsp_document_symbol downstream. */
export interface DeclNode {
  readonly kind: "function" | "method" | "class" | "interface" | "type" | "enum" | "const" | "other"
  readonly name: string
  readonly startLine: number      // 1-based inclusive
  readonly endLine: number        // 1-based inclusive
  readonly signatureEndLine: number // last line of the signature/header (body starts after)
  readonly children: readonly DeclNode[] // nested decls (methods in a class, etc.)
}

export interface ParsedFile {
  readonly lang: ParseLang
  readonly decls: readonly DeclNode[] // top-level declarations, recursively populated
}

export type ParseOutcome =
  | { readonly ok: true; readonly parsed: ParsedFile }
  | { readonly ok: false; readonly reason: "no-grammar" | "parse-error" } // ⇒ caller falls back, NO-THROW

export interface CodeParserPort {
  /** Detect lang by `path` extension, parse `text`, return the declaration
   *  tree — OR a typed `no-grammar`/`parse-error` so the caller falls back to
   *  the line-window. NEVER throws past this boundary. Pure for a fixed
   *  grammar set + input (no clock, no randomness). */
  parse(path: string, text: string): Promise<ParseOutcome>
}
```

- **Default impl** `createTreeSitterParser()` (`src/code-parser/tree-sitter.ts`) wraps `web-tree-sitter`: lazy-load grammar by ext, walk the tree collecting declaration nodes (named-node query per language: a small per-lang capture list of the node types §2.1 enumerates), map to `DeclNode`. A parse that produces an `ERROR` node at the root ⇒ `{ok:false, reason:"parse-error"}` (the chunker/outline fall back). Determinism: the grammar `.wasm` is pinned; the walk is a deterministic pre-order traversal; **no `Date.now`/`Math.random`** anywhere.
- **Test fake** `fakeParser(table)` returns a canned `ParsedFile` for a given text — unit tests for the chunker and outline never touch real WASM. This mirrors the closed-port DI memory records for image-gen/lsp adapters (`InjectedClient` canned-response pattern, `src/lsp/adapters/base.ts:1162`).

### 4.3 Syntax-aware chunker (slots BEHIND `chunkFile`/`FileChunk`)

A NEW variant `chunkFileSyntactic(input, parsed, opts) → readonly FileChunk[]` in `src/retrieval/indexer/chunker-syntactic.ts`, returning the **same `FileChunk` shape** (`path/startLine/endLine/text/mtime/sha`) as `chunkFile`. The indexer chooses the variant at scan time based on the knob + parse outcome; downstream (corpus, upsert, retrieval) is **untouched** because the contract is identical.

**Algorithm (deterministic, line-bound):**

1. The indexer reads the file, then `await parser.parse(path, text)`.
2. **`{ok:false}` (no grammar / parse error / non-code) ⇒ FALL BACK to `chunkFile(input, opts)`** — byte-identical to today. This is the NO-THROW safety net and the default for every non-supported file.
3. `{ok:true}` ⇒ walk `parsed.decls` in source order. Maintain a running chunk accumulator over **whole declaration units**:
   - **Merge tiny siblings:** consecutive top-level decls whose combined line span `≤ maxLines` (default ~`maxLinesPerChunk` = 80) are merged into one chunk (so a file of 30 one-line `const` exports is one chunk, not 30). Gap lines between merged decls (imports, blank lines) are absorbed into the chunk that follows, never orphaned.
   - **Whole-unit chunk:** a decl whose span `≤ maxLines` becomes exactly one chunk — `startLine = decl.startLine`, `endLine = decl.endLine`. **A function is NEVER split** (the core invariant).
   - **Split oversized node:** a decl whose span `> maxLinesSplit` (default ~150) is split — but split at its **children** boundaries first (a 400-line class splits into per-method chunks, each method whole), and only if a single LEAF method still exceeds `maxLinesSplit` do we fall to a line-window split of that one method's body (last resort, signalled). The signature line is repeated as a 1-line prefix on each body-split chunk so context survives.
   - **Pre/inter-decl text** (file header comments, top-level statements between decls) is attached to the adjacent chunk; nothing is dropped — the union of all chunk line ranges covers `[1, lineCount]` (a coverage invariant the hellgate asserts).
4. Line numbers stay 1-based inclusive; `mtime`/`sha` copied from `input`, identical to `chunkFile`.

**Knob:** `QUANTA_SYNTAX_CHUNK` (`=== "1"`, strict opt-in, default false) → `RuntimeConfig.syntaxChunk: boolean`. OFF ⇒ the indexer calls `chunkFile` exactly as today, **byte-identical retrieval**, the parser is never constructed, no WASM loaded. (Same strict-`"1"` posture as `readDedup`/`imageGen`, `runtime-config.ts:76,226`.)

### 4.4 Outline read mode (reuses the SAME parse)

A `read` tool **`outline:true`** flag (preferred over a separate `read_outline` tool — keeps the surface count flat and the path/jail/guard pipeline shared) that returns a **collapsed signatures+structure view** instead of a contiguous slice.

```ts
// schema addition (src/tool/read/index.ts)
outline: z.boolean().optional().describe("Return a collapsed signatures+structure view instead of raw lines"),
outlineBudget: z.number().int().positive().optional().describe("Max chars for the outline (default ~4000)"),
```

**Render (`renderOutline(text, parsed, budget)` — pure, in a new `src/tool/read/outline.ts`):**

- For each top-level `DeclNode` (recursively): emit lines `[decl.startLine .. decl.signatureEndLine]` verbatim (the signature/header), then a single **`  // … (<N> lines)`** trailing indicator in place of `[signatureEndLine+1 .. endLine]` (the body), then recurse into `children` (a class emits its `class Foo {` line, each method's signature, `// …` per method body, then `}`). This is the `prefix` + `inner`-elided + `trailingIndicator` shape from Cursor's `CompressedFileOutline` (§2.1).
- **Budget cap:** accumulate chars; when the running size would exceed `outlineBudget`, stop and append `// … (<K> more declarations elided)`. Deterministic (source order, no ranking heuristic — honest per memory `no-heuristics-only-validated`).
- **Surrogate-safe:** the elision counts/truncation operate on whole lines (split on `\n`), never mid-code-unit and never mid-surrogate-pair (no slicing inside a `\uD800`–`\uDBFF` lead surrogate) — the hellgate asserts a lone surrogate in a string literal does not corrupt the output.
- **Fallback:** `outline:true` but `parser.parse` returns `{ok:false}` (no grammar / parse error / binary already rejected upstream) ⇒ the outline gracefully degrades to a **normal line-range read** (the existing `renderReadOk`), with a one-line note `(no outline: unsupported language; showing first N lines)`. NO-THROW.

**Token value:** a 2000-line TS file with 40 functions collapses to ~40 signatures + 40 `// …` markers ≈ a few hundred lines / a fraction of the tokens — the "read a 2000-line file for a fraction of the tokens" primitive. The model then `read`s the ONE function it needs by the line range the outline shows.

**Default posture:** `outline` is an OPT-IN flag — `read` with no `outline` is **byte-identical** to today (the schema flag defaults `undefined`; the entire outline path is skipped, the parser never constructed). Gated additionally by `QUANTA_SYNTAX_CHUNK` OR a dedicated `QUANTA_READ_OUTLINE` knob so the WASM dep is never loaded unless the operator opts in — when neither knob is set, `outline:true` returns the graceful line-range fallback (no parser).

### 4.5 Closed-port / determinism summary

- The `CodeParserPort` is injected into BOTH the indexer (via `IndexerOptions.parser?`) and the `read` tool (`makeReadTool(fs, parser?)`) — default `undefined` ⇒ feature off ⇒ existing behavior. Tests inject `fakeParser`; **no real WASM in unit tests**.
- No `Date.now` / `Math.random` in the parser, chunker, or outline (memory discipline `no-heuristics-only-validated`). Grammar `.wasm` pinned by sha. Pre-order traversal + source-order emission ⇒ same input ⇒ byte-identical output.

---

## 5. 통합

### 5.1 Config knobs (default-OFF, byte-identical)

- `syntaxChunk: boolean` ← `QUANTA_SYNTAX_CHUNK === "1"` (strict). Default false ⇒ indexer uses `chunkFile`; parser never constructed.
- `readOutline: boolean` ← `QUANTA_READ_OUTLINE === "1"` (strict). Default false ⇒ `read outline:true` returns the line-range fallback; parser never constructed.
- OFF ⇒ composition root injects `parser: undefined` into both the indexer and `read`; **the default tool menu, every existing tool's behavior, the chunker output, and on-disk corpus are byte-identical** — proven by §6 cases.

### 5.2 Slice placement + fence

- NEW slice `src/code-parser/` (`types.ts`, `tree-sitter.ts`, `index.ts`). Fence: `@/code-parser` imports **only** `node:*` + `web-tree-sitter` + `@/shared` (runtime-config for the grammar dir override). It imports NO `@/agent`/`@/tool`/`@/retrieval`/`@/permission`.
- Per the slice-import discipline (memory `jun-05-canvas-artifact-store`): register `@/code-parser` in `tsconfig.base.json` `paths` (explicit list — REQUIRED or the alias silently no-ops in tests, memory `may-25-adr-0159-0163-sprint`), add it to the `@/retrieval`- and `@/tool`-reachable allowlist in `biome.json` `noRestrictedImports`, and add an arch-scan ratchet so `src/code-parser/**` may import only `node:*`/`web-tree-sitter`/`@/shared`.
- `src/retrieval/indexer/chunker-syntactic.ts` lives in the existing indexer slice (no new fence). `src/tool/read/outline.ts` lives in the existing read tool.

### 5.3 Tools + tool-surface manifest

- `read` stays a single BASE tool; the `outline`/`outlineBudget` params are additive. NO new GATED manifest entry needed (the flag is inert when the knob is off) — but the tool-surface drift guard test is updated to assert the new optional params don't change the BASE surface count.
- (Alternative, if a discrete tool is preferred for discoverability: a GATED `read_outline` entry `gate:{kind:"config-slot", slot:"readOutline", env:"QUANTA_READ_OUTLINE"} default:{} risk:"read-only"`. RECOMMENDED to start with the `read` flag — fewer tools, shared pipeline.)

### 5.4 Feature-catalog entry

`tools/feature-catalog/features/04-retrieval/syntax-aware-chunking.yaml` (+ a cross-ref under `02-tool-system` for the read-outline facet): `maturity:L2` (seam) → `L3` once the indexer + read are wired, `labels:[category:retrieval, category:read, default-off]`, `depends_on:[codebase-indexer, read-tool]`, `config_refs.env:[QUANTA_SYNTAX_CHUNK, QUANTA_READ_OUTLINE]`, `config_refs.runtime:[syntaxChunk, readOutline]`, evidence.code listing the new `src/code-parser/**`, `chunker-syntactic.ts`, `outline.ts`, the vendored grammar dir, and the manifest/runtime-config touches.

### 5.5 Grammar vendoring

`vendor/tree-sitter-wasm/<lang>.wasm` (7 files), each pinned by a sha recorded in `vendor/tree-sitter-wasm/SHASUMS`. A `QUANTA_TREE_SITTER_DIR` override (`runtime-config`) lets a packaging step relocate them. `.gitignore` does NOT exclude them (they are the dependency); they are committed (small, pinned). Loaded lazily by the parser.

---

## 6. 테스트 계획

### 6.1 Hellgate (adversarial) — `tests/unit/syntax-chunk-hellgate.test.ts`

All via `fakeParser` (canned `ParsedFile`) — no real WASM:

- **never-split-a-function:** fixture with 3 functions + 1 class (4 methods) → assert EVERY emitted chunk's `[startLine,endLine]` is the EXACT span of one whole decl (or a clean merge of small siblings); assert NO chunk starts inside a function body (the first non-blank line of each chunk is a signature or a merged-sibling boundary).
- **oversized-node split:** a single 400-line function (parser reports one decl, no children) → split at `maxLinesSplit`, each split chunk carries the repeated signature prefix; the LEAF-method last-resort line-window split is signalled, never silent.
- **tiny-sibling merge:** 30 one-line `const` exports → ONE chunk (≤ maxLines), not 30. A blank-line / import gap between decls is absorbed, never orphaned.
- **coverage invariant:** the union of all chunk line ranges == `[1, lineCount]` (nothing dropped, header comments attached).
- **non-code / unknown-lang fallback:** `parser.parse` → `{ok:false, reason:"no-grammar"}` (a `.md`/`.json` file) ⇒ output is **byte-identical to `chunkFile`** (assert equality against the pure line-window result). NO-THROW.
- **parse-error fallback:** `{ok:false, reason:"parse-error"}` ⇒ same line-window fallback, NO-THROW.
- **default-OFF byte-identical:** `syntaxChunk=false` ⇒ the indexer's emitted `FileChunk[]` is `===`-equal (deep) to the line-window result for a corpus of mixed files; the parser is never constructed (assert `fakeParser.parse` call count == 0).
- **determinism:** same input ⇒ identical chunk array across two runs; grep the impl for `Date.now`/`Math.random` (none).

### 6.2 Outline hellgate — `tests/unit/read-outline-hellgate.test.ts`

- **elides bodies, keeps signatures:** a fixture file + canned `ParsedFile` → output contains every signature line verbatim and a `// … (<N> lines)` indicator for each body; assert NO body line leaks into the outline.
- **nested decls:** a class with 4 methods → `class Foo {` + 4 method signatures each with `// …` + closing `}`, recursively.
- **budget cap:** `outlineBudget` smaller than the full outline ⇒ output is `≤ budget` chars and ends with `// … (<K> more declarations elided)`; deterministic source-order cut (no ranking).
- **surrogate-safe:** a string literal containing a lone surrogate / emoji on a signature line ⇒ output is well-formed (no mid-surrogate slice, no replacement-char corruption); elision is whole-line.
- **fallback to line-range:** `outline:true` with `{ok:false}` (unknown lang) OR with the `readOutline` knob OFF ⇒ output is the normal `renderReadOk` line-range read + the `(no outline: …)` note. NO-THROW.
- **default-OFF byte-identical:** `read` WITHOUT `outline` (knob on OR off) ⇒ `ToolResult` byte-identical to today's read; parser never constructed.
- **budget zero / 1-line file / empty file:** boundary inputs produce a well-defined small/empty outline, no throw.

### 6.3 Parser adapter test (real-WASM, separate, NOT in the unit gate)

A SEPARATE `tests/integration/code-parser-wasm.test.ts` (tagged, not in the fast unit run) loads ONE real grammar (`typescript`) and asserts a known fixture parses to the expected `DeclNode` tree — the only place real WASM is touched, so the unit suite stays WASM-free and fast.

---

## 7. 단계

- **Phase 1 — parser slice (default-OFF seam).** `src/code-parser/{types,tree-sitter,index}.ts` (`CodeParserPort` + `web-tree-sitter` impl + lazy grammar load + `fakeParser`), vendor the 7 grammar `.wasm` + SHASUMS, `tsconfig.base.json` alias + biome fence + arch-scan ratchet, runtime-config knobs, integration parser test §6.3, feature-catalog yaml. NO indexer/read change yet. Pure seam, fully isolated. **This is where the new dep lands.**
- **Phase 2 — syntax-aware chunker.** `chunker-syntactic.ts` + `IndexerOptions.parser?` wiring + the `QUANTA_SYNTAX_CHUNK`-gated variant selection in the default scanner; hellgate §6.1. Byte-identical when off.
- **Phase 3 — outline read.** `outline.ts` + `read` `outline`/`outlineBudget` params + `makeReadTool(fs, parser?)` + `QUANTA_READ_OUTLINE` gate; hellgate §6.2; tool-surface drift-guard update.
- **Phase 4 — corpus tuning + more languages.** Tune `maxLines`/`maxLinesSplit` against the real corpus (measure, don't guess — memory `no-heuristics-only-validated`); add grammars (java/c/cpp/json-with-comments) as demand appears.

---

## 8. 리스크 / 대안 / 비결정

- **The dependency is the main cost (honest).** `web-tree-sitter` runtime (~1 MB) + 7 vendored grammars (~2–2.5 MB) ≈ 2–3.5 MB committed, plus the WASM init cost (a few ms per grammar, once, lazily) on the FIRST parse of each language. This is real weight for a default-OFF feature. **Mitigation:** WASM only loads when a knob is ON and a supported file is parsed; OFF sessions pay ZERO (no construct, no load, no disk read). Weigh against the ROI: AST-aligned chunks materially improve retrieval precision (no mid-function chunks) and the outline read is a large per-call token saving on big files. **Recommendation stands: ship the seam (Phase 1) so the dep + grammars are vetted in isolation, gate the consumers, measure retrieval-precision + token-saving deltas before defaulting on.**
- **WASM vs napi (decided — §4.1).** napi (Cursor's path) is smaller per grammar and slightly faster but requires a per-platform native build that **breaks the Web-Tauri / embedded-browser surface** — a hard violation of quanta's multi-surface portability invariant. WASM is the lower-friction, all-surface path. Revisit ONLY if profiling shows the WASM parse is a measured bottleneck on the indexer hot path (unlikely — parsing is amortized across a scan and gated off by default).
- **Overlap with `lsp_document_symbol` (analysed — §3.3).** They are complementary, not duplicative: LSP needs a spawned server + install, returns symbols-not-text, is version-nondeterministic; this is self-contained, returns budget-sized collapsed TEXT, deterministic, offline. The outline node type deliberately **reuses the LSP `SymbolKind` vocabulary** (`src/lsp/types.ts`) so a future unification (outline backed by LSP when a server is up, by WASM otherwise) is a clean swap behind `CodeParserPort`. No reason to block one on the other.
- **Grammar drift / parse errors.** A grammar that mis-parses a newer language feature ⇒ `{ok:false, reason:"parse-error"}` ⇒ line-window fallback. The feature **degrades to today's behavior**, never worse, never a throw. Grammars pinned by sha so an upgrade is an explicit, reviewable change.
- **`maxLines` / `maxLinesSplit` defaults (80 / 150) are guesses.** Per memory `no-heuristics-only-validated`, these are KNOBS, not baked thresholds, and Phase 4 tunes them against the measured corpus (chunk-size distribution + retrieval precision) — NOT shipped as a defended default until measured.
- **`read outline` vs `read_outline` tool (undecided default).** Lean `read … outline:true` (flat surface, shared jail/guard/dedup pipeline). Switch to a discrete `read_outline` GATED tool only if discoverability data shows the model under-uses the flag. Either way the rendering core (`outline.ts`) is identical.

---

## 9. 코드 위치 요약

**Create:**
- `src/code-parser/types.ts` — `CodeParserPort`, `ParseLang`, `DeclNode`, `ParsedFile`, `ParseOutcome`.
- `src/code-parser/tree-sitter.ts` — `createTreeSitterParser()` (web-tree-sitter, lazy grammar load) + `fakeParser` test seam.
- `src/code-parser/index.ts` — barrel.
- `src/retrieval/indexer/chunker-syntactic.ts` — `chunkFileSyntactic` (merge/whole-unit/split, NO-THROW fallback to `chunkFile`).
- `src/tool/read/outline.ts` — `renderOutline` (collapsed signatures + `// …` + budget cap, surrogate-safe).
- `vendor/tree-sitter-wasm/<lang>.wasm` ×7 + `vendor/tree-sitter-wasm/SHASUMS`.
- `tools/feature-catalog/features/04-retrieval/syntax-aware-chunking.yaml`.
- `tests/unit/syntax-chunk-hellgate.test.ts`, `tests/unit/read-outline-hellgate.test.ts`, `tests/integration/code-parser-wasm.test.ts`.

**Touch:**
- `package.json` — add `web-tree-sitter` (the ONE new dep; this RFC proposes, does NOT install it).
- `src/shared/runtime-config.ts` — `syntaxChunk` / `readOutline` (+ `treeSitterDir` override) env parse.
- `src/retrieval/indexer/types.ts` + `port.ts` — `IndexerOptions.parser?: CodeParserPort` (the seam the port already anticipates: "future LSP-symbol chunker").
- `src/retrieval/indexer/default-scanner.ts` — knob-gated variant selection (`chunkFileSyntactic` vs `chunkFile`).
- `src/tool/read/index.ts` — `makeReadTool(fs, parser?)`, `outline`/`outlineBudget` schema params, outline branch.
- `tsconfig.base.json` — `@/code-parser` path alias (REQUIRED — silent test no-op otherwise).
- `biome.json` — `@/code-parser` in the `@/retrieval`/`@/tool`-reachable allowlist + arch-scan ratchet for `src/code-parser/**`.
- `src/tool/surface/manifest.ts` — drift-guard test update for the new optional `read` params (no surface-count change).

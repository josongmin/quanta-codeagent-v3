# ADR-0028 — `apply_patch` V4A format + deterministic fuzzy match

- **Status**: Accepted
- **Date**: 2026-05-21
- **Phase**: SOTA++ Codex absorption — patch grammar layer
- **Related**: RFC-0001 §9 (code modification surfaces), ADR-0019 (edit-strategy hint + `scripted_replace`), [[codex-v4a-patch-grammar]], [[codex-feature-catalog-2026-05-21]] §8

## Context

ADR-0019 introduced `edit` (exact + opt-in fuzzy) and `scripted_replace`
(literal/regex substring) as our code-modification surfaces, plus a
strategy hint that nudges the LLM to switch tools on context mismatch.
Both tools operate on a SINGLE file per call and serialize multi-file
changes as a stream of independent calls — fine for small edits, brittle
for cross-file refactors (rename + edit + delete obsolete companion).

Codex's `apply_patch` tool (analyzed in [[codex-v4a-patch-grammar]] and
[[codex-feature-catalog-2026-05-21]] §8) ships a self-contained V4A
("Versioned 4-Add-Delete-Update") diff format that:

1. Bundles `Add` / `Delete` / `Update` ops into one atomic call.
2. Adds a `*** Move to:` directive that atomically renames + edits.
3. Uses `@@ <context>` anchors instead of line numbers — robust against
   the LLM miscounting offsets.
4. Carries an explicit `*** End of File` marker so trailing-hunk position
   is unambiguous.

The format is the wire schema Codex uses to talk to its own model and
the model is heavily trained on emitting it. Absorbing the grammar gives
quanta-v3 LLM-compatibility with that training distribution while
keeping our own toolchain.

## Decision

Add a dedicated `src/patch/` slice that owns V4A parsing and
application, with these public exports:

```
parsePatch(text)                         -> Patch
applyPatch(patch, FileSystemPort)        -> ApplyResult
PatchParseError | PatchApplyError | PatchAnchorNotFoundError
```

Internal structure (vertical slice, single responsibility per file):

- `types.ts` — discriminated `PatchOp` union, line-prefix and sentinel
  constants (single source of truth, NO magic strings elsewhere), named
  error classes.
- `parser.ts` — pure `text -> Patch` line-by-line state machine. Any
  grammar violation throws `PatchParseError` with the offending 1-based
  line number. No best-effort recovery.
- `applier.ts` — pure `Patch + FileSystemPort -> ApplyResult`. Filesystem
  side effects go through the injected port (testable in-memory).
- `index.ts` — public barrel.

### Fuzzy match algorithm (deterministic, two-tier)

For each Update hunk we compute `oldBlock` = (context ∪ delete) lines
and search the target file:

1. **Tier A — exact**: line-by-line equality across the whole file.
2. **Tier B — whitespace-tolerant**: each line `.trim()`-compared, both
   sides. Only accepted if a UNIQUE position matches.

The `*** End of File` marker constrains the search to the single
trailing-aligned position. Multiple hits at the same tier ⇒
`PatchApplyError` ("ambiguous context"). Zero hits at both tiers ⇒
`PatchAnchorNotFoundError`. The two error classes are distinct so the
agent can react to anchor failures specifically (e.g. re-read file and
regenerate hunk vs. "add more context").

### Atomic Move-to semantics

`*** Move to:` is rejected by the parser if it appears outside an
`Update File` op or after any hunk content. The applier pre-flights:
both the source must exist and the destination must NOT — otherwise
`PatchApplyError` BEFORE any disk write. The actual move writes the
patched content to the destination, then deletes the source; any
intermediate failure is rethrown with full context (no swallow, no
graceful degradation).

### Pre-flight error semantics — no silent fallback

Every error path throws a typed exception. There is no graceful
degradation, no best-effort partial apply, no swallowed error inside
`try/catch`. Multi-step apply (Move-to write + source delete) is the
only window where a multi-call failure can occur and it propagates a
`PatchApplyError` describing exactly which half completed.

## Rationale

- **Why V4A over unified diff**: line-number-anchored unified diffs are
  fragile because the model frequently miscounts. V4A's `@@ <context>`
  + content-based fuzzy locate is empirically more robust ([[codex-v4a-
  patch-grammar]] §검증 규칙).
- **Why a self-contained implementation, no crate dependency**: the
  format is ~150 LOC of TS, our toolchain is Bun + TS only (`verify-
  workflow`), and shipping a third-party diff library to handle a
  grammar this small would be over-engineering. The codex reference
  implementation lives in Rust (`core/src/apply_patch.rs`) and isn't
  reusable from Bun.
- **Why a separate `src/patch/` slice instead of folding into
  `src/tool/edit`**: V4A is a wire format, not an edit strategy. Keeping
  it independent means it can serve `apply_patch` tool (future), be
  used by tests / fixtures, and stay free of `@/storage` /
  permission-jail concerns until the tool wrapper plugs it in.
- **Why a `FileSystemPort` port**: keeps the applier pure-testable. Real
  integration (with `@/storage` FS jail) lives in the tool wrapper to
  be added separately.
- **Why deterministic two-tier fuzzy (not edit-distance heuristic)**:
  per RFC §9 and AGENTS rule "no 어쩌면 이게 맞을 듯 heuristics" — a
  trimmed-equality + uniqueness rule is deterministic and explainable.
  Edit-distance opens "good enough" failure modes the model can't
  verify.

## Trade-offs

- We do NOT support `Environment ID` from the EBNF — Codex uses it for
  multi-environment routing; quanta-v3 runs single-environment. Adding
  later is non-breaking.
- The applier does NOT optimize for huge files (line-by-line scan).
  Acceptable: real patches are small and target files are typically
  source files (≤ tens of KB). If this becomes a hot path we'd add a
  prefix-table index.
- Whitespace-tolerant Tier B replaces with the patch's literal lines —
  so applying a patch with no leading whitespace to an indented region
  STRIPS the original indentation on those lines. Documented; matches
  Codex behavior. Callers wanting indentation preservation should emit
  context lines with the file's original whitespace.

## Alternatives considered

1. **Extend `editTool` with a multi-op array input** — rejected: would
   conflate the V4A wire format (the model emits it as one giant string)
   with the JSON tool argument shape, and we'd lose `@@`-anchor parsing.
2. **Use a unified-diff parser library (e.g. `diff` npm package)** —
   rejected: V4A is incompatible with unified diff (different headers,
   `*** Move to` extension, EOF marker), and we want zero new runtime
   deps.
3. **Ship the Rust crate via wasm/native bridge** — rejected: massive
   build complexity for a 150-LOC grammar.

## Verification

- `tsc --noEmit` — clean.
- `biome check src/patch tests/unit/patch` — clean.
- `bun test tests/unit/patch` — three suites (parser / applier in-memory
  / integration on tmpdir), happy-path × edge × error coverage at parity.

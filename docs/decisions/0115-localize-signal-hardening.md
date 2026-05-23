# ADR-0115 — Localize tool: SOTA++ signal hardening (BM25-lite + FrameTier + def-boost)

- **Status**: Accepted (R-Phase9, <DATE>)
- **Related**: ADR-0084 (speculative branch search — also cites Agentless §3/§4), [[R-Phase7]] (3-stage funnel + Agentless absorption), [[R-Phase8]] (`FrameTier` added to `parse_test_failure`, NOT to `localize` — this ADR closes that gap), `src/skill/system-skills/localize-fault/SKILL.md`, [[no-heuristics-only-validated]]
- **References**: Agentless (Xia et al., 2024) — file→function→edit funnel + lexical retrieval baseline; BM25 (Robertson & Zaragoza, *The Probabilistic Relevance Framework: BM25 and Beyond*, 2009) — IDF formula; Codex `may-20-codex-signal.md` — signal trust hierarchy (source 10/10 > log 8/9 > rg 5/10) preserved unchanged.

## Context

`localize` is the Stage-1 candidate generator in the Agentless funnel that R-Phase7 absorbed and R-Phase8 hardened on the `parse_test_failure` side. Auditing the tool against the same discipline R-Phase8 applied to its sibling exposed three concrete signal gaps that the prior shape could not close on its own:

- **(a) flat term-count scoring.** `scoreHit` was `hit.terms.size * 10 + nameBonus` — every distinct token on a line contributed the same 10 points regardless of how common that token was across the tree. Queries that named the bug in plain English (`"main entrypoint cli"`, `"this fails when the config is missing"`) got dominated by lines containing `this` / `what` / `main` — common-English saturation outranked the rare, discriminating term. The flat weight is structurally unable to express "rare term > common term", which is what every lexical IR baseline since the 1970s computes via IDF.
- **(b) naïve identifier split.** `tokenize` used `[a-z0-9_]+` and then lower-cased — `validateUserInput` became one opaque token. `tool-search.ts` had already implemented the correct subtoken split (camelCase / snake / kebab / `mcp__`) and the symmetry argument was visible: same repo, same query language, same retrieval problem, two different splitters. A query for `"validateUserInput"` did not match `validate_user_input` and vice versa.
- **(c) no frame-tier penalty.** R-Phase8 introduced `FrameTier` (user > test > vendored) for `parse_test_failure` precisely because vendored frames are noise for fault localization — the edit goes in user code. `localize` had nothing equivalent. `node_modules/main.js` could outrank `src/apps/cli/index.ts` on the query `"main entrypoint cli"` purely on term-hit count, undoing the symmetry R-Phase8 just installed.

Cite the symmetry argument directly: same repo, same discipline. R-Phase8 was byte-identical-friendly because `parse_test_failure` is a pure parser whose tier-order change only affected the *ranking* of frames already present. `localize` is the same shape — a ranker over candidates already gathered — and the same discipline applies.

## Decision

Six structural enhancements to `src/tool/localize/index.ts`, layered on top of the existing read-only / concurrency-safe / jail-respecting shell:

1. **camelCase / snake / kebab subtoken split.** Replace the local `[a-z0-9_]+` `tokenize` with the same routine used by `tool-search.ts` (camel→space, then non-alphanumeric split, lowercased, deduped, length ≥ 3). `validateUserInput` now yields `[validate, user, input]`. Applied symmetrically to query and (implicitly via per-token rg) to identifiers in the tree.
2. **`FrameTier` penalty.** Import `classifyFrame` from `parse-test-failure` (the existing R-Phase8 helper — no duplication). Per-hit penalty: `vendored: −50`, `test: −2`, `user: 0`. The `−50` is large enough that no plausible term-count + IDF + def-boost combination can promote a vendored frame past a non-trivial user frame; `−2` is small enough that a test file with strong term overlap can still rank above a user file with weak overlap (test files often legitimately own the edit when the test itself is the bug).
3. **Parallel rg.** `Promise.all(tokens.map(collectTerm))` replaces the prior sequential `for`-await. The tool was already declared `isConcurrencySafe: () => true`; the per-term invocations have no shared mutable state until the fold into the per-line hit map, which is a single-threaded JS reduction. Wall-time scales with N tokens instead of summing them.
4. **BM25-lite IDF.** Replace `hit.terms.size * 10` with `Σ idf(t)` over the distinct terms that hit the line, where `idf(t) = ln((N − df_t + 0.5) / (df_t + 0.5) + 1)` (Robertson & Zaragoza 2009, eq. 3.15, no TF normalization since per-line TF ≈ 1 in code search). `N` is the file count in scope (or the tree-root count when `path` is unset). `df_t` is the count of distinct files containing term `t`. **Self-measured noise floor:** terms that saturate (`df_t` ≥ the file count `MAX_RG_LINES` could possibly cover, or rg returned a truncated result for that term) get `idf = 0` — no fixed stop-word list. This preserves [[no-heuristics-only-validated]] honestly: the threshold is observable from the run, not a hardcoded English-bias list.
5. **Definition-pattern boost.** `+3` when the line matches `^\s*(export\s+)?(default\s+)?(async\s+)?(function|const|let|var|class|def|fn|impl|type|interface|enum|struct|trait)\s+(<ident>)` AND `<ident>` (subtoken-split) overlaps query terms. The boost is small relative to a strong IDF sum but large enough to surface the *definition site* above incidental usages when both are present. The pattern covers TS/JS, Python, Rust, and Go declaration heads; ad-hoc DSLs fall through (no false boost).
6. **Verbose mode.** A `verbose: true` schema field renders `  path:line  [score=N.NN tier=user]  snippet` per row. Default OFF — the existing `  path:line  snippet` render is preserved byte-for-byte when `verbose` is absent or `false`. Verbose is intended for human debugging (model can request it; humans can pass it from the CLI) without changing the default model-facing surface.

The change is NOT byte-identical for arbitrary queries — rankings shift by design. The verification rule below bounds the shift.

## Validation

Agent B's empirical calibration corpus drives this — a 13-entry query set (`tests/smoke/localize/corpus.json`) with hand-labeled gold-standard `file:line` targets, plus `tests/smoke/localize/measure.ts` computing recall@1, recall@3, recall@5, and MRR.

Baseline (pre-R-Phase9 on the current main HEAD): `recall@1 = <MEASURED_BASELINE_R1>`, `recall@3 = <MEASURED_BASELINE_R3>`, `recall@5 = <MEASURED_BASELINE_R5>`, `MRR = <MEASURED_BASELINE_MRR>` (n=13).

After R-Phase9 (post-Agent-A-merge re-run): `recall@1 = <MEASURED_POST_R1>`, `recall@3 = <MEASURED_POST_R3>`, `recall@5 = <MEASURED_POST_R5>`, `MRR = <MEASURED_POST_MRR>`.

Acceptance rule: **aggregate must improve** across at least recall@3 and MRR; **per-query recall@3 may not drop by >0.20** without a written rationale (a single query regressing 1.00→0.00 fails the gate; 1.00→0.80 does not). The methodology, gold labels, and per-query deltas are documented in `tests/smoke/localize/README.md`. Pure-helper tests for the measurement script live in `tests/unit/localize-measure.test.ts`.

## Invariants preserved

- **Read-only / concurrency-safe.** `isReadOnly: () => true`, `isConcurrencySafe: () => true` unchanged. The parallel `Promise.all` only spawns ripgrep reads.
- **Path jail.** `resolveJailed` runs before any rg invocation. `FsJailError` short-circuits with the same `ok:false` shape as before.
- **Shell-quoting.** Every rg argument still flows through `sq()`. The added subtoken loop and BM25 pre-pass do not bypass quoting (they only change which tokens get quoted, not how).
- **Determinism.** Ties break by `byteCompare(file)` then line ASC, identical to the prior tie-break. For a fixed tree, identical query, identical output.
- **Skill discipline.** `localize` is still a 5/10 candidate generator in the Codex signal hierarchy. Source-text read (Stage 2 of the SKILL.md funnel) is still required to claim ownership. The skill's outcome enum (`located` / `narrowed` / `uncertain`) is untouched — a stronger ranking does not promote `rg`-only evidence to `located`.
- **No fixed stop-word list.** The noise floor is self-measured per query (rg saturation), which is what [[no-heuristics-only-validated]] demands — no hardcoded English bias, no top-N-words table, no language detection.

## Tradeoffs

- **Ranking is NOT byte-identical** for unchanged queries on an unchanged tree. Call sites that snapshot the full output string would break. Audit shows only `tests/unit/localize.test.ts` does so, and its assertions are file-presence / candidate-count, not byte-exact — confirmed by Agent A in the regression battery.
- **Peak memory.** Parallel rg keeps N concurrent stdout buffers, each capped at `MAX_RG_LINES` (4000 rows). At the default token budget after subtoken split, peak is bounded; on developer machines and CI this is negligible. The cap was already in place — we only changed when buffers exist concurrently, not how large they can grow.
- **Verbose mode is opt-in.** Default OFF preserves the prior render exactly. Callers that want score/tier visibility opt in per-call; this avoids a global flag day for the model-facing format.

## Out of scope (deferred)

- **Phrase queries** (multi-word literal match). Not validated to help on this corpus and would add a second rg pass per phrase; revisit if a future corpus shows the gap.
- **Cross-line proximity scoring** (function-window IDF). Properly belongs to Stage 2 of the SKILL funnel — that's `lsp_document_symbol` + `read`, not `localize`. Folding proximity into `localize` would blur the stage boundary.
- **Extension filter** (`--type py`). The `glob` tool already covers extension filtering via chaining; replicating it inside `localize` would force callers to learn two ways to do the same thing.
- **Embedding-based retrieval.** Large dependency footprint (model weights, ANN index, cache invalidation). Revisit if BM25-lite recall plateaus across a larger corpus.

## Source attribution

This ADR layers three published results, no new dependencies:

- **Agentless (Xia et al., 2024).** The 3-stage funnel and lexical-first retrieval philosophy — already absorbed in R-Phase7. The ranking improvements here strengthen the Stage-1 ranker without changing the funnel's shape.
- **BM25 / probabilistic IR (Robertson & Zaragoza, 2009).** The IDF weighting formula, used in `idf-lite` form — no TF normalization since per-line TF ≈ 1 in code search. Standard formulation; in-tree implementation.
- **Codex `may-20-codex-signal.md`.** Signal trust hierarchy. `localize` is explicitly a 5/10 candidate generator, not a proof. Preserved unchanged — the ranking is *better* but its trust tier is the same.

Implementation is in-tree only. No new runtime dependencies; the change is a ranker rewrite that reuses the existing rg shell, `classifyFrame` (R-Phase8), and the `tool-search.ts` tokenizer (R-Phase7-era helper).

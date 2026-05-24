# ADR-0173: Istanbul per-branch counter — `istanbulCoverageSource()` + Istanbul-shape emitter + merge

- **Status**: Accepted (Phase 3 of [ADR-0165](./0165-code-coverage.md) / [ADR-0170](./0170-coverage-ast-branch.md))
- **Date**: 2026-05-25
- **Related**:
  - [ADR-0165](./0165-code-coverage.md) — typed `CoverageSource` port + V8-heuristic adapter (Phase 1)
  - [ADR-0170](./0170-coverage-ast-branch.md) — AST-precise branch enumeration (Phase 2; AST gives an accurate `branchCount` denominator but reuses the line-ratio for `branchesCovered`)
  - [ADR-0144](./0144-metrics-registry.md) — `MetricSink` port (the emitter respects the same no-throw contract through the reporter)
- **SOTA reference**: c8's [`v8-to-istanbul`](https://github.com/istanbuljs/v8-to-istanbul) package (Strategy B+C of the research note — V8/JSC native byte coverage + AST containment merge + Istanbul JSON shape output). jest's `coverageProvider: 'v8'` uses the same pattern. We mirror the algorithm against the TypeScript compiler API instead of `@babel/parser` (zero marginal install cost — `typescript` is already a project devDep).
- **References**:
  - `src/observability/coverage/istanbul-source.ts` — per-branch counter adapter (V8 byte-range containment over AST sites)
  - `src/observability/coverage/istanbul-shape-emitter.ts` — Istanbul-shape JSON emitter (`toIstanbulJson`)
  - `src/observability/coverage/merge.ts` — `mergeCoverageReports` (shard reduce)
  - `src/observability/coverage/index.ts` — barrel (3 new exports: `istanbulCoverageSource`, `toIstanbulJson`, `mergeCoverageReports`)
  - `src/observability/coverage/port.ts` — closed port (UNCHANGED — same `CoverageSource` / `CoverageReport` interface)
  - `src/observability/coverage/v8-source.ts` — sibling (UNCHANGED — Phase 1 heuristic adapter)
  - `src/observability/coverage/ast-source.ts` — sibling (UNCHANGED — Phase 2 AST-precise denominator)
  - `src/observability/coverage/reporter.ts` — sibling (UNCHANGED — `MetricSink` integration unaffected)
  - `tests/unit/coverage-istanbul-source-hellgate.test.ts` — 15 cases (A:8 / B:2 / C:2 / D:3)
  - `tests/unit/coverage-istanbul-emitter-hellgate.test.ts` — 10 cases (E:3 / F:3 / G:3 / H:1)
  - `tests/unit/coverage-merge-hellgate.test.ts` — 9 cases (HELL-26..34)

## Context

ADR-0165 sealed the typed `CoverageSource` port + a V8-heuristic adapter that approximated `branchesCovered` by `branchCount × linesCovered ÷ lineCount` — a ratio heuristic that conflated branch coverage with line coverage. ADR-0170 added an AST-precise visitor that tightened the `branchCount` denominator (no more regex false positives on `/if|else/`-style regex literals) but kept the same ratio for the numerator — the AST gave us an accurate denominator without giving each individual branch arm an execution counter.

The c8 / v8-to-istanbul community pattern solves the numerator problem WITHOUT source instrumentation: V8 already emits per-byte-range execution counts via `Profiler.takePreciseCoverage` (the JSON shape `bun test --coverage` and `node --experimental-test-coverage` produce). For each AST branch arm we can find the SMALLEST enclosing V8 byte range and copy its `count`. The arm is covered iff that count is > 0; the count IS the per-arm hit number.

This ADR ships Phase 3 of the coverage stack:

1. `istanbulCoverageSource(opts?)` — third sibling under the same `CoverageSource` port; ingests the same V8 JSON shape; produces a `CoverageReport` whose `branchesCovered` is a TRUE per-branch sum (not a line-ratio).
2. `toIstanbulJson(report, sidecar?)` — convert a typed `CoverageReport` into the canonical Istanbul JSON shape coveralls / codecov / SonarQube ingest (`{ [file]: { path, s, f, b, statementMap, fnMap, branchMap } }`).
3. `mergeCoverageReports(reports)` — reduce N per-shard reports into one (max-numerator per branch / line / statement; intersection of `uncoveredLines`; strict shape-drift detection).

## Decision

### Part 1 — per-branch counter (`istanbulCoverageSource`)

Same V8-JSON intake. For each script:

1. Read source via `node:fs/promises`. Parse with `ts.createSourceFile` (syntactic-only — no type-check).
2. Walk AST collecting one BranchSite per ARM (mirrors the ADR-0170 visitor; string/regex/template-no-substitution literals halt recursion). Each site carries `{kind, pos, end, shortCircuitProne}` where `pos`/`end` are POST-trivia byte offsets (`node.getStart(sf)` — we MUST pass `sf` explicitly because the parse uses `setParentNodes=false`).
3. For each site, find the smallest V8 range fully containing `[pos, end)`. Hit count = `range.count`. If no enclosing range exists, the arm is uncovered (hit=0).
4. `branchesCovered = sum(siteHits[i] > 0)`. `branchCount = sites.length`.

A `PerBranchSidecar` is surfaced on the adapter instance (`adapter.lastSidecar`) carrying per-file `sites[] / hits[] / shortCircuitWarnings / lineStarts[]`. The `CoverageReport` port surface stays BYTE-COMPATIBLE — the sidecar is an additive opt-in for callers that want per-arm metadata (the Istanbul-shape emitter is the primary consumer).

### Part 2 — Istanbul-shape emitter (`toIstanbulJson`)

Pure shape transformation `CoverageReport → IstanbulCoverageJson`. The emitter:

- Synthesizes a `statementMap` entry per LINE (the port doesn't carry statement IDs; the v8-source treats `statementCount === lineCount` and we mirror that). `s[idx] = 0|1` per line based on the report's `uncoveredLines`.
- Emits `fnMap` and `f` as EMPTY objects (the port doesn't surface function coverage today; Istanbul tolerates this — codecov reads statement+branch only).
- Groups consecutive `if-then`+`if-else` sites into ONE `branchMap` entry with `locations = [then, else]` (mirrors nyc's accounting where each `if` is ONE entry with two arms). Same grouping for `cond-true`+`cond-false`. All other arms get their own 1-arm entry.
- Resolves precise line numbers via the sidecar's per-file `lineStarts[]` table (binary search on the byte offset). Column is emitted as `0` (line-only mapping — coveralls/codecov dedup on line, not column; follow-up to wire columns via source-map back-resolution is noted below).

### Part 3 — merge (`mergeCoverageReports`)

Reduce N reports into one. Per-file:

- **Shape invariants** (`lineCount` / `branchCount` / `statementCount`) MUST agree across shards. Disagreement throws `CoverageError("json-malformed", "...")` — silently merging mismatched shapes would alias different branches under the same ID.
- **Numerators** use MAX (a line/branch covered in EITHER shard is covered in the merged report). This is the standard Istanbul reduce — NOT a sum, because `linesCovered` is a count of covered LINES, not an execution count; summing would over-count.
- **`uncoveredLines`** = intersection (a line is uncovered ONLY when BOTH shards missed it).
- File order in the merged report is ascending by absolute path (deterministic for snapshot tests).

Empty input `[]` → empty identity report `{ files: [], totals: {100,100,100,0}, generatedAt: now() }`.

### Contracts (5)

1. **PORT PARITY**. `istanbulCoverageSource()` implements the exact `CoverageSource` interface — `read(path): Promise<CoverageReport>`. A composition root can substitute the v8 / ast / istanbul adapter at any callsite without a type change.
2. **PER-BRANCH NUMERATOR**. Unlike v8-source and ast-source (which approximate `branchesCovered` via `branchCount × linesRatio`), `istanbulCoverageSource` computes it as `sum(siteHits[i] > 0)`. The hellgate seals this differential on a tightly-carved-out inner uncovered range (HELL-15) — istanbul reports 0/1 branches covered while ast reports the rounded ratio.
3. **DEFAULT-OFF**. The slice barrel exports `istanbulCoverageSource` but NO composition root auto-instantiates it. Operators who want per-branch precision opt in by passing `istanbulCoverageSource()` into the coverage tool's source seam (same posture v8 / ast / c8 sources have had since ADR-0165 / 0170 / 0172).
4. **BUN V8-COVERAGE STATUS** (verified 2026-05-25 via `NODE_V8_COVERAGE=/tmp/qcov bun test ...`). Bun 1.3.x does NOT honor the standard `NODE_V8_COVERAGE` env var — no `coverage-*.json` files dumped to the directory. The supported intake paths for this adapter are:
   - `node --test --experimental-test-coverage` (Node ≥20 emits V8 JSON to stdout / `--test-coverage-output-dir`)
   - `c8 --reporter=json node ...` (V8 JSON written to `./coverage/coverage-*.json`)
   - `bun test --coverage --coverage-reporter=lcov` (degraded — lcov has line counts but no per-byte ranges; conversion via `lcov-parse` external)
   - Hand-crafted V8 JSON (what the hellgate uses)
   The CALLER chooses the runner; this adapter only ingests V8 JSON. Bun-native V8 coverage output is a follow-up tracked upstream.
5. **MERGE DRIFT POLICY**. Same-file with different `branchCount`/`lineCount`/`statementCount` across shards → throw. Callers MUST re-generate the per-shard report after each source change before merging.

## Default-OFF posture

Identical to ADR-0165 / 0170 / 0172 — the `coverage_check` tool stays caller-registered, and the slice barrel `index.ts` adds THREE new exports (`istanbulCoverageSource`, `toIstanbulJson`, `mergeCoverageReports`) that no in-tree consumer references. The V8 source remains the default for speed-sensitive paths; AST is opt-in for denominator precision; Istanbul is opt-in for per-branch numerator precision + downstream tool ingest.

## Hellgate (34 cases)

### A. AST-V8 containment (8) — `tests/unit/coverage-istanbul-source-hellgate.test.ts`
- HELL-1: branch fully in covered range (count=10) → covered, hit count 10
- HELL-2: branch fully in uncovered range (count=0) → uncovered
- HELL-3: branch spanning 2 ranges → uses smallest enclosing count (inner=0 overrides outer=5)
- HELL-4: branch with NO enclosing range → uncovered (hit=0)
- HELL-5: nested branches each map to their innermost range (outer covered, inner uncovered)
- HELL-6: `&&` RHS short-circuit branch — lenient mode produces a count (best-effort inheritance)
- HELL-7: switch case → each case arm maps to its own range
- HELL-8: catch clause arm maps to catch block range

### B. shortCircuitFidelity option (2)
- HELL-9: lenient default — `a && b` with no inner range data → still produces a branch count
- HELL-10: strict mode — same input → `shortCircuitWarnings` count exposed on sidecar

### C. branchId stability (2)
- HELL-11: same file twice → same branchId list (deterministic AST visit order)
- HELL-12: file edit adds a function at top → branchId list shifts (documented limitation; merge drift detector catches this when shards disagree)

### D. CoverageSource port parity (3)
- HELL-13: compile-level — `const src: CoverageSource = istanbulCoverageSource()` typechecks
- HELL-14: structural — `read()` returns a `CoverageReport` whose shape matches the port
- HELL-15: differential vs ast-source — same V8 input with tightly-carved-out uncovered inner range → ast computes via ratio, istanbul reports 0 covered (proof per-branch is strictly more precise on at least one input)

### E. Istanbul emitter shape (3) — `tests/unit/coverage-istanbul-emitter-hellgate.test.ts`
- HELL-16: single file → output has `statementMap` / `s` / `fnMap` / `f` / `branchMap` / `b` keys
- HELL-17: hit counts in `b` match per-branch counts from sidecar (`[7, 7]` for an if/else fully covered with count=7)
- HELL-18: branchMap.locations array length matches arms (if=2, switch=N independent entries × 1 location each)

### F. Empty + multi-file (3)
- HELL-19: empty branches → `branchMap` + `b` empty for that key
- HELL-20: multi-file aggregation preserved (one key per file)
- HELL-21: emitter without sidecar → statement-only output (empty `branchMap` / `b`)

### G. Istanbul JSON loose schema (3)
- HELL-22: each file entry validates `{path, s, f, b, statementMap, fnMap, branchMap}`
- HELL-23: branchMap entries have `type`, `line`, `loc`, `locations`
- HELL-24: statementMap entries have `start` / `end` with `line` / `column`

### H. Emitter empty input (1)
- HELL-25: report with empty `files` → emitter returns `{}`

### Merge (9) — `tests/unit/coverage-merge-hellgate.test.ts`
- HELL-26: single report → identity merge
- HELL-27: two reports same file → max-numerator semantics (larger shard's linesCovered wins)
- HELL-28: different files → union (both keys appear)
- HELL-29: shape drift — same file with different `branchCount` → throws `CoverageError`
- HELL-30: shape drift — same file with different `lineCount` → throws
- HELL-31: empty array → empty identity report
- HELL-32: totals re-aggregated across merged shards (weighted by counts, NOT averaged)
- HELL-33: `uncoveredLines` intersection — line uncovered in BOTH shards stays uncovered
- HELL-34: stable ascending file order

**34 pass / 0 fail / 108 expect() calls across the 3 new files**; the pre-existing v8 + ast + reporter hellgates remain green (`coverage-source-hellgate.test.ts` 15 + `coverage-ast-source-hellgate.test.ts` 22 + `coverage-reporter-hellgate.test.ts` 12 + new 34 = 83 pass total across the slice).

## Alternatives rejected

1. **`babel-plugin-istanbul`** — Requires a Babel / SWC require-hook to inject `__cov_*++` counters at each branch arm pre-compile. Breaks Bun's native TS execution (Bun uses JavaScriptCore + a custom transpiler; no Babel hook). Also adds ~3MB of devDeps. We achieve the same per-branch numerator via V8 byte-range containment WITHOUT instrumenting the source.
2. **Single-replacement of `ast-source.ts`** — Tempting to fold the per-branch logic into the AST adapter and delete the heuristic numerator. Rejected: a caller may want the FASTER ast-source path (no per-arm containment loop) when only the denominator matters (e.g. "is `branchCount` above a threshold for code-density measurement?"). Three siblings give the caller a precision/speed dial; collapsing to one removes the dial.
3. **`bun --coverage` lcov-only intake** — `bun test --coverage --coverage-reporter=lcov` emits LCOV-format text without per-byte ranges. Our containment algorithm needs byte ranges to map branches; LCOV-only intake would degrade to line-coverage-only. Documented in Bun V8-coverage status above.
4. **Auto-merge from a coverage directory** — Walking `./coverage/*.json` and calling `mergeCoverageReports` automatically. Rejected: the caller controls the reduce step (they may want to merge only subset of shards, or merge with a base report from a prior CI run). The merge primitive is pure and composable; the orchestration is the caller's.
5. **Per-statement IDs instead of per-line** — Istanbul's canonical schema has true per-STATEMENT IDs (one per `Statement` AST node). Our `statementMap` synthesizes one entry per LINE because the port currently surfaces line-only statement counts. Wiring per-statement IDs requires an additional AST visit (the branch visitor in `enumerateBranches` would need to be paralleled by a statement visitor); follow-up.
6. **Strict-only short-circuit fidelity (no lenient default)** — Rejected: V8 byte ranges frequently merge `&&` / `||` RHS into the parent expression (JIT inlining). Strict-only would force operators to wade through `shortCircuitWarnings` on every report. Lenient is the pragmatic default; strict is opt-in for audit-grade workflows.

## SOTA matrix

| Tool / adapter | line | branch ID | per-branch hit count | Istanbul JSON emit | shard merge |
|---|---|---|---|---|---|
| `bun test --coverage` (lcov) | yes | no | line only | no (LCOV) | no |
| `nyc` / `istanbul` (Babel) | yes | yes | per-branch (best `&&`/`\|\|`) | yes | yes |
| `c8` / `v8-to-istanbul` | yes | yes | per-branch (V8 byte ranges) | yes | yes |
| `jest --coverage` (Istanbul re-banner) | yes | yes | per-branch | yes | yes |
| ADR-0165 V8 (regex heuristic) | yes | no | line-ratio | no | no |
| ADR-0170 AST (TS compiler API) | yes | yes (precise denominator) | line-ratio | no | no |
| ADR-0172 c8 adapter (Istanbul JSON in) | yes | yes (from c8) | per-arm (from c8 `b`) | yes (passthrough) | no |
| **ADR-0173 istanbul-source** | **yes** | **yes (TS compiler API)** | **per-branch (V8 containment)** | **yes (`toIstanbulJson`)** | **yes (`mergeCoverageReports`)** |

= "first agent surface to ship a per-branch counter native to the TypeScript compiler API + V8 byte-range containment behind a port-substitutable adapter, with an Istanbul-shape emitter + a strict-shape merge primitive — the V8 / AST / c8 / istanbul adapters coexist; the caller picks at composition time."

## Plane-clean check

- `src/observability/coverage/istanbul-source.ts` imports ONLY `node:fs/promises`, `node:path`, `typescript`, and the in-slice `./port`. NO `@/agent`, `@/tool`, `@/llm`, `@/permission`.
- `src/observability/coverage/istanbul-shape-emitter.ts` imports ONLY in-slice `./port` + in-slice `./istanbul-source` (for the `BranchSite` / `PerBranchSidecar` types). NO `node:fs`, NO `typescript` — the emitter is pure shape arithmetic.
- `src/observability/coverage/merge.ts` imports ONLY the in-slice `./port`. NO `node:fs`, NO `typescript`.
- Hellgate tests import `bun:test`, `node:fs/promises`, `node:os`, `node:path`, and `@/observability/coverage`. No reach past the public barrel.

## Follow-up (not closed by this ADR)

- **Source-map back-resolution** — `statementMap` / `branchMap.loc` columns currently emit as `0`. Resolve precise columns via `sourceMappingURL` lookup (compiled `.js` → original `.ts`) for accurate IDE highlighting on coveralls / codecov.
- **`&&` / `||` strict mode linter integration** — surface `shortCircuitWarnings` count as a `coverage.short_circuit_warnings` gauge through the reporter so a CI gate can fail when fidelity degrades.
- **HTML report renderer** — `toIstanbulHtml(report, sidecar)` producing a self-contained `coverage/index.html` (mirrors nyc `--reporter=html`). Out of scope for Phase 3; the canonical Istanbul JSON output is already coveralls/codecov-ready.
- **Per-statement IDs** — Replace the line-synthesized `statementMap` with a true `Statement`-AST-node walk (the branch visitor already touches every executable statement; the visitor signature would need to record statements too).
- **Function coverage** — `fnMap` / `f` currently emit as empty. A function visitor pass (mirroring `enumerateBranches` for `FunctionDeclaration` / `FunctionExpression` / `MethodDeclaration` / `ArrowFunction`) would populate them.
- **Bun-native V8 coverage** — Track upstream Bun support for `NODE_V8_COVERAGE`; once available the adapter becomes drop-in usable with `bun test` without an external runner.
- **Cross-shard mtime sanity** — the merge drift detector catches shape divergence but not "same shape, source edited between shards in a way that preserves counts". A follow-up could carry a per-file content hash through the sidecar; mismatched hashes would also throw.

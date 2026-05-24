# ADR-0165: Code coverage observability — typed V8-coverage port + branch/statement breakdown + MetricSink emission

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: [ADR-0144](./0144-observability-metrics.md) (metrics sink — this slice feeds gauges through it)
- **SOTA reference**: `bun test --coverage` (line-only); nyc/istanbul (line+branch+statement, no `MetricSink` integration); jest `--coverage` (no in-process programmatic surface)
- **References**:
  - `src/observability/coverage/port.ts` — closed-port types + `CoverageError`
  - `src/observability/coverage/v8-source.ts` — V8 JSON adapter (byte-range → per-line, branch/statement heuristic)
  - `src/observability/coverage/reporter.ts` — threshold evaluator + `MetricSink` emitter
  - `src/observability/coverage/index.ts` — barrel
  - `src/tool/coverage_check.ts` — agent-invocable tool
  - `tests/unit/coverage-source-hellgate.test.ts` — 15 cases (A:10 / B:5)
  - `tests/unit/coverage-reporter-hellgate.test.ts` — 12 cases (A:7 / B:5)
  - `tests/unit/tool/coverage-check-hellgate.test.ts` — 10 cases (A:3 / B:7)

## Context

ADR-0144 sealed the typed `MetricSink` + `MetricsRegistry` pair. Operators can now query `tool_calls_total{tool=bash}` in-process and pipe to OTel / Prometheus / JSONL. What is STILL missing — `coverage.lines_percent{file=src/foo.ts}`, `coverage.branches_percent`, `coverage.statements_percent`. The signal lives in two places today:

- **`bun test --coverage`** — built-in line coverage only. No per-file branch / statement breakdown. No programmatic shape (text-only stdout).
- **`nyc` / `istanbul`** — full line + branch + statement, but ships as a heavy CLI (Babel parser + per-file HTML report); no `MetricSink` integration; not a port a hexagonal slice can substitute.

`jest --coverage` / `vitest --coverage` are the same Istanbul plumbing with a different banner. **No modern agent surfaces typed per-file coverage with branch + statement breakdowns AND a `MetricSink` hook.** This slice fills that gap.

## Decision

Four-part hexagonal slice in `src/observability/coverage/`:

1. **`port.ts`** — `FileCoverage` + `CoverageReport` + `CoverageThreshold` + `CoverageVerdict` (closed 2-arm) + `CoverageSource` + `CoverageError` (closed 3-arm code union: `json-malformed | io-failed | no-coverage-data`).
2. **`v8-source.ts`** — `defaultV8CoverageSource()` reads a V8 coverage JSON (`bun test --coverage` / `node --experimental-vm-modules --coverage`), maps byte ranges to per-line coverage (inner range overrides outer, smaller byte-width is authoritative), filters `node_modules` + non-`file://` URLs, computes branch + statement counts via the heuristic in §Alternatives below.
3. **`reporter.ts`** — `defaultCoverageReporter()` exposes `evaluate(report, opts)` (closed `CoverageVerdict`) and `emitMetrics(report, sink)` (per-file gauges with `{file}` label + 3 label-less totals).
4. **`coverage_check` tool (`src/tool/coverage_check.ts`)** — agent-invocable read-only / concurrency-safe tool wrapping the slice; path safety via `resolveJailedDoc` (same chokepoint as `read`/`pdf_read`); rejects symlinks to the coverage JSON; emits `ok:false` with typed `failure.mode: "rejected"` on threshold cross.

### Contracts (5)

1. **PURE SOURCE**. `CoverageSource.read` is async + idempotent + side-effect-free (reads JSON + reads source files). Errors are typed `CoverageError`, never bare `Error`.
2. **WEIGHTED TOTALS**. `report.totals.linesPercent` is `sum(linesCovered) / sum(lineCount) * 100`, NOT `mean(file.linesPercent)`. A 1000-line file at 50% does not get the same weight as a 10-line file at 100% — operator sees the percentage of EXECUTED code, not the percentage of FILES that are well-covered.
3. **VERDICT-CLOSED**. `CoverageVerdict` is exactly `{kind:"pass"} | {kind:"fail";reasons}`. A 3rd arm requires an ADR amendment + a compile-error update at every exhaustive switch.
4. **METRIC LABELS — file-only per-file, label-less totals**. Per-file gauges carry exactly `{file: <abs path>}`; totals carry NO labels. Adding a `lang` / `module` label is a follow-up — see §Label cardinality below.
5. **SINK NO-THROW**. `reporter.emitMetrics` wraps `sink.send` in try/catch — sink failures are silently swallowed (mirrors ADR-0144 contract #3).

## Default-OFF posture

Nothing in the loop auto-instantiates a coverage source. The `coverage_check` tool is NOT auto-registered in `buildDefaultTools` (its `defaultTools` entry would force every session to import the slice for a feature the model invokes manually). A composition root opts in by registering `coverageCheckTool` explicitly when a session-level config requests it. The metric emitter is independently opt-in — `reporter.evaluate` is callable without ever touching a sink.

## Hellgate (37 cases)

- **A. V8 source parsing (10)** — `coverage-source-hellgate.test.ts` HELL-1..10: 100% / 0% / partial (inner-range count=0) / multi-file weighted totals / `node_modules` skip / non-`file://` skip / malformed JSON → `json-malformed` / missing file → `io-failed` / empty result → `no-coverage-data` / `uncoveredLines` sorted + 1-indexed + dedup.
- **B. Branch heuristic (5)** — HELL-11..15: `if (x) {}` → 1; `if/else` → 2; `&&` and `||` → 1 each; ternary `? :` → 1; nested → sum.
- **C. Evaluate (7)** — `coverage-reporter-hellgate.test.ts` HELL-16..22: absent threshold → pass; thresholds met → pass; single crossed → fail with reason format `"lines: X < Y"`; multi-crossed → multi-reason in stable order; statements/branches independent; threshold 100 + 99.99 → fail; threshold 0 + 0 → pass.
- **D. EmitMetrics (5)** — HELL-23..27: single file → 3 file gauges + 3 totals; multi-file → N×3 + 3; totals label-less; throwing sink → no throw escapes; per-file label is the absolute path.
- **E. Tool surface (3)** — `tool/coverage-check-hellgate.test.ts` HELL-28..30: `name="coverage_check"` + readOnly + concurrencySafe; missing path → invalid input; threshold out of range → invalid input.
- **F. Tool execution (7)** — HELL-31..37: happy path → table + `PASS`; threshold met → `PASS`; threshold crossed → `ok:false` + typed `failure.mode:"rejected"`; absolute path under cwd accepted; `..` rejected via `FsJailError` → `permission_denied`; symlink rejected; empty V8 result → `no-coverage-data`.

37 pass / 0 fail / 82 expect() calls. All hellgate cases use real tmpdir + real fs writes. No mocks.

## Alternatives rejected

1. **"Istanbul / nyc dependency"** — Istanbul ships Babel parser (~5MB), per-file HTML report generation, and a CLI assembly the slice does not need. V8's native `result/functions/ranges` shape is stable since Node 10 and `bun test --coverage` emits the same schema; we get line + heuristic branch + statement coverage from a single dependency-free adapter. The trade-off: branch coverage is an APPROXIMATION (see #2) — for audit-grade per-branch enumeration use Istanbul as a follow-up adapter behind the same port.
2. **"AST-based branch count via tsc compiler API"** — Would require importing `typescript` (~50MB) at runtime, walking the AST, classifying each `IfStatement` / `ConditionalExpression` / `LogicalExpression` arm. Accurate, but a 50MB+ dep on a slice the agent invokes opportunistically is not worth it.
3. **Branch-count heuristic ACCURACY CLAIM**: we count `if|else|while|for|switch|case|? :|&&|\|\|` occurrences in the source AFTER stripping comments + string literals + template literals. False positives: a keyword inside a `${}`-interpolation of a template literal (rare); a keyword inside a regex literal (rare). False negatives: a branch built dynamically via `Function()` constructor (rare). For "are we above 70%?" threshold gating this is adequate; the SOTA matrix below records the trade-off explicitly. The `branchesCovered` value reuses the line-coverage RATIO (no AST, no execution-time per-branch counter), so the dimension's RESOLUTION is the same as line coverage — but it has a SECOND DENOMINATOR (branch count) which catches a file with no branches (denominator=0) and surfaces 100% by convention (no branches to miss).
4. **"Auto-fail the build on threshold cross"** — Out of scope. The tool returns `ok:false` + typed failure; the caller (CI, agent, IDE) decides whether to halt. A future `--strict` flag could escalate but is not part of this ADR.
5. **"Bun coverage internal API"** — Bun exposes `bun:test` runtime but the coverage internals are NOT a public API; consuming them would couple the slice to a private surface that may rotate per minor version. The V8 JSON output of `bun test --coverage` IS stable (it matches V8's profiler schema) — we depend on the JSON, not the runtime.
6. **"HTML report renderer"** — Belongs in a follow-up. The tool surfaces a plaintext table the model can read; an HTML report is operator-facing UX, not agent-facing signal.

## SOTA matrix

| Tool | line | branch | statement | per-file gauge | metric sink integration | typed verdict |
|---|---|---|---|---|---|---|
| `bun test --coverage` | yes | no | no | no | no | no |
| `nyc` / `istanbul` | yes | yes (AST) | yes (AST) | no | no | no |
| `jest --coverage` | yes | yes | yes | no | no | no |
| `vitest --coverage` | yes | yes | yes | no | no | no |
| Codex Desktop | partial | no | no | no | OTel only | no |
| Claude Code 2.1 | no | no | no | no | no | no |
| **quanta (this ADR)** | yes | yes (heuristic) | yes (line-equivalent) | yes (`{file}` label) | yes (ADR-0144 `MetricSink`) | yes (closed 2-arm `CoverageVerdict`) |

= "first agent surface with typed per-file coverage feeding the typed metric sink — branch coverage is heuristic (over `if|else|...|&&|||` tokens) with a documented trade-off, audit-grade branch enumeration deferred to a future Istanbul adapter behind the same `CoverageSource` port."

## Plane discipline (ADR-0193 정정)

- `src/observability/coverage/*` imports `node:fs/promises`, `node:path`, `../metrics/port` (sibling sub-slice — same parent `@/observability` plane), **그리고 `typescript`** (AST-source `ast-source.ts` / `istanbul-source.ts` — V2 follow-up 들이 추가). `@/agent` / `@/tool` / `@/llm` 직접 import 은 없으나 `typescript` 3rd-party 의존이 ADR 초안의 "plane-clean" 표현보다 무겁다는 점을 명시한다. biome `**/src/observability/**` slice 룰은 enforced — `@/agent`/`@/tool`/`@/llm` 류는 차단된다.
- `src/tool/coverage_check.ts` imports `@/observability/coverage` + `@/storage` (FS jail chokepoint `resolveJailedDoc`) + `./types` + `./_shared/resolve-jailed-doc`. NO `@/agent`, `@/permission`. `@/tool` 슬라이스 룰 (biome `**/src/tool/**` override) 이 enforced.

## Label cardinality

The per-file gauge label is the absolute path — a session that touches 1000 source files emits 3000 unique time-series. For `MetricSink`s with a fixed-cardinality budget (Prometheus) the operator should pre-aggregate or downsample at the sink boundary. The slice does NOT impose a label-cardinality cap — that's a sink-config concern (mirror of ADR-0144 follow-up #4).

## V8 JSON schema assumption

The adapter parses `{result: [{scriptId, url, functions: [{ranges: [{startOffset, endOffset, count}]}]}]}` — V8's `Profiler.takePreciseCoverage` shape stable since Node 10. Bun emits the same shape via `bun test --coverage`. A future shape drift is caught at the `json-malformed` boundary (type-guard `parseV8Doc` returns null on any field-type mismatch); the adapter does not silently degrade.

## Follow-up (not closed by this ADR)

- **AST-based branch count adapter** — alternate `CoverageSource` impl using `typescript` compiler API for audit-grade per-branch counts. Behind the same port; caller picks based on env.
- **HTML report renderer** — operator UX; takes a `CoverageReport`, produces a single-page HTML with per-file drill-down.
- **Diff coverage** — `CoverageReport` × git turn-diff (ADR-0107) → "lines added in this turn that are NOT covered". Most actionable gate for an agent.
- **Auto-instrument** — `src/apps/agent` bootstrap could wire `coverage.lines_percent` into the default `MetricsRegistry` when a `COVERAGE_JSON` env var is set; today the path is caller-explicit.
- **Label-cardinality guard** — global cap on `{file}` series with overflow → `other`. Mirrors ADR-0144 follow-up #4.
- **Istanbul-shape import** — accept Istanbul's `coverage-final.json` schema as a sibling `CoverageSource` so projects already using nyc can feed the same reporter.

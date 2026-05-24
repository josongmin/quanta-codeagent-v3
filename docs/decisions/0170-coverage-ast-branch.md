# ADR-0170: AST-precise branch counter — `astCoverageSource()` adapter behind the ADR-0165 `CoverageSource` port

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: [ADR-0165](./0165-code-coverage.md) (closed-port + V8 heuristic adapter — this ADR adds the AST-precise sibling; [ADR-0165 §Follow-up](./0165-code-coverage.md#follow-up-not-closed-by-this-adr) item 1 is the explicit hook)
- **SOTA reference**: nyc/istanbul (AST-walked branch arms via Babel; ~5MB), jest/vitest (Istanbul re-banner), Codex Desktop (no AST branch surface), Claude Code 2.1 (no coverage surface). This ADR adds a typescript-compiler-API walk behind the SAME `CoverageSource` port — caller picks (`defaultV8CoverageSource()` for speed, `astCoverageSource()` for precision).
- **References**:
  - `src/observability/coverage/ast-source.ts` — AST-walked adapter
  - `src/observability/coverage/index.ts` — barrel (exports `astCoverageSource` + `AstCoverageSourceOpts`)
  - `src/observability/coverage/port.ts` — closed port (UNCHANGED — same `CoverageSource` interface)
  - `src/observability/coverage/v8-source.ts` — sibling (UNCHANGED — heuristic adapter)
  - `tests/unit/coverage-ast-source-hellgate.test.ts` — 22 cases (A:11 / B:5 / C:3 / D:3)
  - `tests/unit/coverage-source-hellgate.test.ts` — 15 cases (UNCHANGED — V8 hellgate still green)

## Context

ADR-0165 sealed the typed `CoverageSource` port + a V8-adapter whose `branchCount` is a regex-keyword heuristic — `if|else|while|for|switch|case|? :|&&|\|\|` occurrences in source AFTER stripping comments + string + template literals. The trade-off was explicit: false positives on regex-literal `|` alternatives (ADR-0165 §Alternatives #3) and false negatives on multi-line string strips.

For audit-grade gates ("branch coverage ≥80%") this heuristic is inadequate — the operator wants a number that does NOT swing by ±N branches when a developer inlines a regex with `|` or refactors a `||` chain into `??`. The typescript compiler API (`ts.createSourceFile` + `ts.forEachChild`) gives us an AST walk WITHOUT a runtime type-check pass, at roughly 50MB on disk (already a project devDep — `bunx tsc --noEmit` proves it's resident in `node_modules`) and a 1-2ms parse per file.

ADR-0165 rejected the AST approach as "not worth a 50MB+ dep on an opportunistic slice" — that rejection assumed `typescript` was NOT already on disk. Since the project's tsconfig is enforced through that exact `typescript` install, the marginal cost is zero. This ADR re-opens the rejected path BEHIND the same port: callers pick the adapter; the heuristic V8 source remains the default for speed-sensitive paths, and the AST source is the opt-in for precision-sensitive gates.

## Decision

Add `astCoverageSource(opts?: AstCoverageSourceOpts): CoverageSource` to `src/observability/coverage/`. Same port. Same V8-JSON intake (line/statement signal comes from the same V8 `Profiler.takePreciseCoverage` shape `bun test --coverage` emits). The only changed input is the BRANCH COUNT — we replace the keyword regex with a `ts.forEachChild` walk that counts AST nodes:

| AST node | Branch count contribution |
|---|---|
| `IfStatement.thenStatement` (always present) | +1 |
| `IfStatement.elseStatement` (when present; recursive for `else if`) | +1 |
| `SwitchStatement.caseBlock.clauses[]` (each `CaseClause` or `DefaultClause`) | +1 each |
| `ConditionalExpression` (`a ? b : c`) | +2 (true + false arm) |
| `BinaryExpression` with `&&` / `\|\|` / `??` | +1 each (short-circuit) |
| `ForStatement` / `ForInStatement` / `ForOfStatement` / `WhileStatement` / `DoStatement` | +1 (body executes / not) |
| `CatchClause` | +1 (error path) |
| `StringLiteral` / `NoSubstitutionTemplateLiteral` / `RegularExpressionLiteral` | HALT recursion (children invisible) |
| `TemplateExpression` `.expression` slots inside `${}` | walked normally (real executable JS) |
| comment trivia (`//` / `/* */`) | NEVER visited (stripped by parser before AST handing) |

### Contracts (4)

1. **PORT PARITY**. `astCoverageSource()` implements the exact `CoverageSource` interface — `read(coverageJsonPath): Promise<CoverageReport>`. A composition root can substitute the V8 adapter at any callsite without a type change.
2. **NO TYPECHECK PASS**. We use `ts.createSourceFile` (syntactic parse only), NOT `ts.createProgram` (full type-check). Branch counts are derived from syntax — type errors in the source do not affect counts; an isolated source file with no transitive imports parses fine.
3. **DEFAULT-OFF**. The slice barrel re-exports `astCoverageSource` but no composition root auto-instantiates it. Operators who want AST precision opt in by passing `astCoverageSource()` into the coverage tool's source seam (same posture the V8 adapter has had since ADR-0165).
4. **DOCUMENTED TEMPLATE POLICY**. Expressions inside `${}` interpolations ARE walked (they are real executable JS) — `` `hello ${a && b} world` `` counts +1 for the `&&`. The literal head/middle/tail strings are TS leaves with no children, so a `${}`-free branch keyword in a template head (e.g. `` `if (x)` ``) contributes 0 — same as a plain string.

## Default-OFF posture

Identical to ADR-0165 — the `coverage_check` tool stays caller-registered, and the slice barrel `index.ts` adds ONE new export (`astCoverageSource`) that no in-tree consumer references. The V8 source remains the default for the documented heuristic-acceptable use case; AST is the opt-in alternative.

## Hellgate (22 cases)

`tests/unit/coverage-ast-source-hellgate.test.ts` — all 22 use real tmpdir + real fs writes + crafted V8 JSON (no mocks).

- **A. Branch types (11)** — HELL-1..11:
  - HELL-1: `if (x) {}` → 1 (then arm)
  - HELL-2: `if (x) {} else {}` → 2 (then + else)
  - HELL-3: `if (x) {} else if (y) {} else {}` → 4 (outer then + outer else + inner then + inner else)
  - HELL-4: switch with 3 cases + default → 4 (each clause is +1)
  - HELL-5: ternary `a ? b : c` → 2 (true + false arm)
  - HELL-6: `a && b` → 1
  - HELL-7: `a || b` → 1
  - HELL-8: `a ?? b` → 1
  - HELL-9: `for (let i=0; i<n; i++) {}` → 1 (body arm; the `<` is no branch)
  - HELL-10: `while (x) {}` → 1
  - HELL-11: `try {} catch (e) {}` → 1 (catch arm — try body is not a branch)
- **B. False-positive immunity (5)** — HELL-12..16:
  - HELL-12: branch keywords inside `"if (x) { ... } else { ... }"` STRING → 0 (StringLiteral halts recursion)
  - HELL-13: branch alternatives inside `/if|else|while|for/g` REGEX → 0 (RegularExpressionLiteral halts recursion; THE point where the V8 heuristic over-counts)
  - HELL-14: `&&` INSIDE template `${}` → 1 (documented policy: `${}` expressions are real JS)
  - HELL-15: `// if (x) { ... } else { ... }` line comment → 0 (TS strips comments pre-AST)
  - HELL-16: `/* if-else */ function f(z){ if (z) ... }` → 1 (only the real `if` counts)
- **C. Nested + composite (3)** — HELL-17..19:
  - HELL-17: nested `if (x) { if (y) {} else {} }` → 3 (outer then + inner then + inner else; no outer else)
  - HELL-18: `switch case 1: if (y) {} else {} break` → 3 (1 case clause + inner then + inner else)
  - HELL-19: `for (const x of y) if (x) {}` → 2 (loop body + if-then)
- **D. CoverageSource port parity (3)** — HELL-20..22:
  - HELL-20: compile-level — `const src: CoverageSource = astCoverageSource()` typechecks
  - HELL-21: structural — `read()` returns a `CoverageReport` whose `files`/`totals`/`generatedAt` shape matches the port
  - HELL-22: differential — same V8 input, regex-only file: AST returns 0 branches, V8 heuristic returns >0 (proof the AST is strictly more precise on at least one input)

**22 pass / 0 fail / 22 expect() calls in this file**; the 15 pre-existing V8 hellgate cases (ADR-0165) remain green (37/37 across both files, 58 total expects).

## Alternatives rejected

1. **"Just extend the V8 regex heuristic to strip regex literals"** — Regex literal detection requires a lexer-level disambiguation between `/` as division and `/` as regex delimiter (e.g. `a / b` vs `/a/.test()`). The full ECMAScript grammar treats this as context-sensitive; a regex-only "fix" would either over-strip (misses `a / b * c` as `/regex/`) or under-strip (still mis-counts inside regex). Cleaner to walk the AST once and let the parser do the disambiguation it was built for.
2. **"Babel parser instead of `typescript`"** — `@babel/parser` is a separate ~3MB dep with its own AST schema. `typescript` is already a transitive devDep (the project's tsconfig enforcement) — zero marginal install cost. Babel's AST also lacks the `ts.SyntaxKind` numeric switch we use; we'd need to rewrite the visitor.
3. **"Run istanbul-style instrumentation"** — Per-branch execution COUNTERS (the `branchesCovered` numerator, not the `branchCount` denominator) require source-code instrumentation (`__cov_*` hit counters injected pre-compile). Out of scope for this ADR — it would require a parallel build pipeline. We reuse the line-coverage RATIO for `branchesCovered` (same posture as the V8 adapter) — see §Follow-up.
4. **"AST walk with `setParentNodes=true`"** — TS allows the walker to navigate UP the tree. We don't need to — the visitor handles each node in isolation (no ancestor-dependent decisions). `setParentNodes=false` keeps the parse cheap (parent pointers are a separate ~10% parse-time cost on large files).
5. **"Use the `CoverageSource` port to also surface raw AST nodes"** — Would couple every consumer to the `typescript` API. The port stays clean: it surfaces `branchCount: number`, not `branchNodes: ts.Node[]`. An AST consumer that wants the nodes themselves can call the parser directly outside the port.
6. **"Cache parsed `SourceFile` instances across `read()` calls"** — Premature. A coverage run reads each file ONCE per report; cross-report caching only helps if the same JSON path is re-read. The cache would need an invalidation key (file mtime); not worth the complexity for an opportunistic slice. If profiling shows a real cost, add an LRU keyed on `(abs, mtime)` as a follow-up.

## SOTA matrix

| Tool / adapter | parser | regex-literal false positive | template-literal false positive | comment false positive | port-compatible alt-source | TypeScript native |
|---|---|---|---|---|---|---|
| ADR-0165 V8 (heuristic) | regex keywords | **YES** (`/if\|else/` counts as `\|\|`) | rare (template strips imperfect) | no (regex strips comments) | yes | no (regex-on-source) |
| nyc / istanbul | Babel AST | no | no | no | NO (own CLI, no port) | no (Babel) |
| jest / vitest --coverage | Istanbul re-banner | no | no | no | NO (own runner) | no |
| Codex Desktop | (no AST branch surface) | n/a | n/a | n/a | n/a | n/a |
| Claude Code 2.1 | (no coverage surface) | n/a | n/a | n/a | n/a | n/a |
| **quanta ADR-0170** | **TypeScript compiler API** | **no** | **policy-documented** (`${}` walked; literal parts not) | **no** | **YES** (`CoverageSource` port) | **YES** (native TS) |

= "first agent surface to ship an AST-precise branch counter native to the TypeScript compiler API behind a port-substitutable adapter — heuristic and AST adapters coexist; the caller picks at composition time."

## Plane discipline (ADR-0193 정정)

- `src/observability/coverage/ast-source.ts` imports `node:fs/promises`, `node:path`, **`typescript` (3rd-party compiler API)**, and the in-slice `./port`. NO `@/agent`, `@/tool`, `@/llm`, `@/permission` — biome `**/src/observability/**` slice 룰이 이를 enforced. `typescript` 3rd-party 의존이 ADR 초안의 "plane-clean" 표현보다 무거우므로, 이 슬라이스를 "compiler-bridge" 로 분류하고 plane-clean 라벨은 적합치 않다.
- `tests/unit/coverage-ast-source-hellgate.test.ts` imports `bun:test`, `node:fs/promises`, `node:os`, `node:path`, and `@/observability/coverage`. No reaching past the public barrel.

## Follow-up (not closed by this ADR)

- **Istanbul-style per-branch execution counters** — `branchesCovered` currently reuses the line-coverage RATIO. True per-branch coverage requires source-code instrumentation (Phase 3): inject `__cov_<id>++` at each branch arm pre-compile, ship a runtime hit-counter store, surface counts through a new `CoverageSource` impl. Out of scope here.
- **AST cache** — `(abs, mtime) → ts.SourceFile` LRU for cross-report re-reads. Add only if profiling shows real cost.
- **JSX branch nodes** — `JsxExpression` and JSX conditional render (`{cond && <X/>}`) are walked transitively (the `&&` is caught by `BinaryExpression`), but a follow-up could explicitly count `JsxConditional` constructs as named arms.
- **Per-file SCRIPT-KIND override** — today we derive the script kind from the file extension; a follow-up could let the caller pass a `(abs) => ts.ScriptKind` to handle `.svelte` / `.vue` / `.astro` SFCs whose `<script>` block is TS but the file extension is not.
- **`AstCoverageSource` constructor injectable parser** — for a custom parser (e.g. a vendored TS fork, or `@swc/core` AST), accept a `parse: (abs, source) => SourceFileLike` option. Today we hard-code `ts.createSourceFile`.
- **OTel branch-count attribute** — emit a `coverage.branch_count_method: "ast" | "heuristic"` attribute on each gauge so downstream dashboards can distinguish the two adapters' contributions.

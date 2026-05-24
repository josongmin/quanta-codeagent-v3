# ADR-0172: Coverage backend — swap self-rolled V8/AST internals for `c8`

- Status: Accepted (supersedes the INTERNALS of ADR-0165 / ADR-0170 — the
  public port + tool surface stays byte-identical)
- Date: 2026-05-25
- Related: ADR-0165 (V8 coverage source, self-impl), ADR-0167 (AST-precise
  branch counter, self-impl, the file landed as `ast-source.ts`),
  ADR-0144 (MetricSink), ADR-0170 (the AST branch decision)
- SOTA reference: **`c8`** (https://github.com/bcoe/c8) — the canonical
  V8 + Istanbul reporter wrapper maintained by the Node.js TSC. Same
  `NODE_V8_COVERAGE` source we read; produces `coverage-final.json` in the
  Istanbul shape with per-arm branch hit counts. Sibling `nyc` requires
  Babel transform; `c8` is V8-native and is what Node, Bun, Deno tooling
  converged on.

## Context

ADR-0165 stood up a typed `CoverageSource` port + reporter + auto-registered
`coverage_check` tool. The V8 adapter (`v8-source.ts`, ~400 LOC) parses the
V8 byte-range JSON by hand, derives lines from byte offsets, and counts
branches via a keyword regex (`/\b(?:if|else|while|for|switch|case)\b/`
plus `&&|||?|??`). ADR-0167 (`ast-source.ts`, ~400 LOC) added a TypeScript
compiler-API walker for accurate `branchCount` — but `branchesCovered`
remained a `linesCovered / lineCount` ratio because we have no per-arm
execution counter.

The user principle is explicit: **"외부에 잘 만들어진 거 있으면 외부 거 써"**.
`c8` is that thing. It reads the SAME `NODE_V8_COVERAGE` source, runs
Istanbul's `v8-to-istanbul` remap, and emits per-file `{s, f, b, statementMap,
fnMap, branchMap}` — `b[id] = [arm0Hits, arm1Hits, ...]` is the TRUE per-arm
counter our heuristics approximate. We re-implemented ~800 LOC of plumbing
that c8 already does, better.

Negative invariants we are NOT violating:
- Public port (`CoverageSource`, `CoverageReport`, `FileCoverage`,
  `CoverageError`, `CoverageThreshold`, `CoverageVerdict`) stays byte-identical.
- `coverage_check` tool surface stays byte-identical.
- V8/AST adapters stay on disk (zero-dep callers, existing tests, and the
  `linesCovered / lineCount` ratio approximation remain available — they
  are not removed, only superseded as the RECOMMENDED default).

## Decision

A 3rd sibling adapter `src/observability/coverage/c8-source.ts` (~250 LOC)
that consumes `coverage-final.json` and projects to our `CoverageReport`:

```
src/observability/coverage/
  port.ts          — UNCHANGED. CoverageSource / FileCoverage / errors.
  v8-source.ts     — UNCHANGED. Zero-dep V8 source; ratio-heuristic branches.
  ast-source.ts    — UNCHANGED. TS-compiler branch count; ratio-heuristic
                      branchesCovered.
  c8-source.ts     — NEW. Reads Istanbul JSON; per-arm branchesCovered.
                      RECOMMENDED default.
  reporter.ts      — UNCHANGED. Threshold gate + MetricSink wiring.
  index.ts         — adds `export { c8CoverageSource }`.
```

Pipeline (caller-driven; c8 stays out-of-process — the adapter only consumes
its JSON output, so the slice carries NO runtime `c8` import):

```sh
# 1. caller produces the JSON
bunx c8 --reporter=json bun test

# 2. caller reads it
const src = c8CoverageSource()                 // default path
const rep = await src.read("coverage/coverage-final.json")
```

Projection (Istanbul → our FileCoverage):

| our field            | Istanbul source                                        |
|----------------------|--------------------------------------------------------|
| `lineCount`          | distinct `statementMap[*].start.line` count            |
| `linesCovered`       | distinct lines where ANY statement on the line has s>0 |
| `branchCount`        | **Σ `branchMap[*].locations.length`** (per-arm, not entry) |
| `branchesCovered`    | **Σ count of `b[id][arm] > 0`** (TRUE per-arm hits)     |
| `statementCount`     | `|statementMap|`                                       |
| `statementsCovered`  | count of `s[id] > 0`                                   |
| `uncoveredLines`     | sorted distinct `statementMap[id].start.line` where s[id]=0 |

The **branchCount = Σ locations.length** rule is the load-bearing fix:
v8-source counts `if` and `else` as TWO branches by keyword scan, but it
cannot tell which arm ran — `branchesCovered` is `round(2 * linesRatio)`.
c8 says ONE `branchMap["0"]` entry has `locations.length === 2` AND
`b["0"] = [5, 0]` — so branchCount=2 (same denominator) but branchesCovered=1
(TRUE numerator). For `if(x){…}` where every line ran but the else was never
taken, v8 reports 100% branches; c8 reports 50%. The hellgate proves this
differentially (HELL-14).

Default-OFF: caller picks the source via `astCoverageSource()` /
`defaultV8CoverageSource()` / `c8CoverageSource()`. No loop wiring; the
`coverage_check` tool continues to default to V8 for back-compat. Operators
who want strict per-branch counts opt in by passing `c8CoverageSource()`.

## Alternatives rejected

- **"Remove v8/ast sources entirely; force c8."** Breaks the zero-dep
  posture (V8/AST run with no devDep) and breaks the existing 30+ hellgate
  cases. The ratio heuristic is a documented approximation, not a bug;
  callers that already trust it should keep getting it. Soft deprecation
  after corpus calibration is the safer path.
- **`nyc` instead of `c8`.** nyc requires Babel source-map transform and
  carries the entire babel toolchain. `c8` is V8-native — same source we
  already consume, no transform pass. Node TSC maintains it. For a slice
  that reads the V8 native source, `c8` is strictly closer to native.
- **Roll our own Istanbul-format reader.** We already rolled ~800 LOC of
  V8 + AST plumbing. Writing a 3rd hand-rolled parser of the c8 output
  format would entrench the very mistake this ADR fixes.
- **Pull `v8-to-istanbul` directly.** Possible but requires us to orchestrate
  the temp dir + report runner. c8 wraps `v8-to-istanbul` + the report
  runner + the `NODE_V8_COVERAGE` env handshake. Using c8 buys us the
  glue too.

## SOTA realignment

Per the 2026-05-23 four-way audit (`agent-loop-4way-comparison`),
Cursor/Codex/Claude Code expose ZERO in-agent coverage tooling. quanta
still uniquely surfaces `coverage_check` as an agent-callable. Only the
BACKEND of that tool is being swapped — the unique-vs-competitor surface
is unaffected.

## Migration

- **No call-site change required.** All consumers go through the
  `CoverageSource` port; passing `c8CoverageSource()` instead of
  `defaultV8CoverageSource()` is a one-line swap.
- **devDep added.** `c8@11.0.0` lands as devDependency. Production runtime
  is unaffected — the adapter has no runtime dep on the `c8` package.
- **Tool default unchanged for this slice.** Tool-level swap follows after
  corpus calibration. The hellgate proves c8 dominates v8 ON PRECISION
  (HELL-8, HELL-14); we still want a representative-corpus run before
  flipping the public default.

## Follow-up

- Run `bunx c8 --reporter=json bun test` against our own test suite; compare
  the c8 report vs v8 report for our own source. If c8 strictly dominates
  on representative input, flip the `coverage_check` default to c8 in a
  short follow-up ADR.
- After the default flips and a release window, mark `v8-source.ts` /
  `ast-source.ts` as "kept for zero-dep callers; new code uses c8".
  Removal requires another ADR (sealed by the negative invariant above).
- Document the `bunx c8 --reporter=json` runner recipe in the operator
  guide once a downstream consumer adopts it.

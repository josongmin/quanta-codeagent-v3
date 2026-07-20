/**
 * Feature-catalog test-audit — 13-rule admissibility enforcer for tests/.
 *
 * Audits every `tests/**` file against the admissibility rules from the
 * user-supplied spec. Rules R1-R3, R5, R8-R10, R13 are objective static/regex
 * checks and emit violations. R4, R6, R7, R11, R12 are semantic and out of
 * scope here — they're documented in `test-audit-rules.md` as "advisory /
 * human review" so this tool's silence on them is not interpreted as a pass.
 *
 * Hard constraint (per spec): **NO HEURISTICS**. Each rule is grounded in an
 * objective static signal (file extension, regex on imports, regex on titles
 * paired with regex on assertions). Where a rule needs an escape hatch the
 * tool reads an explicit opt-in comment (e.g. `// source-grep allowed`),
 * never a fuzzy filename match.
 *
 * Output shape: one `RuleReport` per implementable rule, each with the rule
 * id, human title, and a list of `Violation { file, line, message }`. The
 * CLI prints these grouped by rule and exits non-zero only if --strict is
 * passed (parity with `gates`); default is advisory because the catalog has
 * known pre-existing violations the tool surfaces as a baseline.
 *
 * No I/O lives here beyond reading files passed by path — directory walking
 * is in `collectTestFiles` so this module remains deterministic and easy to
 * unit-test.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Violation {
  readonly file: string
  readonly line: number
  readonly message: string
}

export interface RuleReport {
  readonly rule: string
  readonly title: string
  readonly implemented: boolean
  readonly violations: readonly Violation[]
}

export interface TestAuditReport {
  readonly rules: readonly RuleReport[]
  readonly totalTests: number
  readonly totalViolations: number
}

/** Review-visible snapshot of pre-existing static audit debt. `--strict`
 * rejects a fingerprint not listed here; removals produce a tighten notice
 * rather than being silently retained forever. */
export interface TestAuditBaseline {
  readonly version: 1
  readonly violations: readonly string[]
}

export interface TestAuditBaselineComparison {
  readonly newViolations: readonly string[]
  readonly resolvedViolations: readonly string[]
}

/** Pre-read test file: relative path + raw contents. Splitting walking from
 *  per-rule analysis keeps each rule pure and testable from synthetic input. */
export interface TestFile {
  readonly path: string
  readonly text: string
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

const TEST_EXT_RE = /\.test\.(ts|js)$/
const TS_TEST_EXT_RE = /\.test\.ts$/
const JS_TEST_EXT_RE = /\.test\.js$/

/** Walk `tests/` and return every file matching `*.test.{ts,js}`. Paths are
 *  repo-relative so report messages are stable across machines. */
export async function collectTestFiles(
  root: string,
  testsDir = "tests",
): Promise<{ ts: TestFile[]; js: TestFile[] }> {
  const tsFiles: TestFile[] = []
  const jsFiles: TestFile[] = []
  const base = resolve(root, testsDir)
  let exists = false
  try {
    const s = await stat(base)
    exists = s.isDirectory()
  } catch {
    exists = false
  }
  if (!exists) return { ts: tsFiles, js: jsFiles }

  async function readEntries(dir: string): Promise<import("node:fs").Dirent[]> {
    try {
      return (await readdir(dir, {
        withFileTypes: true,
      })) as unknown as import("node:fs").Dirent[]
    } catch {
      return []
    }
  }

  async function readFileSafe(full: string): Promise<string> {
    try {
      return await readFile(full, "utf8")
    } catch {
      return ""
    }
  }

  async function visitFile(full: string, name: string): Promise<void> {
    if (!TEST_EXT_RE.test(name)) return
    const rel = relative(root, full)
    const text = await readFileSafe(full)
    const tf: TestFile = { path: rel, text }
    if (TS_TEST_EXT_RE.test(name)) tsFiles.push(tf)
    else if (JS_TEST_EXT_RE.test(name)) jsFiles.push(tf)
  }

  async function walk(dir: string): Promise<void> {
    const entries = await readEntries(dir)
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) await visitFile(full, e.name)
    }
  }
  await walk(base)
  tsFiles.sort((a, b) => a.path.localeCompare(b.path))
  jsFiles.sort((a, b) => a.path.localeCompare(b.path))
  return { ts: tsFiles, js: jsFiles }
}

// ---------------------------------------------------------------------------
// Rule implementations (pure functions over TestFile[])
// ---------------------------------------------------------------------------

/**
 * R1 — "Runs exactly once in intended suite."
 * Objective signal: a `.test.js` co-located with the same-stem `.test.ts`
 * means the emitted/legacy file will get picked up alongside the source,
 * causing double-execution. Flag every duplicated stem.
 */
export function checkR1Duplicates(ts: readonly TestFile[], js: readonly TestFile[]): Violation[] {
  const violations: Violation[] = []
  const tsStems = new Set<string>()
  for (const f of ts) tsStems.add(stripTestExt(f.path))
  for (const j of js) {
    const stem = stripTestExt(j.path)
    if (tsStems.has(stem)) {
      violations.push({
        file: j.path,
        line: 1,
        message: `duplicate of ${stem}.test.ts — emitted .test.js runs alongside the source .test.ts`,
      })
    }
  }
  return violations
}

/**
 * R2 — "Authored as .test.ts (not emitted .test.js)."
 * Any `.test.js` under `tests/` is a violation (this directory should only
 * contain authored TypeScript; the build emits to dist/).
 */
export function checkR2NoEmittedJs(js: readonly TestFile[]): Violation[] {
  return js.map<Violation>((f) => ({
    file: f.path,
    line: 1,
    message: ".test.js found under tests/ — only authored .test.ts files are allowed",
  }))
}

const SRC_IMPORT_RE = /from\s+["'](@\/[^"']+|(?:\.\.\/)+src\/[^"']+|\.\.\/\.\.\/src\/[^"']+)["']/
const SRC_IMPORT_BARE_RE = /from\s+["'](?:\.\.?\/)+(?:src\/[^"']+)["']/

// R3 exemption: meta/architecture path prefix.
// Rule 5 ("does not grep source code unless testing source-transform/lint
// rule") explicitly carves out tests that LINT or SCAN source rather than
// import it. The path prefixes below are the canonical homes for such tests,
// the same allowlist R5 already honors (`_arch/`, `architecture/`).
// Adding `meta/` covers `tests/meta/*` (e.g. no-test-js-artifacts scanner).
const R3_META_PATH_RE = /(^|\/)(?:_arch|architecture|meta|_harness|_parity)\//

// R3 exemption: filename signals meta-test status.
// Literal substring match (lower-case). Each pattern documented inline.
//   - `scanner`              : source/AST scanners (no src import; they walk fs)
//   - `slice-boundary`       : slice-boundary linters (filesystem layout assertions)
//   - `boundary`             : superset of `slice-boundary` for non-slice arch tests
//   - `import-cycle`         : Tarjan SCC scanners over src/ (read files, don't import)
//   - `arch-gen`             : auto-generator tests that exercise tools/arch-gen
//   - `no-test-js-artifacts` : filesystem walker that bans .test.js emission
//   - `-lint`                : test-as-lint rules (suffix form)
const R3_META_FILENAME_PATTERNS = [
  "scanner",
  "slice-boundary",
  "boundary",
  "import-cycle",
  "arch-gen",
  "no-test-js-artifacts",
  "-lint",
] as const

// R3 exemption: explicit opt-in comment anywhere in the file. Mirrors the
// `// source-grep allowed` escape hatch R5 uses — an authored signal that the
// file deliberately does not import src/. Two synonyms accepted.
const R3_OPT_IN_RE = /\/\/\s*(?:architecture-test|meta-test)\b/
const TEST_AUDIT_META_RE = /\/\/\s*test-audit meta\b/

function isR3MetaExempt(path: string, text: string): boolean {
  if (R3_META_PATH_RE.test(path)) return true
  const lowerName = basename(path).toLowerCase()
  for (const pat of R3_META_FILENAME_PATTERNS) {
    if (lowerName.includes(pat)) return true
  }
  if (R3_OPT_IN_RE.test(text)) return true
  if (TEST_AUDIT_META_RE.test(text)) return true
  return false
}

/**
 * R3 — "Calls actual unit under test."
 * Objective signal: at least one `import { ... } from "@/..."` or
 * `from "../../src/..."` (or any deeper relative ascent into `src/`). A test
 * that imports nothing from src/ is, by definition, not exercising real
 * units (it's testing fixtures or pure stdlib — likely vacuous).
 *
 * Meta/architecture/lint tests are exempt (see `isR3MetaExempt`): per rule 5
 * they intentionally scan source instead of importing it, so requiring a
 * src-import would be a false positive.
 */
export function checkR3UnitImport(ts: readonly TestFile[]): Violation[] {
  const violations: Violation[] = []
  for (const f of ts) {
    if (SRC_IMPORT_RE.test(f.text) || SRC_IMPORT_BARE_RE.test(f.text)) continue
    if (isR3MetaExempt(f.path, f.text)) continue
    violations.push({
      file: f.path,
      line: 1,
      message: "no import from @/* or ../../src/* — test does not call the actual unit under test",
    })
  }
  return violations
}

const SOURCE_GREP_ALLOWED_RE = /\/\/\s*source-grep allowed/
const READ_FILE_SRC_RE =
  /readFile(?:Sync)?\s*\(\s*["'`](?:\.\.\/)*src\/|readFile(?:Sync)?\s*\([^)]*resolve\([^)]*["'`]src\b/
const IMPORT_META_GLOB_SRC_RE = /import\.meta\.glob\s*\(\s*["'`][^"'`]*src\b[^"'`]*["'`]/

/**
 * R5 — "Does not grep source code unless testing source-transform/lint rule."
 * Objective signal: if a test reads source files via `readFileSync("src/...")`
 * or `import.meta.glob("src/...")`, it must either live under
 * `tests/architecture/` (or `tests/unit/_arch/`, our local convention) OR
 * carry the explicit opt-in comment `// source-grep allowed`.
 */
export function checkR5SourceGrep(ts: readonly TestFile[]): Violation[] {
  const violations: Violation[] = []
  for (const f of ts) {
    const grepsSrc = READ_FILE_SRC_RE.test(f.text) || IMPORT_META_GLOB_SRC_RE.test(f.text)
    if (!grepsSrc) continue
    const isArchPath = /(^|\/)(?:architecture|_arch)\//.test(f.path)
    if (isArchPath) continue
    if (SOURCE_GREP_ALLOWED_RE.test(f.text)) continue
    const lineNo = findFirstMatchLine(f.text, READ_FILE_SRC_RE, IMPORT_META_GLOB_SRC_RE)
    violations.push({
      file: f.path,
      line: lineNo,
      message:
        "test reads src/ files but is not under tests/architecture/_arch and lacks `// source-grep allowed` opt-in",
    })
  }
  return violations
}

// Title-keyed rules (R8/R9/R10) parse each `test(...)` / `it(...)` literal
// and inspect the body for the required assertion shape.

interface TestBlock {
  readonly title: string
  readonly bodyStart: number
  readonly bodyEnd: number
  readonly bodyText: string
  readonly titleLine: number
}

// Match test("...", ...) or it("...", ...) or test.only / test.skip. We only
// inspect the title string — the body is whatever follows on subsequent lines
// until the matching brace. Because brace-balancing through a regex is fragile,
// we use a coarse window: bodyText is the next N lines after the title.
const TEST_DECL_RE = /\b(?:test|it)(?:\.(?:only|skip|todo))?\s*\(\s*["'`]([^"'`]+)["'`]/g

function extractTestBlocks(text: string): TestBlock[] {
  const blocks: TestBlock[] = []
  const lines = text.split("\n")
  // Track cumulative offset to map character index → line number.
  const lineStarts: number[] = []
  {
    let off = 0
    for (const l of lines) {
      lineStarts.push(off)
      off += l.length + 1
    }
  }
  TEST_DECL_RE.lastIndex = 0
  let m: RegExpExecArray | null = TEST_DECL_RE.exec(text)
  while (m !== null) {
    const idx = m.index
    const titleLine = upperBoundLine(lineStarts, idx)
    // Coarse body window: next 60 lines (enough for typical test bodies).
    const startLineIdx = titleLine - 1
    const endLineIdx = Math.min(lines.length, startLineIdx + 60)
    const bodyText = lines.slice(startLineIdx, endLineIdx).join("\n")
    blocks.push({
      title: m[1] ?? "",
      bodyStart: idx,
      bodyEnd: idx + bodyText.length,
      bodyText,
      titleLine,
    })
    m = TEST_DECL_RE.exec(text)
  }
  return blocks
}

function upperBoundLine(lineStarts: readonly number[], offset: number): number {
  // Binary search: return 1-based line number that contains `offset`.
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    const start = lineStarts[mid]
    if (start === undefined || start > offset) hi = mid - 1
    else lo = mid
  }
  return lo + 1
}

const CLEANUP_TITLE_RE = /\b(?:cleanup|teardown|afterEach|finalize|finalization|dispose)\b/i
// R8: explicit cleanup-related assertions. We accept any of:
//   - toHaveBeenCalled / toBeCalled on something containing cleanup|dispose|close|teardown|finalize|destroy
//   - expect(...).toHaveBeenCalledTimes(N) on the same names
//   - expect(<x>.aborted|<x>.closed|<x>.disposed).toBe(true)
const CLEANUP_ASSERT_RE =
  /(?:cleanup|teardown|dispose|close[Hh]?|finaliz|destroy|unmount|release|cancel)[A-Za-z_$]*\)?\s*\.[a-zA-Z]+\(\s*\)?\s*\)?\s*\.toHaveBeenCalled|\b(?:disposed|closed|aborted|finalized|cleaned)\s*\)\s*\.toBe\(\s*true|\.toHaveBeenCalledTimes\(\s*\d+\s*\)|expect\([^)]*\b(?:cleanup|close|dispose|teardown|finalize|destroy)[A-Za-z_$]*\b[^)]*\)\.to(?:HaveBeenCalled|Be(?:Called)?)/

/**
 * R8 — "Cleanup tests assert actual cleanup/finalization hooks."
 */
export function checkR8Cleanup(ts: readonly TestFile[]): Violation[] {
  const violations: Violation[] = []
  for (const f of ts) {
    if (TEST_AUDIT_META_RE.test(f.text)) continue
    const blocks = extractTestBlocks(f.text)
    for (const b of blocks) {
      if (!CLEANUP_TITLE_RE.test(b.title)) continue
      if (CLEANUP_ASSERT_RE.test(b.bodyText)) continue
      violations.push({
        file: f.path,
        line: b.titleLine,
        message: `cleanup-titled test "${truncate(b.title, 70)}" lacks any cleanup/finalization assertion (toHaveBeenCalled / .disposed / .closed / .aborted / toHaveBeenCalledTimes)`,
      })
    }
  }
  return violations
}

const CANCEL_TITLE_RE = /\b(?:cancel|cancellation|abort|aborts?|interrupt)\b/i
// R9: cancellation/abort tests must assert one of:
//   - <signal>.aborted truthy
//   - listener of "abort" called
//   - promise rejects with AbortError or signal-related error
//   - controller.abort called and propagated
const CANCEL_ASSERT_RE =
  /\.aborted\s*\)?\s*\.toBe\(\s*true|\.aborted\s*\)?\s*\.toEqual\(\s*true|toRejectWith|rejects?\s*\.toThrow|rejects?\s*\.toBe(?:Defined)?|toThrow\(.*Abort|AbortError|"abort"\s*,\s*[A-Za-z_$]|addEventListener\(\s*["']abort["']|expect\([^)]*\.abort\b[^)]*\)\.toHaveBeenCalled/

/**
 * R9 — "Cancellation tests assert upstream cancellation/return/abort behavior."
 */
export function checkR9Cancellation(ts: readonly TestFile[]): Violation[] {
  const violations: Violation[] = []
  for (const f of ts) {
    if (TEST_AUDIT_META_RE.test(f.text)) continue
    const blocks = extractTestBlocks(f.text)
    for (const b of blocks) {
      if (!CANCEL_TITLE_RE.test(b.title)) continue
      if (CANCEL_ASSERT_RE.test(b.bodyText)) continue
      violations.push({
        file: f.path,
        line: b.titleLine,
        message: `cancellation-titled test "${truncate(b.title, 70)}" lacks any abort/cancellation assertion (.aborted toBe(true) / rejects.toThrow / AbortError / addEventListener("abort"))`,
      })
    }
  }
  return violations
}

const ENV_TITLE_RE = /\b(?:env|environment|isolation|isolated)\b/i
// R10: environment-isolation tests must demonstrate they fail on forbidden
// env access, not merely diff stdout. Accept any of:
//   - mockEnv(...) call
//   - process.env.<NAME> = undefined; then assert
//   - getter/proxy that throws on access (Object.defineProperty + get throw)
//   - expect(() => process.env[...]).toThrow
const ENV_ASSERT_RE =
  /\bmockEnv\b|process\.env\.[A-Z_][A-Z0-9_]*\s*=\s*undefined|Object\.defineProperty\([^)]*process\.env|toThrow\([^)]*env[^)]*\)|expect\([^)]*process\.env\b[^)]*\)\.toThrow/

/**
 * R10 — "Environment isolation tests fail on forbidden env access."
 */
export function checkR10EnvIsolation(ts: readonly TestFile[]): Violation[] {
  const violations: Violation[] = []
  for (const f of ts) {
    if (TEST_AUDIT_META_RE.test(f.text)) continue
    const blocks = extractTestBlocks(f.text)
    for (const b of blocks) {
      if (!ENV_TITLE_RE.test(b.title)) continue
      if (ENV_ASSERT_RE.test(b.bodyText)) continue
      violations.push({
        file: f.path,
        line: b.titleLine,
        message: `env/isolation-titled test "${truncate(b.title, 70)}" does not assert env-access failure (mockEnv / process.env.X = undefined / toThrow on env access)`,
      })
    }
  }
  return violations
}

// R13: external-dependency tests must SKIP visibly, never early-return + PASS.
// A test that guards on an availability/readiness flag and `return`s when the
// dependency is missing reports as PASSED with its real assertions never run —
// a green run becomes indistinguishable from one that actually exercised the
// dep. The fix is a collection-time skip (`test.skipIf` / `describe.skip(If)`),
// so absence surfaces as a visible `skipped`, not a silent pass.
//
// Objective signal: within a test body, an `if (...AVAIL...) ... return` where
// the guard references an availability-named token (`HAS_*`, `*_RAN`,
// `*AVAILABLE*`, `*USABLE*`, `*available*`, `canSpawn`, `hasChrome`,
// `installed`). The `[^}]` span between the guard and `return` ensures we only
// match returns INSIDE the guard block (the skip-and-pass shape), not unrelated
// later returns.
//
// File-level exemption: if the file gates ANY block via `test.skipIf` /
// `it.skipIf` / `describe.skip` / `describe.skipIf`, it is exempt — it already
// knows the visible-skip idiom, and the residual bare-return (binary present
// but session unusable) is a narrow, lower-severity case. Explicit opt-out:
// `// skip-and-pass allowed`.
const R13_SKIP_CONSTRUCT_RE = /\b(?:describe|test|it)\.skip(?:If)?\b/
const R13_OPT_IN_RE = /\/\/\s*skip-and-pass allowed/
const R13_AVAIL_GUARD_RETURN_RE =
  /if\s*\(\s*!?[^)]*(?:HAS_[A-Z0-9_]+|[A-Za-z0-9_]*_RAN\b|[A-Za-z0-9_]*AVAILABLE[A-Za-z0-9_]*|[A-Za-z0-9_]*USABLE[A-Za-z0-9_]*|[A-Za-z0-9_]*available[A-Za-z0-9_]*|canSpawn|hasChrome|installed)[^)]*\)\s*\{?[^}]*?\breturn\b/

/**
 * R13 — "External-dependency tests skip visibly, never pass as a no-op."
 */
export function checkR13SkipAndPass(ts: readonly TestFile[]): Violation[] {
  const violations: Violation[] = []
  for (const f of ts) {
    if (R13_SKIP_CONSTRUCT_RE.test(f.text)) continue
    if (R13_OPT_IN_RE.test(f.text)) continue
    const blocks = extractTestBlocks(f.text)
    for (const b of blocks) {
      if (!R13_AVAIL_GUARD_RETURN_RE.test(b.bodyText)) continue
      violations.push({
        file: f.path,
        line: b.titleLine,
        message: `test "${truncate(b.title, 70)}" early-returns on an availability guard (skip-and-pass) while the file never visibly skips — use test.skipIf / describe.skip(If) so an unavailable dependency reports as skipped, not passed`,
      })
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// Public entry: runAllRules
// ---------------------------------------------------------------------------

const RULE_TITLES: Record<string, string> = {
  R1: "Runs exactly once in intended suite (no .test.ts/.test.js pair)",
  R2: "Authored as .test.ts (not emitted .test.js)",
  R3: "Calls actual unit under test (imports @/* or ../../src/*)",
  R4: "Asserts observable behavior or explicit public contract",
  R5: "Does not grep source code unless testing source-transform/lint rule",
  R6: "Title does not claim more than assertions prove",
  R7: "Idempotency tests assert exact side-effect counts",
  R8: "Cleanup tests assert actual cleanup/finalization hooks",
  R9: "Cancellation tests assert upstream cancellation/return/abort behavior",
  R10: "Environment isolation tests fail on forbidden env access",
  R11: "Would fail against at least one realistic broken implementation",
  R12: "Would survive a behavior-preserving refactor",
  R13: "External-dependency tests skip visibly, never pass as a no-op",
}

const SEMANTIC_RULES = ["R4", "R6", "R7", "R11", "R12"] as const

export function runAllRules(input: {
  readonly ts: readonly TestFile[]
  readonly js: readonly TestFile[]
}): TestAuditReport {
  const { ts, js } = input
  const reports: RuleReport[] = []
  const push = (rule: string, vs: Violation[]): void => {
    const title = RULE_TITLES[rule] ?? rule
    reports.push({ rule, title, implemented: true, violations: vs })
  }
  push("R1", checkR1Duplicates(ts, js))
  push("R2", checkR2NoEmittedJs(js))
  push("R3", checkR3UnitImport(ts))
  push("R5", checkR5SourceGrep(ts))
  push("R8", checkR8Cleanup(ts))
  push("R9", checkR9Cancellation(ts))
  push("R10", checkR10EnvIsolation(ts))
  push("R13", checkR13SkipAndPass(ts))
  for (const r of SEMANTIC_RULES) {
    reports.push({
      rule: r,
      title: RULE_TITLES[r] ?? r,
      implemented: false,
      violations: [],
    })
  }
  // Stable ordering: R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12.
  reports.sort((a, b) => ruleOrder(a.rule) - ruleOrder(b.rule))
  const totalViolations = reports.reduce((acc, r) => acc + r.violations.length, 0)
  return { rules: reports, totalTests: ts.length + js.length, totalViolations }
}

export function testAuditViolationFingerprint(rule: string, violation: Violation): string {
  return [rule, violation.file, String(violation.line), violation.message].join("\t")
}

export function snapshotTestAuditBaseline(report: TestAuditReport): TestAuditBaseline {
  const violations = report.rules
    .flatMap((rule) =>
      rule.violations.map((violation) => testAuditViolationFingerprint(rule.rule, violation)),
    )
    .sort()
  return { version: 1, violations }
}

export function compareTestAuditBaseline(
  report: TestAuditReport,
  baseline: TestAuditBaseline,
): TestAuditBaselineComparison {
  const current = new Set(snapshotTestAuditBaseline(report).violations)
  const recorded = new Set(baseline.violations)
  return {
    newViolations: [...current].filter((fingerprint) => !recorded.has(fingerprint)).sort(),
    resolvedViolations: [...recorded].filter((fingerprint) => !current.has(fingerprint)).sort(),
  }
}

export async function loadTestAuditBaseline(path: string): Promise<TestAuditBaseline> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!parsed || typeof parsed !== "object") return { version: 1, violations: [] }
    const candidate = parsed as { version?: unknown; violations?: unknown }
    if (
      candidate.version !== 1 ||
      !Array.isArray(candidate.violations) ||
      candidate.violations.some((violation) => typeof violation !== "string")
    ) {
      return { version: 1, violations: [] }
    }
    return { version: 1, violations: [...new Set(candidate.violations)].sort() }
  } catch {
    return { version: 1, violations: [] }
  }
}

export async function saveTestAuditBaseline(
  report: TestAuditReport,
  path: string,
): Promise<TestAuditBaseline> {
  const baseline = snapshotTestAuditBaseline(report)
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`)
  return baseline
}

function ruleOrder(r: string): number {
  const m = /^R(\d+)$/.exec(r)
  return m?.[1] !== undefined ? Number(m[1]) : 999
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export interface FormatOptions {
  readonly maxPerRule: number
  readonly showSemantic: boolean
}

export function formatTestAuditReport(
  report: TestAuditReport,
  opts: Partial<FormatOptions> = {},
): string {
  const maxPerRule = opts.maxPerRule ?? 10
  const showSemantic = opts.showSemantic ?? true
  const lines: string[] = []
  lines.push(
    `test-audit: ${report.totalTests} test file(s) scanned, ${report.totalViolations} violation(s)`,
  )
  lines.push("")
  for (const r of report.rules) {
    if (!r.implemented) {
      if (!showSemantic) continue
      lines.push(`  ${r.rule}  ${r.title}`)
      lines.push("        (semantic — human review only; not enforced by tool)")
      continue
    }
    const head = `  ${r.rule}  ${r.title}: ${r.violations.length} violation(s)`
    lines.push(head)
    const shown = r.violations.slice(0, maxPerRule)
    for (const v of shown) {
      lines.push(`        ${v.file}:${v.line}  ${v.message}`)
    }
    if (r.violations.length > shown.length) {
      lines.push(`        ... ${r.violations.length - shown.length} more`)
    }
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTestExt(p: string): string {
  return p.replace(TEST_EXT_RE, "")
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

function findFirstMatchLine(text: string, ...patterns: readonly RegExp[]): number {
  for (const re of patterns) {
    const flagged = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)
    flagged.lastIndex = 0
    const m = flagged.exec(text)
    if (m) {
      return text.slice(0, m.index).split("\n").length
    }
  }
  return 1
}

// Convenience: filesystem-driven entry for the CLI.
export async function runTestAuditFromDisk(
  root: string,
  testsDir = "tests",
): Promise<{
  report: TestAuditReport
  files: { ts: TestFile[]; js: TestFile[] }
}> {
  const files = await collectTestFiles(root, testsDir)
  const report = runAllRules(files)
  // Strip text bodies before returning so callers don't carry MB of payload.
  return {
    report,
    files: {
      ts: files.ts.map((f) => ({ path: f.path, text: "" })),
      js: files.js.map((f) => ({ path: f.path, text: "" })),
    },
  }
}

// Re-export for tests / external scripting
export { basename }

import { access, readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { isPythonTestFile, normalizeRepoPath } from "./impacted-test-discovery"
import { stripInlineComment } from "./python-source-text"

// These are an OVERALL SIZE/COST BUDGET on advisory context, NOT a relevance
// filter. Existing repo-test expectations are unranked PUBLIC evidence; we surface
// as many of the discovered files' asserts as fit the budget and let the model
// judge relevance. The previous values (2 files / 4 expectations) combined with a
// keyword-overlap re-rank withheld test contracts whose wording did not lexically
// match the issue symbols — exactly the context-withholding this module must avoid.
// Each fact is rendered ≤240 chars (boundHead in llm-evidence-packet), so the prompt
// cost is bounded by maxExpectations × ~240B ≈ a few KB — a deliberate size budget.
const DEFAULT_MAX_TEST_FILES = 4
const DEFAULT_MAX_EXPECTATIONS = 16
/** Skip reading any candidate test file larger than this (OOM guard; real Python
 *  test files are << 4 MiB, so this only rejects pathological/binary outliers). */
const MAX_TEST_FILE_BYTES = 4 * 1024 * 1024
/** Per-fs-call timeout. The sibling rg/git discovery paths bound their work by time;
 *  these fs probes previously bounded only by size, so a hung `stat`/`readdir`/
 *  `readFile` on a stale network mount (some bench sandboxes mount over the box FS)
 *  could stall owner-test discovery for the whole instance indefinitely. */
const DEFAULT_FS_TIMEOUT_MS = 10_000

/** Bound a single fs await. On timeout the underlying fs promise is abandoned (left
 *  to settle/GC) and the caller receives `fallback` — the same degrade as a `.catch`,
 *  so discovery yields fewer facts rather than hanging.
 *  @internal exported for unit tests. */
export const withFsTimeout = <T>(p: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
// PER_FILE_EXPECTATION_SCAN_CAP is the per-file READ/COST bound (how many asserts we
// mine from one file). PER_FILE_EXPECTATION_CAP is the per-file OUTPUT floor used when
// splitting the overall budget across files; it is a fairness floor (every discovered
// file contributes at least this many facts), never a relevance filter. We default the
// per-file output cap to the scan cap so a single discovered file is bounded only by
// the read/cost bound + the overall maxExpectations budget — no keyword re-rank.
const PER_FILE_EXPECTATION_CAP = 4
const PER_FILE_EXPECTATION_SCAN_CAP = 16
const ASSERTION_LINE =
  /\bassert\b|pytest\.raises|assert(?:Equal|NotEqual|In|NotIn|True|False|Is|IsNone|Regex|Raises|RaisesRegex)\b|match\s*=/
const TEST_DEF = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/
const PATH_TOKEN = /(^|[\s'"])([A-Za-z0-9_./:-]+\.py(?:::[A-Za-z0-9_./:-]+)?)(?=$|[\s'"])/g

const normalizeLine = (line: string): string => line.trim().replace(/\s+/g, " ")

const boundedLiteral = (value: string, max = 120): string => {
  const normalized = normalizeLine(value)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

const PY_STRING_TOKEN = /[rRuUbBfF]*(["'])(.*?)(?<!\\)\1/g

const quotedLiteralValues = (line: string): string[] => {
  const out: string[] = []
  let current = ""
  let previousEnd: number | undefined
  const flush = (): void => {
    const value = boundedLiteral(current)
    if (value !== "" && !out.includes(value)) out.push(value)
    current = ""
  }
  for (const match of line.matchAll(PY_STRING_TOKEN)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const gap = previousEnd === undefined ? "" : line.slice(previousEnd, start)
    const body = match[2] ?? ""
    if (current !== "" && gap.trim() === "") {
      current += body
    } else {
      flush()
      current = body
    }
    previousEnd = end
  }
  flush()
  return out
}

export const ownerTestPathsFromCommands = (commands: readonly string[]): readonly string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const command of commands) {
    for (const match of command.matchAll(PATH_TOKEN)) {
      const raw = normalizeRepoPath((match[2] ?? "").split("::")[0] ?? "")
      if (raw === "" || !isPythonTestFile(raw) || seen.has(raw)) continue
      seen.add(raw)
      out.push(raw)
    }
  }
  return out
}

/** The conventional Python test paths for ONE owner module, in probe order.
 *  Empty when the owner is not a probeable module (not `.py`, itself a test
 *  file, or a bare `.py` with no basename).
 *
 *  A unit because the OWNER-RELATIVE rule is the whole contract and it is easy
 *  to violate one path at a time: a bare repo-root `tests/test_<base>.py` is
 *  deliberately NOT probed for a NESTED owner, because multiple owners sharing a
 *  module basename would each generate that same repo-root path and mis-attribute
 *  an unrelated global test. A repo-root owner (`dir === ""`) still gets
 *  `tests/test_<base>.py` — that is its OWN sibling dir, which is the same rule. */
const pythonTestLayoutCandidates = (owner: string): string[] => {
  const norm = normalizeRepoPath(owner)
  if (!norm.endsWith(".py") || isPythonTestFile(norm)) return []
  const slash = norm.lastIndexOf("/")
  const dir = slash === -1 ? "" : norm.slice(0, slash)
  const base = norm.slice(slash + 1).replace(/\.py$/, "")
  if (base === "") return []
  const parentSlash = dir.lastIndexOf("/")
  const parent = parentSlash === -1 ? "" : dir.slice(0, parentSlash)
  const candidates = [
    dir === "" ? `tests/test_${base}.py` : `${dir}/tests/test_${base}.py`,
    dir === "" ? `test_${base}.py` : `${dir}/test_${base}.py`,
  ]
  if (parent !== "") candidates.push(`${parent}/tests/test_${base}.py`)
  return candidates
}

/**
 * T2 — convention-based test-file candidates for owner modules, used as a
 * bounded source-search FALLBACK when no command-derived test path exists. For
 * owner `pkg/sub/mod.py`, probe the standard Python test layouts:
 * `pkg/sub/tests/test_mod.py`, `pkg/sub/test_mod.py`, `pkg/tests/test_mod.py`,
 * `tests/test_mod.py`. Pure PATH derivation by module namespace (no gold, no
 * oracle, no `test_patch`); the caller reads only files that actually exist. The
 * derivation is a fixed Python layout convention, not a tuned heuristic.
 */
export const ownerTestCandidatesFromModules = (
  ownerFiles: readonly string[],
): readonly string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const owner of ownerFiles) {
    for (const candidate of pythonTestLayoutCandidates(owner)) {
      if (candidate === "" || seen.has(candidate)) continue
      seen.add(candidate)
      out.push(candidate)
    }
  }
  return out
}

const existingTestFiles = async (
  sandbox: string,
  candidates: readonly string[],
  max: number,
  timeoutMs: number,
): Promise<string[]> => {
  const out: string[] = []
  for (const candidate of candidates) {
    if (out.length >= max) break
    // Existence check only — `access` does NOT read the file into memory, so a
    // pathologically large probe candidate cannot OOM the prober (the actual
    // bounded read happens later in `appendFactsFromTestFile`).
    const exists = await withFsTimeout(
      access(join(sandbox, candidate))
        .then(() => true)
        .catch(() => false),
      timeoutMs,
      false,
    )
    if (exists) out.push(candidate)
  }
  return out
}

const dedupePaths = (paths: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (p === "" || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** Enumerate existing `test_*.py` files in each owner module's `tests/` dir and
 *  its own dir. Catches projects that DON'T follow the `test_<module>.py` name
 *  convention (e.g. astropy's `tests/test_sampled.py` for `timeseries/core.py`),
 *  which the pure-convention candidates miss. Pure directory listing of the
 *  sandbox working tree — no gold / oracle / test_patch. */
/** The two directories one owner module contributes to the glob probe: its
 *  sibling `tests/` dir and its own dir, IN THAT ORDER. Empty when the owner is
 *  not a probeable module (not `.py`, or itself a test file).
 *
 *  A unit because that order is load-bearing — a project that keeps a real
 *  `tests/` package must be probed there before the loose files sitting next to
 *  the module — and because the skip rule and the dir derivation are one single
 *  decision about whether this owner has a module namespace at all. */
const ownerModuleProbeDirs = (owner: string): readonly string[] => {
  const norm = normalizeRepoPath(owner)
  if (!norm.endsWith(".py") || isPythonTestFile(norm)) return []
  const slash = norm.lastIndexOf("/")
  const dir = slash === -1 ? "" : norm.slice(0, slash)
  return [dir === "" ? "tests" : `${dir}/tests`, dir]
}

/** Append every `test_*.py` file directly inside `testDir` to `out`, in sorted
 *  name order. Returns true once `out` has reached `max`, meaning the caller
 *  must stop probing entirely.
 *
 *  A unit because the cap has to be honoured MID-directory — one huge `tests/`
 *  dir must not blow past `max` — which is only expressible where the push
 *  happens, so the caller cannot re-check the bound instead. An unreadable or
 *  slow directory yields nothing rather than throwing: this probe is
 *  best-effort evidence, never a hard dependency. */
const appendTestFilesFrom = async (
  sandbox: string,
  testDir: string,
  timeoutMs: number,
  max: number,
  out: string[],
): Promise<boolean> => {
  const names = await withFsTimeout(
    readdir(join(sandbox, testDir)).catch(() => [] as string[]),
    timeoutMs,
    [] as string[],
  )
  for (const name of [...names].sort()) {
    if (name.startsWith("test_") && name.endsWith(".py")) {
      out.push(testDir === "" ? name : `${testDir}/${name}`)
      if (out.length >= max) return true
    }
  }
  return false
}

const globOwnerModuleTests = async (
  sandbox: string,
  ownerFiles: readonly string[],
  max: number,
  timeoutMs: number,
): Promise<string[]> => {
  const out: string[] = []
  const seenDir = new Set<string>()
  for (const owner of ownerFiles) {
    for (const testDir of ownerModuleProbeDirs(owner)) {
      if (seenDir.has(testDir)) continue
      seenDir.add(testDir)
      if (await appendTestFilesFrom(sandbox, testDir, timeoutMs, max, out)) return out
    }
  }
  return out
}

const expectationFact = (args: {
  readonly file: string
  readonly testName: string | undefined
  readonly line: string
}): string | undefined => {
  if (!ASSERTION_LINE.test(args.line)) return undefined
  const literals = quotedLiteralValues(args.line)
  const location = args.testName === undefined ? args.file : `${args.file}::${args.testName}`
  if (literals.length > 0) {
    return `${location} exact/public literal: ${literals.join(" | ")}`
  }
  const normalized = boundedLiteral(args.line, 180)
  return normalized === "" ? undefined : `${location} assertion: ${normalized}`
}

/** The triple-quote token OPENING at `i`, or undefined. `"""` is tested first so
 *  the two tokens can never be confused at the same index. */
const tripleTokenAt = (text: string, i: number): '"""' | "'''" | undefined =>
  text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) ? "'''" : undefined

/** Consume the triple-quoted span whose OPENING token sits at `open`, returning
 *  the newline-only replacement for its content plus the index just past it.
 *
 *  A unit because proper open/close PAIRING is the whole subtlety: the close is
 *  searched from `open + 3` — never from `open` — so a span's own opening token
 *  can never be re-read as its own close, and a lone CLOSING `'''` is never
 *  mis-read as an open (the M1 bug). An UNTERMINATED span is consumed to EOF and
 *  keeps only its newlines too: mining fake asserts out of an invalid open string
 *  is a worse failure mode than losing recall after that point. Blanking to
 *  exactly the newlines is what keeps line / `TEST_DEF` tracking aligned. */
const consumeTripleSpan = (
  text: string,
  quote: string,
  open: number,
): { blanked: string; next: number } => {
  const contentStart = open + 3
  const close = text.indexOf(quote, contentStart)
  const end = close === -1 ? text.length : close
  return {
    blanked: text.slice(contentStart, end).replace(/[^\n]/g, ""),
    next: close === -1 ? text.length : close + 3,
  }
}

/** Consume the single/double-quoted literal whose OPENING quote sits at `open`,
 *  returning its verbatim text (quotes included) and the index just past it.
 *
 *  A unit, and the deliberate sibling of {@link consumeTripleSpan}, because
 *  escape handling is its entire subtlety: a backslash consumes the NEXT
 *  character without ever testing it against the closing quote, so `"a\""` does
 *  not close early. Consuming a whole literal at once is also what guarantees a
 *  triple-quote token appearing INSIDE an ordinary string is never mistaken for
 *  a docstring opener — the scanner simply never looks at those bytes. An
 *  unterminated literal is consumed to EOF. */
const consumeQuotedLiteral = (text: string, open: number): { text: string; next: number } => {
  const quote = text[open] ?? ""
  let literal = quote
  let i = open + 1
  while (i < text.length) {
    const ch = text[i] ?? ""
    literal += ch
    if (ch === "\\") {
      literal += text[i + 1] ?? ""
      i += 2
      continue
    }
    i += 1
    if (ch === quote) break
  }
  return { text: literal, next: i }
}

/** Remove EVERY triple-quoted span (docstrings AND triple-quoted string values)
 *  with a string-aware scanner, preserving only the newlines inside each span so
 *  line / `TEST_DEF` tracking stays aligned. Triple-quote tokens inside ordinary
 *  single/double-quoted strings are ignored. An unterminated triple span keeps
 *  only its newlines too: mining fake asserts from an invalid/open string is a
 *  worse failure mode than losing recall after that point.
 *
 *  DESIGN (settled after 4 audit rounds): we deliberately do NOT try to keep
 *  triple-quoted message VALUES while dropping docstrings. Distinguishing the two by
 *  text position (`;` / block-`:` / continuation-line context) is unreliable and
 *  repeatedly mis-mined docstring prose as a FALSE expectation — the exact wrong-steer
 *  class this module exists to prevent. A false expectation actively mis-steers
 *  generation; a missed one is mere recall loss. Triple-quoted assertion messages are
 *  rare (the real astropy-13033 shape uses adjacent `r"..." r"..."` SINGLE-quoted
 *  strings, which this never touches), so stripping all triple spans trades a rare
 *  recall loss for eliminating the entire false-steer class — the correct safety
 *  direction.
 *
 *  Proper open/close pairing (not a leading-`'''` heuristic) so a lone CLOSING `'''`
 *  is never mis-read as an OPEN (the M1 bug). */
const stripTripleQuoted = (text: string): string => {
  let out = ""
  let i = 0
  while (i < text.length) {
    const maybeTriple = tripleTokenAt(text, i)
    if (maybeTriple !== undefined) {
      const span = consumeTripleSpan(text, maybeTriple, i)
      out += span.blanked
      i = span.next
      continue
    }
    const ch = text[i] ?? ""
    if (ch === '"' || ch === "'") {
      const literal = consumeQuotedLiteral(text, i)
      out += literal.text
      i = literal.next
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Strip triple-quoted spans, then strip `#` comments (whole-line AND inline). */
const stripCommentsAndDocstrings = (text: string): string[] =>
  stripTripleQuoted(text).split("\n").map(stripInlineComment)

/** How ONE character outside any string literal moves the bracket depth: `+1`
 *  for an opener, `-1` for a closer, `0` for everything else.
 *
 *  A unit because the opener and closer sets must stay SYMMETRIC — an opener
 *  listed without its closer leaves a line permanently unbalanced, which makes
 *  `toLogicalLines` over-join across the next test boundary. Keeping both lists
 *  adjacent in one function is what makes such an asymmetry visible. */
const bracketDelta = (c: string | undefined): number => {
  if (c === "(" || c === "[" || c === "{") return 1
  if (c === ")" || c === "]" || c === "}") return -1
  return 0
}

/** Net bracket depth contributed by a line, IGNORING brackets inside single/double
 *  quoted string literals (with backslash escapes). String-aware so an in-string
 *  bracket can never leave `toLogicalLines` stuck open and over-join the next test. */
const netBracketDelta = (line: string): number => {
  let depth = 0
  let q: string | undefined
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (q !== undefined) {
      if (c === "\\") {
        i += 1
        continue
      }
      if (c === q) q = undefined
      continue
    }
    if (c === '"' || c === "'") q = c
    else depth += bracketDelta(c)
  }
  return depth
}

/** Join physical lines into logical lines across unbalanced brackets so a multi-line
 *  `pytest.raises(match=( r"..." r"..." ))` is mined as ONE line. Bracket counting is
 *  string-AWARE (`netBracketDelta`), and every `TEST_DEF` line force-flushes the
 *  buffer so a stray unbalance can never leak a literal across a test boundary. */
const toLogicalLines = (lines: readonly string[]): string[] => {
  const out: string[] = []
  let buf = ""
  let depth = 0
  const flush = (): void => {
    if (buf !== "") out.push(buf)
    buf = ""
    depth = 0
  }
  for (const line of lines) {
    if (TEST_DEF.test(line)) flush()
    buf = buf === "" ? line : `${buf} ${line.trim()}`
    depth = Math.max(0, depth + netBracketDelta(line))
    if (depth === 0) flush()
  }
  flush()
  return out
}

const expectationsFromTestFile = (
  path: string,
  text: string,
  perFileExpectationCap = PER_FILE_EXPECTATION_CAP,
): readonly string[] => {
  // STABLE, PARAMETER-FREE ORDER: mined assertions are surfaced in SOURCE ORDER
  // (file top→bottom). We deliberately do NOT re-rank by issue-symbol keyword
  // overlap: that re-rank was a relevance GUESS that pre-empted which test contract
  // the model got to weigh and, combined with the small cap, withheld relevant
  // expectations whose wording did not lexically match the issue symbols. These are
  // ADVISORY public evidence; the model judges relevance. Truncation here is purely
  // the read/cost bound (PER_FILE_EXPECTATION_SCAN_CAP) and the per-file output cap.
  // The effective per-file ceiling is the smaller of the caller's output cap and the
  // read/cost scan bound: a single file never contributes more than we are willing to
  // mine, and the overall budget (maxExpectations) is enforced by the caller.
  const cap = Math.min(perFileExpectationCap, PER_FILE_EXPECTATION_SCAN_CAP)
  const out: string[] = []
  let currentTest: string | undefined
  for (const logicalLine of toLogicalLines(stripCommentsAndDocstrings(text))) {
    const testMatch = TEST_DEF.exec(logicalLine)
    if (testMatch?.[1] !== undefined) currentTest = testMatch[1]
    const fact = expectationFact({
      file: path,
      testName: currentTest,
      line: logicalLine,
    })
    if (fact === undefined || out.includes(fact)) continue
    out.push(fact)
    if (out.length >= cap) break
  }
  return out
}

const appendFactsFromTestFile = async (args: {
  readonly sandbox: string
  readonly relPath: string
  readonly out: string[]
  readonly maxExpectations: number
  readonly perFileExpectationCap: number
  readonly timeoutMs: number
}): Promise<boolean> => {
  const abs = join(args.sandbox, args.relPath)
  // Bound the read: `globOwnerModuleTests` enumerates ANY `test_*.py` on disk, so a
  // pathological multi-hundred-MB file would otherwise be slurped whole into memory.
  // Real test files are tiny; cap so a malformed/huge file is skipped, not OOM'd.
  const size = await withFsTimeout(
    stat(abs)
      .then((s) => s.size)
      .catch(() => -1),
    args.timeoutMs,
    -1,
  )
  if (size < 0 || size > MAX_TEST_FILE_BYTES) return false
  const text = await withFsTimeout(
    readFile(abs, "utf8").catch(() => null),
    args.timeoutMs,
    null,
  )
  if (text === null) return false
  for (const fact of expectationsFromTestFile(args.relPath, text, args.perFileExpectationCap)) {
    if (args.out.includes(fact)) continue
    args.out.push(fact)
    if (args.out.length >= args.maxExpectations) return true
  }
  return false
}

export const extractVerificationOwnerTestExpectations = async (args: {
  readonly sandbox: string
  readonly ownerNearTests: readonly string[]
  /** T2 — localized owner module files (witness/resolved/stage1). Used ONLY as a
   *  source-search fallback when `ownerNearTests` is empty: convention-derived
   *  test files that exist are read for expectations. Absent ⇒ command-only
   *  behavior, byte-identical to before T2. */
  readonly localizedOwnerFiles?: readonly string[]
  /** Public issue symbols from `extractIssueHint`. ACCEPTED for caller compatibility
   *  but NO LONGER used to order or filter expectations: the keyword-overlap re-rank
   *  was a relevance guess that withheld test contracts whose wording did not lexically
   *  match the issue symbols. Expectations are now surfaced UNRANKED (source order)
   *  within the size budget so the model — not a heuristic — judges relevance. */
  readonly issueSymbols?: readonly string[]
  readonly maxTestFiles?: number
  readonly maxExpectations?: number
  /** Per-fs-call timeout for the on-disk probes (access/readdir/stat/readFile).
   *  Absent ⇒ {@link DEFAULT_FS_TIMEOUT_MS} (10s) — far below any turn deadline, so a
   *  hung mount degrades to fewer facts instead of stalling the instance. Exposed for
   *  tests; the driver relies on the default. */
  readonly fsTimeoutMs?: number
}): Promise<readonly string[]> => {
  const maxFiles = args.maxTestFiles ?? DEFAULT_MAX_TEST_FILES
  const maxExpectations = args.maxExpectations ?? DEFAULT_MAX_EXPECTATIONS
  if (maxFiles < 1 || maxExpectations < 1) return []
  const fsTimeoutMs = args.fsTimeoutMs ?? DEFAULT_FS_TIMEOUT_MS
  const commandTestCandidates = ownerTestPathsFromCommands(args.ownerNearTests).slice(0, maxFiles)
  const commandTestFiles = await existingTestFiles(
    args.sandbox,
    commandTestCandidates,
    maxFiles,
    fsTimeoutMs,
  )
  // T2 fallback: command-derived EXISTING files take precedence; otherwise probe
  // owner-module test files on disk. This keeps command authority when it points
  // at a real test, but does not let a stale/missing command path disable the
  // bounded source-search fallback entirely. The fallback first tries the
  // `test_<module>.py` convention, then ENUMERATES the owner's `tests/` dir for
  // any `test_*.py` (projects like astropy use one-test-file-per-feature, so
  // `test_<module>.py` often does not exist). Pure path/dir discovery — no gold,
  // no test_patch.
  const testFiles =
    commandTestFiles.length > 0
      ? commandTestFiles
      : dedupePaths([
          ...(await existingTestFiles(
            args.sandbox,
            ownerTestCandidatesFromModules(args.localizedOwnerFiles ?? []),
            maxFiles,
            fsTimeoutMs,
          )),
          ...(await globOwnerModuleTests(
            args.sandbox,
            args.localizedOwnerFiles ?? [],
            maxFiles,
            fsTimeoutMs,
          )),
        ]).slice(0, maxFiles)
  if (testFiles.length === 0) return []
  const perFileExpectationCap = Math.max(
    PER_FILE_EXPECTATION_CAP,
    Math.ceil(maxExpectations / testFiles.length),
  )
  const out: string[] = []
  for (const relPath of testFiles) {
    const filled = await appendFactsFromTestFile({
      sandbox: args.sandbox,
      relPath,
      out,
      maxExpectations,
      perFileExpectationCap,
      timeoutMs: fsTimeoutMs,
    })
    if (filled) return out
  }
  return out
}

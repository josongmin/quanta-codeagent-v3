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
  const push = (candidate: string): void => {
    if (candidate === "" || seen.has(candidate)) return
    seen.add(candidate)
    out.push(candidate)
  }
  for (const owner of ownerFiles) {
    const norm = normalizeRepoPath(owner)
    if (!norm.endsWith(".py") || isPythonTestFile(norm)) continue
    const slash = norm.lastIndexOf("/")
    const dir = slash === -1 ? "" : norm.slice(0, slash)
    const base = norm.slice(slash + 1).replace(/\.py$/, "")
    if (base === "") continue
    const parentSlash = dir.lastIndexOf("/")
    const parent = parentSlash === -1 ? "" : dir.slice(0, parentSlash)
    // Owner-RELATIVE layouts only. A bare repo-root `tests/test_${base}.py` is
    // deliberately NOT probed for a nested owner: multiple owners sharing a module
    // basename would each generate the same repo-root path and mis-attribute an
    // unrelated global test (audit finding). A repo-root owner (dir === "") still
    // gets `tests/test_${base}.py` as its own first candidate below.
    push(dir === "" ? `tests/test_${base}.py` : `${dir}/tests/test_${base}.py`)
    push(dir === "" ? `test_${base}.py` : `${dir}/test_${base}.py`)
    if (parent !== "") push(`${parent}/tests/test_${base}.py`)
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
const globOwnerModuleTests = async (
  sandbox: string,
  ownerFiles: readonly string[],
  max: number,
  timeoutMs: number,
): Promise<string[]> => {
  const out: string[] = []
  const seenDir = new Set<string>()
  for (const owner of ownerFiles) {
    const norm = normalizeRepoPath(owner)
    if (!norm.endsWith(".py") || isPythonTestFile(norm)) continue
    const slash = norm.lastIndexOf("/")
    const dir = slash === -1 ? "" : norm.slice(0, slash)
    for (const testDir of [dir === "" ? "tests" : `${dir}/tests`, dir]) {
      if (seenDir.has(testDir)) continue
      seenDir.add(testDir)
      const names = await withFsTimeout(
        readdir(join(sandbox, testDir)).catch(() => [] as string[]),
        timeoutMs,
        [] as string[],
      )
      for (const name of [...names].sort()) {
        if (name.startsWith("test_") && name.endsWith(".py")) {
          out.push(testDir === "" ? name : `${testDir}/${name}`)
          if (out.length >= max) return out
        }
      }
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
  let quote: string | undefined
  let triple: { quote: string; contentStart: number } | undefined

  while (i < text.length) {
    if (triple !== undefined) {
      if (text.startsWith(triple.quote, i)) {
        out += text.slice(triple.contentStart, i).replace(/[^\n]/g, "")
        i += 3
        triple = undefined
      } else {
        i += 1
      }
      continue
    }

    const ch = text[i] ?? ""
    if (quote !== undefined) {
      out += ch
      if (ch === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      i += 1
      continue
    }

    const maybeTriple = text.startsWith('"""', i)
      ? '"""'
      : text.startsWith("'''", i)
        ? "'''"
        : undefined
    if (maybeTriple !== undefined) {
      triple = { quote: maybeTriple, contentStart: i + 3 }
      i += 3
      continue
    }

    out += ch
    if (ch === '"' || ch === "'") quote = ch
    i += 1
  }
  if (triple !== undefined) out += text.slice(triple.contentStart).replace(/[^\n]/g, "")
  return out
}

/** Strip triple-quoted spans, then strip `#` comments (whole-line AND inline). */
const stripCommentsAndDocstrings = (text: string): string[] =>
  stripTripleQuoted(text).split("\n").map(stripInlineComment)

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
    else if (c === "(" || c === "[" || c === "{") depth += 1
    else if (c === ")" || c === "]" || c === "}") depth -= 1
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
  const text = await withFsTimeout(readFile(abs, "utf8").catch(() => null), args.timeoutMs, null)
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

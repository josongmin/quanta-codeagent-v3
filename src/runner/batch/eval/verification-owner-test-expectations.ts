import { access, readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { isPythonTestFile, normalizeRepoPath } from "./impacted-test-discovery"

const DEFAULT_MAX_TEST_FILES = 2
const DEFAULT_MAX_EXPECTATIONS = 4
/** Skip reading any candidate test file larger than this (OOM guard; real Python
 *  test files are << 4 MiB, so this only rejects pathological/binary outliers). */
const MAX_TEST_FILE_BYTES = 4 * 1024 * 1024
const PER_FILE_EXPECTATION_CAP = 2
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
): Promise<string[]> => {
  const out: string[] = []
  for (const candidate of candidates) {
    if (out.length >= max) break
    // Existence check only — `access` does NOT read the file into memory, so a
    // pathologically large probe candidate cannot OOM the prober (the actual
    // bounded read happens later in `appendFactsFromTestFile`).
    const exists = await access(join(sandbox, candidate))
      .then(() => true)
      .catch(() => false)
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
      const names = await readdir(join(sandbox, testDir)).catch(() => [] as string[])
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

const identifierParts = (text: string): string[] =>
  [...text.matchAll(/[A-Za-z0-9_]+/g)].flatMap((match) =>
    (match[0] ?? "")
      .split(/_+/)
      .flatMap((chunk) => chunk.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/))
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part !== ""),
  )

const evidenceSymbolTokens = (text: string): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const match of text.matchAll(/[A-Za-z0-9_]+/g)) {
    const raw = match[0] ?? ""
    const compact = raw.replace(/_/g, "").toLowerCase()
    if (compact !== "") out.add(compact)
    for (const part of identifierParts(raw)) out.add(part)
  }
  return out
}

const issueSymbolMatchesEvidence = (
  symbol: string,
  evidenceTokens: ReadonlySet<string>,
): boolean => {
  const compact = symbol.replace(/[^A-Za-z0-9]/g, "").toLowerCase()
  if (compact.length < 2) return false
  if (evidenceTokens.has(compact)) return true
  const parts = identifierParts(symbol)
  return parts.length > 0 && parts.every((part) => evidenceTokens.has(part))
}

const issueSymbolScore = (evidenceText: string, issueSymbols: readonly string[]): number => {
  if (issueSymbols.length === 0) return 0
  const evidenceTokens = evidenceSymbolTokens(evidenceText)
  return issueSymbols.filter((symbol) => issueSymbolMatchesEvidence(symbol, evidenceTokens)).length
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

/** Truncate a line at the first `#` OUTSIDE a string literal — removing a trailing
 *  (or whole-line) comment. String-aware (single/double quotes with backslash
 *  escapes) so a `#` inside a legitimate quoted message (e.g. "color #fff") is kept.
 *  Without this, a stale message parked in an INLINE trailing comment leaks into the
 *  mined `exact/public literal` and FALSE-STEERS generation (round-5 finding). */
const stripInlineComment = (line: string): string => {
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
    else if (c === "#") return line.slice(0, i)
  }
  return line
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
  issueSymbols: readonly string[] = [],
  perFileExpectationCap = PER_FILE_EXPECTATION_CAP,
): readonly string[] => {
  const out: { fact: string; score: number; order: number }[] = []
  let currentTest: string | undefined
  let order = 0
  for (const logicalLine of toLogicalLines(stripCommentsAndDocstrings(text))) {
    const testMatch = TEST_DEF.exec(logicalLine)
    if (testMatch?.[1] !== undefined) currentTest = testMatch[1]
    const fact = expectationFact({
      file: path,
      testName: currentTest,
      line: logicalLine,
    })
    if (fact === undefined || out.some((entry) => entry.fact === fact)) continue
    // Rank by assertion/test evidence only. The file path is source authority,
    // not semantic evidence; including it makes every astropy/timeseries fact
    // match a TimeSeries issue symbol and preserves noisy early asserts.
    out.push({
      fact,
      score: issueSymbolScore(`${currentTest ?? ""} ${logicalLine}`, issueSymbols),
      order,
    })
    order += 1
    if (out.length >= PER_FILE_EXPECTATION_SCAN_CAP) break
  }
  return out
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, perFileExpectationCap)
    .map((entry) => entry.fact)
}

const appendFactsFromTestFile = async (args: {
  readonly sandbox: string
  readonly relPath: string
  readonly out: string[]
  readonly maxExpectations: number
  readonly perFileExpectationCap: number
  readonly issueSymbols: readonly string[]
}): Promise<boolean> => {
  const abs = join(args.sandbox, args.relPath)
  // Bound the read: `globOwnerModuleTests` enumerates ANY `test_*.py` on disk, so a
  // pathological multi-hundred-MB file would otherwise be slurped whole into memory.
  // Real test files are tiny; cap so a malformed/huge file is skipped, not OOM'd.
  const size = await stat(abs)
    .then((s) => s.size)
    .catch(() => -1)
  if (size < 0 || size > MAX_TEST_FILE_BYTES) return false
  const text = await readFile(abs, "utf8").catch(() => null)
  if (text === null) return false
  for (const fact of expectationsFromTestFile(
    args.relPath,
    text,
    args.issueSymbols,
    args.perFileExpectationCap,
  )) {
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
  /** Public issue symbols from `extractIssueHint`. Used only to order bounded
   *  facts within an already-discovered public test file; it never discovers a
   *  new file or changes source authority. */
  readonly issueSymbols?: readonly string[]
  readonly maxTestFiles?: number
  readonly maxExpectations?: number
}): Promise<readonly string[]> => {
  const maxFiles = args.maxTestFiles ?? DEFAULT_MAX_TEST_FILES
  const maxExpectations = args.maxExpectations ?? DEFAULT_MAX_EXPECTATIONS
  if (maxFiles < 1 || maxExpectations < 1) return []
  const commandTestCandidates = ownerTestPathsFromCommands(args.ownerNearTests).slice(0, maxFiles)
  const commandTestFiles = await existingTestFiles(args.sandbox, commandTestCandidates, maxFiles)
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
          )),
          ...(await globOwnerModuleTests(args.sandbox, args.localizedOwnerFiles ?? [], maxFiles)),
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
      issueSymbols: args.issueSymbols ?? [],
    })
    if (filled) return out
  }
  return out
}

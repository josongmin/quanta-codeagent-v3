/**
 * `@/apps/terminal/verify-gate/oracle-taint` — the no-leak SSOT.
 *
 * The cardinal rule: the gate must NEVER credit access to the hidden oracle (the task's `/tests/`
 * verifier / grader / private corpus). Two shapes of peeking: (1) a DIRECT reference to a test path,
 * (2) LAUNDERING — `cp /tests/golden.csv ref.csv && diff out ref.csv` diffs against a clean-LOOKING
 * name whose CONTENT is the hidden oracle. {@link isUnfair} + {@link buildTaintedRefs} are the ONE
 * place both shapes are decided, so EVERY classifier that must refuse peeking (compare, self-test,
 * …) imports the same predicate and refuses byte-identically — a classifier physically cannot "have
 * its own weaker oracle check" (the jul-3 hell-audit F2 root cause).
 *
 * PURE / LEAF. Token-level + no cwd/symlink resolution BY DESIGN (bounded; interpreter-copies,
 * tar round-trips, and `cp <file> <bareword-dir>` remain out of scope — a provenance RFC). Fail-
 * closed: under-taint would teach peeking.
 */

import { isExerciseCommand } from "./exercise"
import { baseName, leaderAndArgs, normalizeToken, STATEMENT_SEP } from "./tokenize"

/** The hidden-oracle LOCATION markers — a DIRECTORY / role, NOT a filename convention. A run/read
 *  touching one of these is peeking (query-optimize's `golden.sql` lives in `/tests/`). Kept SEPARATE
 *  from the name markers below because the two layers need different answers on a `test_*.py` NAME:
 *   • the SELF-TEST layer must CREDIT `python test_fib.py` — that is exactly how an agent names its
 *     OWN self-test — so it refuses on LOCATION only ({@link isOracleLocation}).
 *   • the COMPARE layer must SUSPECT a `test_*.py` reference — a `diff out test_x.py` could be diffing
 *     against a hidden fixture — so it refuses on location + NAME ({@link TEST_PATH_MARKERS}). */
export const ORACLE_LOCATION_MARKERS: readonly RegExp[] = [
  /(^|\/)tests?(\/|$)/i, // /tests/, tests/, a `test`/`tests` DIR segment
  /verifier/i,
  /grader/i,
  /(^|\/)private(\/|$)/i,
]

/** COMPARE-layer path markers: the oracle LOCATIONS plus the `test_*.py` / `*_test.py` NAME shapes
 *  (a compared reference with that name may be a hidden fixture). P2-A (RFC jul-3): bare-NAME
 *  heuristics (answer/solution/golden/expected_output) were DROPPED — they self-contradicted the
 *  compare layer's REFERENCE_HINT, so `diff mine.csv expected_output.csv` (a task-provided cwd pair)
 *  was wrongly refused. */
export const TEST_PATH_MARKERS: readonly RegExp[] = [
  ...ORACLE_LOCATION_MARKERS,
  /(^|\/)test_[^/]*/i, // test_*.py-style fixtures
  /(^|\/)[^/]*_test(\.[^/]*)?$/i, // *_test.py-style fixtures
]

/** True iff a path operand points into a verifier/test/answer corpus (R1 — never a fair reference,
 *  COMPARE layer: location + test-name shapes). */
export const isTestPath = (operand: string): boolean =>
  TEST_PATH_MARKERS.some((re) => re.test(operand))

/** True iff a path operand points at the hidden-oracle LOCATION (a dir / verifier / grader / private
 *  — NOT a test-NAMED file). The SELF-TEST layer's oracle check: an agent's own `test_fib.py` stays
 *  creditable, but a run reading `/app/tests/...` is peeking. */
export const isOracleLocation = (operand: string): boolean =>
  ORACLE_LOCATION_MARKERS.some((re) => re.test(operand))

/** True iff `tok` is in the taint set — an exact tainted path, or a file UNDER a tainted DIRECTORY
 *  (a `dir/`-terminated taint entry that prefixes the operand). Marker-independent membership; the
 *  two `isUnfair*` predicates below OR it with their respective marker set. */
const inTaint = (tok: string, tainted: ReadonlySet<string>): boolean => {
  const n = normalizeToken(tok)
  if (tainted.has(n)) return true
  for (const t of tainted) if (t.endsWith("/") && n.startsWith(t)) return true
  return false
}

/** COMPARE-layer operand refusal: a verifier/test path (location OR test-name) or a laundering-
 *  tainted file. Shared by the taint pre-pass (default source pred) and the L1 operand check so both
 *  refuse byte-identically. */
export const isUnfair = (tok: string, tainted: ReadonlySet<string>): boolean =>
  isTestPath(normalizeToken(tok)) || inTaint(tok, tainted)

/** SELF-TEST-layer operand refusal: the hidden-oracle LOCATION or a laundering-tainted file — but
 *  NOT a test-NAMED file (that is the agent's own self-test). */
export const isUnfairLocation = (tok: string, tainted: ReadonlySet<string>): boolean =>
  isOracleLocation(normalizeToken(tok)) || inTaint(tok, tainted)

/** Copy-shaped leaders whose LAST operand receives the content of the earlier operands. */
const TAINT_COPIERS: ReadonlySet<string> = new Set(["cp", "mv", "ln", "install", "rsync"])

/** All `>`/`>>` redirect targets in a command SEGMENT. Fd-redirects (`2>err`) included — the stderr
 *  of a test-reading command is still oracle-derived; over-taint is the safe direction. */
const redirectTargets = (segment: string): string[] => {
  const out: string[] = []
  for (const m of segment.matchAll(/>{1,2}\s*([^\s;|&<>]+)/g)) {
    const t = m[1]
    if (t !== undefined) out.push(t)
  }
  return out
}

/** The mutable taint accumulator threaded through the laundering scan: the
 *  membership test plus the two taint operations every write-site needs. Held
 *  in ONE record so each extracted step gets exactly the vocabulary it uses and
 *  every step sees the SAME live set (taint is transitive within a run). */
type TaintSink = {
  /** True iff `tok` is an oracle SOURCE (per the caller's predicate) or is
   *  already tainted by an earlier statement. */
  readonly unfairTok: (tok: string) => boolean
  /** Taint a copy DESTINATION verbatim: a `dir/`-terminated dst becomes a directory-prefix taint
   *  (via {@link isUnfair}); an exact filename becomes an exact taint. */
  readonly taintDest: (raw: string) => void
  /** Taint a KNOWN-directory destination (a `-t DIR`) as a `dir/` prefix even without a trailing
   *  slash — every file `cp -t` drops into it is oracle-derived. */
  readonly taintDir: (raw: string) => void
}

/** Responsibility: taint a laundering statement's OUTPUT SINKS — every `>`/`>>`
 *  redirect target and every `dd of=` target. The caller gates this on the
 *  statement NOT running the deliverable. */
const taintRedirectSinks = (stmt: string, sink: TaintSink): void => {
  for (const t of redirectTargets(stmt)) sink.taintDest(t)
  for (const m of stmt.matchAll(/\bof=([^\s;|&]+)/g)) {
    const t = m[1]
    if (t !== undefined) sink.taintDest(t)
  }
}

/** Responsibility: taint every non-flag `tee` operand — a `tee ref` inside a
 *  laundering statement writes the oracle content into `ref`. */
const taintTeeTargets = (args: readonly string[], sink: TaintSink): void => {
  for (const a of args) if (!a.startsWith("-")) sink.taintDest(a)
}

/** Responsibility: taint the destination of a GNU `-t DIR` /
 *  `--target-directory[=DIR]` copy, where DEST is the FLAG argument and the
 *  positionals are sources (operand order is inverted). Returns false when the
 *  leader carries no such flag, so the caller falls back to the positional form. */
const taintTargetDirectoryCopy = (args: readonly string[], sink: TaintSink): boolean => {
  const tIdx = args.findIndex((a) => a === "-t" || a === "--target-directory")
  const eqArg = args.find((a) => a.startsWith("--target-directory="))
  if (tIdx < 0 && eqArg === undefined) return false
  const flagArg = tIdx >= 0 ? args[tIdx + 1] : undefined
  const dir = tIdx >= 0 ? flagArg : eqArg?.slice((eqArg?.indexOf("=") ?? -1) + 1)
  const srcs = args.filter((a) => !a.startsWith("-") && a !== flagArg)
  if (dir !== undefined && srcs.some(sink.unfairTok)) sink.taintDir(dir)
  return true
}

/** Responsibility: taint the destination of a POSITIONAL copy (`cp a b`,
 *  `cp a b dir/`) — the LAST operand receives the earlier operands' content. */
const taintPositionalCopy = (args: readonly string[], sink: TaintSink): void => {
  const operands = args.filter((a) => !a.startsWith("-"))
  if (operands.length < 2) return
  const dst = operands[operands.length - 1]
  const srcs = operands.slice(0, -1)
  if (dst !== undefined && srcs.some(sink.unfairTok)) sink.taintDest(dst)
}

/** Responsibility: walk a laundering statement's PIPE STAGES — `tee` targets
 *  (skipped for a deliverable run) and the destination of every copy-shaped
 *  leader, in either the `-t DIR` or the positional operand form. */
const taintPipeStages = (stmt: string, runsDeliverable: boolean, sink: TaintSink): void => {
  for (const seg of stmt.split("|")) {
    const { leader, args } = leaderAndArgs(seg)
    if (leader === "") continue
    const base = baseName(leader)
    if (base === "tee") {
      if (!runsDeliverable) taintTeeTargets(args, sink)
      continue
    }
    if (!TAINT_COPIERS.has(base)) continue
    // GNU `-t DIR` / `--target-directory[=DIR]`: DEST is the flag arg, positionals are sources.
    if (taintTargetDirectoryCopy(args, sink)) continue
    taintPositionalCopy(args, sink)
  }
}

/** Responsibility: decide whether ONE statement can launder the oracle and, if
 *  so, taint everything it writes. A statement that references no unfair source
 *  cannot launder one, so it is skipped whole. */
const taintLaunderingStatement = (stmt: string, sink: TaintSink): void => {
  if (stmt.trim().length === 0) return
  if (!stmt.split(/\s+/).some((t) => t.length > 0 && sink.unfairTok(t))) return
  // (a) redirect / `dd of=` / `tee` targets — SKIPPED when the statement RUNS THE DELIVERABLE
  //     (its own stdout is output, not laundered oracle; `./solve tests/in > out` stays fair).
  const runsDeliverable = isExerciseCommand(stmt)
  if (!runsDeliverable) taintRedirectSinks(stmt, sink)
  // (b) walk PIPE STAGES: `tee` targets (skipped for a deliverable run) + copy-shaped leaders.
  taintPipeStages(stmt, runsDeliverable, sink)
}

/** Build the tainted-path set from the model's own commands, in order (transitive: `cp /tests/g a
 *  && cp a b` taints both `a` and `b`). PURE; exported for direct unit-pinning.
 *
 *  TWO calibrations (jul-3 hell-audit R2):
 *   • A redirect target is NOT tainted when its statement RUNS THE DELIVERABLE (an exercise): the
 *     deliverable's OWN stdout is output, not laundered oracle — `./solve tests/in > out` stays fair.
 *     `cat /tests/g > ref` (cat is not an exercise) still taints `ref`.
 *   • A DIRECTORY destination taints a `dir/` PREFIX, and GNU `-t DIR` inverts operand order (DEST
 *     first) — both handled explicitly. */
export const buildTaintedRefs = (
  commands: readonly string[],
  /** How to decide a token is an ORACLE SOURCE worth propagating taint from. COMPARE layer uses the
   *  default (location + test-name); the SELF-TEST layer passes {@link isOracleLocation} so an
   *  agent's own `cp test_fib.py ref` does not spuriously taint `ref` (test_fib.py is not an oracle). */
  isOracleSource: (operand: string) => boolean = isTestPath,
): ReadonlySet<string> => {
  const tainted = new Set<string>()
  const sink: TaintSink = {
    unfairTok: (tok) => isOracleSource(normalizeToken(tok)) || inTaint(tok, tainted),
    taintDest: (raw) => {
      tainted.add(normalizeToken(raw))
    },
    taintDir: (raw) => {
      const d = normalizeToken(raw)
      tainted.add(d.endsWith("/") ? d : `${d}/`)
    },
  }
  for (const command of commands) {
    // STATEMENT level (pipe kept inside): only a statement that REFERENCES an unfair source can
    // launder it, and a pipe carries that source to a downstream `tee`/redirect in the SAME
    // statement (`cat /tests/g | tee ref`).
    for (const stmt of command.split(STATEMENT_SEP)) taintLaunderingStatement(stmt, sink)
  }
  return tainted
}

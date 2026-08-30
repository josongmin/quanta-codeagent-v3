/**
 * Refresh the bare-catch baseline table in
 * `tests/unit/silent-catch-24h-ratchet.test.ts`.
 *
 * The 24h silent-catch ratchet pins observed bare-`} catch {` counts across a
 * fixed set of code regions ("buckets"). As silent-catch sites are deliberately
 * removed, the baseline must tighten — otherwise the ratchet permits a re-grow
 * back up to the loose ceiling. This script automates that tighten step so an
 * operator can run a single `bun run baseline:silent-catch` instead of
 * hand-editing the literals.
 *
 * HOW THIS SCRIPT SPENT ITS LIFE UNABLE TO FAIL. Everything below the
 * "contract" heading was true of the script and false of the repository. It
 * searched for a declaration named `BASELINES`; the ratchet ships
 * `BARE_CATCH_BASELINE`, so `--check` took the "no table ⇒ wire-up pending"
 * branch on every CI run and that branch returned 0. Underneath that sat a
 * SECOND dead layer: the ratchet test never emitted the `[silent-catch]` line
 * this script parses, so even a matching declaration would have yielded zero
 * observations, an empty tighten plan, and a printed pass. Both halves are
 * closed now, and the branches that used to absorb a broken contract into an
 * exit 0 are fatal instead — see the exit-code table below.
 *
 * Contract with the target test file. TWO declaration shapes are recognised,
 * and no others:
 *
 *   const BARE_CATCH_BASELINE: Readonly<Record<string, number>> = {
 *     "<bucket-1>": 0,
 *     "<bucket-2>": 0,
 *   }
 *
 *   const BASELINES: ReadonlyArray<{ id: string; observed: number }> = [
 *     { id: "<bucket-1>", observed: 0 },
 *     …
 *   ]
 *
 * The first is what the repository ships. The second is the shape this script
 * was written against and is kept because the parser's own unit tests pin it.
 *
 * Every bucket emits one machine-readable line per run — on the PASS path too,
 * not only on failure, since a steady state and an un-measured state have to be
 * distinguishable:
 *
 *   [silent-catch] id=<bucket-id> observed=<N> baseline=<M>
 *
 * This script:
 *   1. Locates the test file (configurable via TARGET env / argv).
 *   2. If the file does NOT exist → write-mode exits 0 (idempotent no-op);
 *      CHECK-mode treats it as fatal, because a deleted ratchet is the drift
 *      this gate exists to catch, not an excuse to skip it.
 *   3. Runs `bun test <target>` and captures stdout + stderr.
 *   4. Parses every `[silent-catch] id=… observed=… baseline=…` line into
 *      a tighten map, and refuses to proceed if the target reported nothing,
 *      reported a bucket the table does not contain, or failed for a reason
 *      the parsed rows do not explain.
 *   5. Rewrites the table IN PLACE — only DECREASING values (a tighten); a
 *      parsed observed ABOVE the existing baseline is a regression and the
 *      script exits non-zero (the ratchet test is already FAIL in that
 *      direction).
 *
 * Idempotence: running the script twice in a row on a clean tree produces zero
 * diff on the second invocation — verified by the dry-run check at the end of
 * `main()`.
 *
 * Zero new dependencies. Pure helpers exported for unit testing without a real
 * bun-test spawn.
 */
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ────────────────────────────────────────────────────────────────────────────
// Pure parsers
// ────────────────────────────────────────────────────────────────────────────

export interface ObservedRow {
  readonly id: string
  readonly observed: number
}

/**
 * Extract every `[silent-catch] id=<X> observed=<N> baseline=<M>` row from
 * arbitrary captured `bun test` output. The line shape matches BOTH the
 * stderr-tightening message AND the stdout-failure message — same fields
 * either way.
 *
 * Returns one row per match, deduped by `id` (last observed wins; bun-test
 * may print the same bucket twice across retries). Lines without all three
 * fields are silently skipped — partial output (truncated stream) must not
 * fabricate a tighten.
 */
export const parseObservedRows = (text: string): readonly ObservedRow[] => {
  // Anchor the keys so a stray `id=` in an unrelated test message can't
  // smuggle a bogus row.
  // `/` is in the charset because the shipped ratchet keys its buckets by FILE
  // PATH (`src/agent/loop.ts`), not by a dotted label. Without it every real
  // row was skipped even once the emitter existed.
  const re = /\[silent-catch\]\s+id=([A-Za-z0-9_./-]+)\s+observed=(\d+)\s+baseline=(\d+)\b/g
  const seen = new Map<string, ObservedRow>()
  for (const m of text.matchAll(re)) {
    const id = m[1]
    const obsStr = m[2]
    if (id === undefined || obsStr === undefined) continue
    seen.set(id, { id, observed: Number(obsStr) })
  }
  return [...seen.values()]
}

export interface BaselineEntry {
  readonly id: string
  readonly value: number
  /** Source-file offset (start of the `{ id: … }` object literal) for
   *  in-place rewriting. */
  readonly start: number
  /** Source-file offset (one past the closing `}` of the object literal). */
  readonly end: number
  /** Verbatim source slice — what the rewriter will swap. */
  readonly raw: string
  /** Offsets of the NUMERIC LITERAL inside the row, when the parser knows
   *  them. Splicing these is shape-agnostic, which is what lets one rewriter
   *  serve both the ARRAY and the RECORD declaration. Optional so an entry
   *  built by hand (the parser's own tests do this) stays valid; the rewriter
   *  falls back to the ARRAY-shaped `observed: N` replacement. */
  readonly valueStart?: number
  readonly valueEnd?: number
}

/** The ARRAY declaration this script was originally written against. */
export const ARRAY_PREFIX = "const BASELINES: ReadonlyArray<{ id: string; observed: number }> = ["

/** The RECORD declaration that ACTUALLY SHIPPED, in
 *  `tests/unit/silent-catch-24h-ratchet.test.ts`. Recognising only
 *  {@link ARRAY_PREFIX} is why the `--check` CI gate could not fail: the real
 *  file never matched, so every run took the "no table ⇒ wire-up pending"
 *  branch, which returns 0 by design. */
export const RECORD_PREFIX = "const BARE_CATCH_BASELINE: Readonly<Record<string, number>> = {"

/** Index of the delimiter that closes a literal opened at `from`, or -1. */
const closingIndex = (source: string, from: number, open: string, close: string): number => {
  let depth = 1
  let i = from
  while (i < source.length) {
    const ch = source[i]
    if (ch === open) depth++
    else if (ch === close) depth--
    if (depth === 0) return i
    i++
  }
  return -1
}

/** Index of the `}` that closes a top-level RECORD declaration, or -1.
 *
 *  NOT brace-balanced, deliberately. MEASURED: the shipped table documents its
 *  own history in `//` comments, and those comments quote the very construct
 *  the ratchet counts — "two silent `} catch {` in the loop slice". A balancing
 *  scan reads that `}` as the end of the table and stops there, which silently
 *  truncated the parse to 3 of the 5 buckets. The two it dropped then came back
 *  as `unknownIds`, which only WARNED.
 *
 *  A top-level `const … = {` is closed by a `}` in COLUMN ZERO, and no comment
 *  body in this file is indented that way. That is the terminator. */
const recordBodyEnd = (source: string, bodyStart: number): number => {
  let offset = bodyStart
  for (const line of source.slice(bodyStart).split("\n")) {
    if (line.startsWith("}")) return offset
    offset += line.length + 1
  }
  return -1
}

/** ARRAY rows: `{ id: "<bucket>", observed: N }`. */
const parseArrayRows = (source: string, bodyStart: number, bodyEnd: number): BaselineEntry[] => {
  const body = source.slice(bodyStart, bodyEnd)
  const rowRe = /\{\s*id:\s*"([A-Za-z0-9_./-]+)"\s*,\s*observed:\s*(\d+)\s*\}/g
  const rows: BaselineEntry[] = []
  for (const m of body.matchAll(rowRe)) {
    const id = m[1]
    const valStr = m[2]
    if (id === undefined || valStr === undefined || m.index === undefined) continue
    const start = bodyStart + m.index
    // The value is the last digit run in the row literal, so locate it from
    // the END — an id containing digits must not be mistaken for it.
    const relValueEnd = m[0].lastIndexOf(valStr) + valStr.length
    rows.push({
      id,
      value: Number(valStr),
      start,
      end: start + m[0].length,
      raw: m[0],
      valueStart: start + relValueEnd - valStr.length,
      valueEnd: start + relValueEnd,
    })
  }
  return rows
}

/** RECORD rows: one `"<file>": N` per line.
 *
 *  Line-anchored rather than free-form so the prose in the shipped table —
 *  which quotes code, paths and backticked snippets in `//` comments — cannot
 *  be read as a row. A comment line simply does not match. */
const parseRecordRows = (source: string, bodyStart: number, bodyEnd: number): BaselineEntry[] => {
  const rowRe = /^([ \t]*)"([^"\n]+)"\s*:\s*(\d+)[,\s]*$/
  const rows: BaselineEntry[] = []
  let offset = bodyStart
  for (const line of source.slice(bodyStart, bodyEnd).split("\n")) {
    const m = rowRe.exec(line)
    const indent = m?.[1]
    const id = m?.[2]
    const valStr = m?.[3]
    if (m !== null && indent !== undefined && id !== undefined && valStr !== undefined) {
      // After the trailing comma/whitespace is stripped the line ENDS with the
      // numeric literal, which pins its offsets exactly.
      const trimmedEnd = line.replace(/[,\s]*$/, "").length
      rows.push({
        id,
        value: Number(valStr),
        start: offset + indent.length,
        end: offset + trimmedEnd,
        raw: line.slice(indent.length, trimmedEnd),
        valueStart: offset + trimmedEnd - valStr.length,
        valueEnd: offset + trimmedEnd,
      })
    }
    offset += line.length + 1 // + the "\n" split consumed
  }
  return rows
}

/**
 * Locate the baseline table inside the test source and parse each row's id,
 * value, and source-offsets.
 *
 * TWO canonical shapes are accepted, tried in declaration order:
 *
 *   ARRAY   const BASELINES: ReadonlyArray<{ id: string; observed: number }> = [
 *             { id: "<bucket>", observed: N }, …
 *           ]
 *
 *   RECORD  const BARE_CATCH_BASELINE: Readonly<Record<string, number>> = {
 *             "<file>": N, …
 *           }
 *
 * Anything else is still REFUSED rather than guessed at — drift in the target
 * must surface, not be silently mis-parsed. What changed is that the shape the
 * repository actually ships is now one of the two recognised ones.
 *
 * Returns `null` if neither table is present.
 */
export const findBaselineTable = (
  source: string,
): { readonly rows: readonly BaselineEntry[]; readonly tableEnd: number } | null => {
  const arrayHead = source.indexOf(ARRAY_PREFIX)
  if (arrayHead !== -1) {
    const bodyStart = arrayHead + ARRAY_PREFIX.length
    const close = closingIndex(source, bodyStart, "[", "]")
    if (close === -1) return null
    return { rows: parseArrayRows(source, bodyStart, close), tableEnd: close + 1 }
  }
  const recordHead = source.indexOf(RECORD_PREFIX)
  if (recordHead !== -1) {
    const bodyStart = recordHead + RECORD_PREFIX.length
    const close = recordBodyEnd(source, bodyStart)
    if (close === -1) return null
    return { rows: parseRecordRows(source, bodyStart, close), tableEnd: close + 1 }
  }
  return null
}

export interface TightenPlan {
  readonly tightened: readonly { id: string; from: number; to: number }[]
  readonly unchanged: readonly string[]
  readonly regressions: readonly { id: string; baseline: number; observed: number }[]
  readonly missingFromOutput: readonly string[]
  readonly unknownIds: readonly string[]
}

/**
 * Decide which baseline rows to tighten given the observed counts.
 *
 *   tightened     → observed < current baseline (ratchet step)
 *   unchanged     → observed === current baseline (steady state)
 *   regressions   → observed > current baseline (ratchet would already
 *                   FAIL the test here; script must NOT loosen)
 *   missingFromOutput → baseline row had no matching parsed observation;
 *                       could mean the bucket passed (no failure line)
 *                       OR the test didn't run that bucket. Conservative
 *                       choice: leave unchanged.
 *   unknownIds    → parsed observation has an id not in the baseline
 *                   table; surfaced for the operator to add manually.
 */
export const planTighten = (
  baseline: readonly BaselineEntry[],
  observed: readonly ObservedRow[],
): TightenPlan => {
  const obsMap = new Map(observed.map((r) => [r.id, r.observed]))
  const baseMap = new Map(baseline.map((r) => [r.id, r.value]))
  const tightened: { id: string; from: number; to: number }[] = []
  const unchanged: string[] = []
  const regressions: { id: string; baseline: number; observed: number }[] = []
  const missingFromOutput: string[] = []
  for (const row of baseline) {
    const obs = obsMap.get(row.id)
    if (obs === undefined) {
      missingFromOutput.push(row.id)
      continue
    }
    if (obs < row.value) tightened.push({ id: row.id, from: row.value, to: obs })
    else if (obs === row.value) unchanged.push(row.id)
    else regressions.push({ id: row.id, baseline: row.value, observed: obs })
  }
  const unknownIds = [...obsMap.keys()].filter((id) => !baseMap.has(id))
  return { tightened, unchanged, regressions, missingFromOutput, unknownIds }
}

/**
 * Apply a tighten plan to the source string, returning the new source.
 * Only DECREASES the literal — regressions are NOT written (caller
 * surfaces them as a non-zero exit). Idempotent: applying the same plan
 * twice yields the identical second-pass output.
 */
export const applyTighten = (
  source: string,
  baseline: readonly BaselineEntry[],
  plan: TightenPlan,
): string => {
  if (plan.tightened.length === 0) return source
  const tightenMap = new Map(plan.tightened.map((t) => [t.id, t.to]))
  // Apply rewrites from highest offset → lowest so prior splices don't
  // invalidate later `start`/`end` indices.
  const ordered = [...baseline].sort((a, b) => b.start - a.start)
  let out = source
  for (const entry of ordered) {
    const newVal = tightenMap.get(entry.id)
    if (newVal === undefined) continue
    const { valueStart, valueEnd } = entry
    if (valueStart !== undefined && valueEnd !== undefined) {
      // Shape-agnostic: splice the numeric literal itself, so the same
      // rewriter serves `observed: N` and `"<file>": N` without knowing which
      // it is looking at.
      out = `${out.slice(0, valueStart)}${newVal}${out.slice(valueEnd)}`
      continue
    }
    const replaced = entry.raw.replace(/observed:\s*\d+/, `observed: ${newVal}`)
    out = `${out.slice(0, entry.start)}${replaced}${out.slice(entry.end)}`
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Impure runner
// ────────────────────────────────────────────────────────────────────────────

interface CmdResult {
  exit: number
  stdout: string
  stderr: string
}

const run = async (argv: string[], cwd: string): Promise<CmdResult> => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exit = await proc.exited
  return { exit, stdout, stderr }
}

export const DEFAULT_TARGET_TEST = "tests/unit/silent-catch-24h-ratchet.test.ts"

/** R10 — `--check` mode flag. The script's primary mode REWRITES the
 *  BASELINES table (auto-tighten on improvement, refuse on regression);
 *  CI cannot opt into the rewrite, so it needs a READ-ONLY shape that
 *  signals "human attention required" via a distinct exit code without
 *  mutating the working tree. Argv order is `--check` first or as the
 *  only argument (treated as a flag, NOT a target path). The legacy
 *  positional target path stays untouched (operators still run
 *  `baseline:silent-catch path/to/test.ts` for one-off rewrites). */
export const CHECK_FLAG = "--check"

const isCheckFlag = (s: string | undefined): boolean => s === CHECK_FLAG

/** Parse the argv tail honoring `--check` as a leading flag. Returns the
 *  resolved target string (`undefined` ⇒ fall back to env / default) and
 *  whether the script is in check-mode. */
export const parseArgv = (
  argv: readonly string[],
): { target: string | undefined; check: boolean } => {
  // `argv[0]`/`argv[1]` are `bun`/`refresh-silent-catch-baseline.ts`; the
  // user-visible args start at index 2.
  const rest = argv.slice(2)
  if (rest.length === 0) return { target: undefined, check: false }
  const head = rest[0]
  if (isCheckFlag(head)) return { target: rest[1], check: true }
  // `--check` could also trail the target (a common ergonomic mistake);
  // accept either order, but never elsewhere — a `--check` in the middle
  // of an unrelated arg list is an operator error worth surfacing.
  if (rest.length >= 2 && isCheckFlag(rest[1])) return { target: head, check: true }
  return { target: head, check: false }
}

const resolveTarget = (repoRoot: string, fromArgv: string | undefined): string => {
  const fromEnv = process.env.QUANTA_SILENT_CATCH_RATCHET_TEST
  const raw = fromArgv ?? fromEnv ?? DEFAULT_TARGET_TEST
  return isAbsolute(raw) ? raw : join(repoRoot, raw)
}

const isMain = (): boolean => {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const here = fileURLToPath(import.meta.url)
  return here === argv1
}

/** Exit codes — overloaded so check-mode preserves write-mode semantics:
 *    0  : ok (no tighten needed; no regression)
 *    1  : write-mode regression (refuses to refresh)
 *    2  : structural — BASELINES table not parseable (both modes)
 *    3  : write-mode post-write fatal (table no longer parseable after write)
 *    4  : write-mode idempotence check failed OR check-mode tighten needed
 *    5  : check-mode regression detected (distinct from write-mode 1 so a CI
 *         step can recognise "ratchet would not move backwards" vs
 *         "regression hit").
 *    6  : check-mode could not VERIFY a bucket — the target ran but some
 *         baseline row produced no observation. Unverified is not the same as
 *         passing, and this gate previously conflated them.
 *    7  : the spawned `bun test` failed for a reason the parsed rows do not
 *         explain (a crash, an import error, a PINNED_LABELS failure). Without
 *         this the script reported OK on a target that never really ran. */
export const EXIT_OK = 0
export const EXIT_WRITE_REGRESSION = 1
export const EXIT_PARSE_FATAL = 2
export const EXIT_POST_WRITE_FATAL = 3
export const EXIT_CHECK_TIGHTEN_NEEDED = 4
export const EXIT_CHECK_REGRESSION = 5
export const EXIT_CHECK_UNVERIFIED = 6
export const EXIT_TARGET_TEST_FAILED = 7

/** Format the tag-prefix every script line uses (`[silent-catch-baseline ...]`).
 *  Centralised so check-mode vs write-mode don't drift the operator-grep
 *  contract. */
const tag = (check: boolean): string => `[silent-catch-baseline${check ? " --check" : ""}]`

/** Emit the "target absent" idempotent no-op line. Same shape across both
 *  modes so the CI step never trips on a pre-wired ratchet contract. */
const emitTargetAbsent = (target: string, check: boolean): number => {
  if (check) {
    // A MISSING ratchet test is the loudest possible drift: the gate this step
    // exists to enforce has been deleted. Reporting "no-op, exit 0" for it is
    // the same defect as the one this fix closes, one level up.
    process.stderr.write(
      `${tag(true)} FATAL: the ratchet test is ABSENT at ${target}.\n` +
        "  The silent-catch gate has nothing to enforce. Restore the test, or\n" +
        "  remove this CI step deliberately — do not let it pass unmeasured.\n",
    )
    return EXIT_PARSE_FATAL
  }
  process.stdout.write(
    `${tag(false)} target ratchet test absent at ${target}; nothing to refresh (idempotent no-op).\n` +
      "  When the test lands with a baseline table, re-run this script.\n",
  )
  return EXIT_OK
}

/** Emit the "BASELINES not parseable" diagnostic. Check-mode degrades to a
 *  stdout notice (CI step stays green so landing the script before the
 *  ratchet contract migrates does not block unrelated PRs); write-mode
 *  emits the harder stderr fatal. Returns the exit code the caller should
 *  use. */
/** Emit the "baseline table not parseable" diagnostic — FATAL in BOTH modes.
 *
 *  This branch used to return 0 in check-mode, on the rationale that the
 *  script could land before the ratchet contract migrated. It never migrated,
 *  and the branch was taken on EVERY CI run for as long as the step existed:
 *  the script looked for `BASELINES` and the repository ships
 *  `BARE_CATCH_BASELINE`. A gate whose only failure path is a `return
 *  EXIT_OK` is not a gate. Both shapes are recognised now, so reaching here
 *  means real drift, and real drift blocks. */
const emitTableMissing = (target: string, check: boolean): number => {
  process.stderr.write(
    `${tag(check)} FATAL: target ${target} contains neither canonical declaration:\n` +
      `    ${ARRAY_PREFIX} … ]\n` +
      `    ${RECORD_PREFIX} … }\n` +
      "  Parser refuses to guess, and refuses to report a pass it cannot support.\n",
  )
  return EXIT_PARSE_FATAL
}

/** Emit a regression diagnostic. Same body across modes; the exit code
 *  differentiation lives in the caller. */
const emitRegression = (
  regs: readonly { id: string; baseline: number; observed: number }[],
  check: boolean,
): void => {
  process.stderr.write(
    `${tag(check)} REGRESSION DETECTED — ${check ? "CI gate FAILS" : "refusing to refresh"}.\n` +
      "  The following buckets exceeded their pinned baseline:\n" +
      regs.map((r) => `    - ${r.id}: observed=${r.observed} > baseline=${r.baseline}\n`).join("") +
      "  Fix the silent-catch site (or justify the increase in an ADR), then re-run.\n",
  )
}

/** Emit unknown-id warnings (never blocks — surfaced for manual add). */
/** Emit the unknown-id diagnostic: a bucket the target REPORTED that the
 *  parsed table does not contain.
 *
 *  Advisory in write-mode (the operator adds the row and re-runs). FATAL in
 *  check-mode, because the two explanations are both gate-defeating: either the
 *  parser truncated the table — which is exactly what happened when a `}` in a
 *  comment ended the scan early — or a real bucket is being enforced against no
 *  ceiling at all. Neither is a pass. */
const emitUnknownIds = (ids: readonly string[], check: boolean): void => {
  if (ids.length === 0) return
  process.stderr.write(
    `${tag(check)} ${check ? "FATAL" : "WARN"}: observed buckets not present in the baseline ` +
      `table${check ? "" : " — add manually"}:\n` +
      ids.map((id) => `    + ${id}\n`).join(""),
  )
}

/** Emit the "tighten available" check-mode notice (operator must rerun
 *  write-mode locally + commit the diff). */
const emitCheckTightenAvailable = (
  tightened: readonly { id: string; from: number; to: number }[],
): void => {
  process.stderr.write(
    `${tag(true)} tighten available for ${tightened.length} bucket(s):\n` +
      tightened.map((t) => `    - ${t.id}: ${t.from} → ${t.to}\n`).join("") +
      "  Run `bun run baseline:silent-catch` locally and commit the tightened " +
      "BASELINES table to clear the CI gate.\n",
  )
}

const main = async (): Promise<number> => {
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const { target: argvTarget, check } = parseArgv(process.argv)
  const target = resolve(resolveTarget(repoRoot, argvTarget))

  if (!existsSync(target)) return emitTargetAbsent(target, check)

  const source = await readFile(target, "utf8")
  const table = findBaselineTable(source)
  if (table === null) return emitTableMissing(target, check)

  process.stderr.write(`${tag(check)} running bun test ${target} …\n`)
  const testRun = await run(["bun", "test", target], repoRoot)
  const captured = `${testRun.stdout}\n${testRun.stderr}`
  const observed = parseObservedRows(captured)
  const plan = planTighten(table.rows, observed)

  // FAIL CLOSED on a target that told us nothing. A parse yielding ZERO rows
  // against a NON-EMPTY baseline table is indistinguishable, downstream, from
  // "every bucket is steady" — `planTighten` files them all under
  // `missingFromOutput` and the script prints a pass. That is exactly how this
  // gate spent its life green. The observation contract is the ratchet test
  // emitting one `[silent-catch] id=… observed=… baseline=…` line per bucket;
  // if none arrived, the test did not run, crashed, or dropped the line.
  if (table.rows.length > 0 && observed.length === 0) {
    process.stderr.write(
      `${tag(check)} FATAL: ${target} produced NO \`[silent-catch] id=… observed=… ` +
        "baseline=…` rows.\n" +
        `  The table has ${table.rows.length} bucket(s), so a run that reports none did not\n` +
        `  measure them. bun test exited ${testRun.exit}. Refusing to report a pass.\n`,
    )
    return EXIT_PARSE_FATAL
  }

  if (plan.regressions.length > 0) {
    emitRegression(plan.regressions, check)
    return check ? EXIT_CHECK_REGRESSION : EXIT_WRITE_REGRESSION
  }

  emitUnknownIds(plan.unknownIds, check)
  if (check && plan.unknownIds.length > 0) return EXIT_CHECK_UNVERIFIED

  // A PARTIALLY reported run cannot clear the gate either. `missingFromOutput`
  // is deliberately conservative in write-mode (leave the literal alone), but
  // "unverified" and "verified steady" are different facts and only one of
  // them is a pass.
  if (check && plan.missingFromOutput.length > 0) {
    process.stderr.write(
      `${tag(true)} UNVERIFIED — ${plan.missingFromOutput.length} pinned bucket(s) reported ` +
        "no observation:\n" +
        plan.missingFromOutput.map((id) => `    ? ${id}\n`).join("") +
        "  The gate cannot vouch for a bucket it did not measure.\n",
    )
    return EXIT_CHECK_UNVERIFIED
  }

  // The spawned suite failed and nothing we parsed accounts for it — a crashed
  // import, or one of the ratchet's OTHER arms (the pinned-label tests) going
  // red. The script has never looked at this exit code at all.
  if (testRun.exit !== 0 && plan.tightened.length === 0) {
    // Preserve the child diagnosis. This wrapper used to replace an import,
    // assertion, or process-launch failure with only "exited 1", forcing a
    // second run that often no longer reproduced the original condition.
    const diagnosis = captured.trim()
    process.stderr.write(
      `${tag(check)} FATAL: bun test ${target} exited ${testRun.exit}, and no baseline\n` +
        "  regression or tighten explains it. Captured child output follows:\n" +
        (diagnosis.length === 0 ? "  <no output>\n" : `${diagnosis}\n`),
    )
    return EXIT_TARGET_TEST_FAILED
  }

  if (plan.tightened.length === 0) {
    process.stdout.write(
      `${tag(check)} no tighten needed ` +
        `(${plan.unchanged.length} steady, ${plan.missingFromOutput.length} not reported).\n`,
    )
    return EXIT_OK
  }

  if (check) {
    // R10 — check-mode SHORT-CIRCUITS before the write phase. CI cannot
    // commit a tightened baseline; a human operator must run the write
    // mode locally and stage the diff. Exit 4 = "your baseline could move
    // forward — run `bun run baseline:silent-catch` locally and commit."
    emitCheckTightenAvailable(plan.tightened)
    return EXIT_CHECK_TIGHTEN_NEEDED
  }

  const next = applyTighten(source, table.rows, plan)
  await writeFile(target, next, "utf8")

  // Idempotence verification: a second-pass apply (no spawn) must
  // produce zero diff. This catches a rewriter bug at the source.
  const reread = await readFile(target, "utf8")
  const tableAfter = findBaselineTable(reread)
  if (tableAfter === null) {
    process.stderr.write(
      "[silent-catch-baseline] FATAL: post-write BASELINES table no longer parseable.\n",
    )
    return EXIT_POST_WRITE_FATAL
  }
  const planAfter = planTighten(tableAfter.rows, observed)
  if (planAfter.tightened.length !== 0) {
    process.stderr.write(
      "[silent-catch-baseline] FATAL: idempotence check failed — second pass would still tighten:\n" +
        planAfter.tightened.map((t) => `    - ${t.id}: ${t.from} → ${t.to}\n`).join(""),
    )
    // Overloaded with EXIT_CHECK_TIGHTEN_NEEDED (4): the two paths are
    // disjoint (this block is unreachable in `--check` mode) so the code
    // collision is intentional and the user-facing meaning ("a tighten
    // would still apply") is congruent across both modes.
    return EXIT_CHECK_TIGHTEN_NEEDED
  }

  process.stdout.write(
    `[silent-catch-baseline] tightened ${plan.tightened.length} bucket(s):\n` +
      plan.tightened.map((t) => `    - ${t.id}: ${t.from} → ${t.to}\n`).join("") +
      `  ${plan.unchanged.length} steady, ${plan.missingFromOutput.length} not reported.\n` +
      "  Re-run the test to confirm GREEN, then commit the tightened baseline.\n",
  )
  return EXIT_OK
}

if (isMain()) {
  const code = await main()
  process.exit(code)
}

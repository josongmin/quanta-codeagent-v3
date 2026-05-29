/**
 * Refresh the BASELINES table in `tests/unit/silent-catch-24h-ratchet.test.ts`.
 *
 * The 24h silent-catch ratchet pins observed silent-catch counts across a
 * fixed set of code regions ("buckets"). As silent-catch sites are
 * deliberately removed, the baseline must tighten — otherwise the ratchet
 * permits a re-grow back up to the loose ceiling. This script automates
 * that tighten step so an operator can run a single `bun run
 * baseline:silent-catch` instead of hand-editing five literals.
 *
 * Contract with the target test file:
 *
 *   const BASELINES: ReadonlyArray<{ id: string; observed: number }> = [
 *     { id: "<bucket-1>", observed: 0 },
 *     { id: "<bucket-2>", observed: 0 },
 *     …
 *   ]
 *
 * On a `bun test` failure each violating row emits one machine-readable
 * line on stderr or stdout:
 *
 *   [silent-catch] id=<bucket-id> observed=<N> baseline=<M>
 *
 * This script:
 *   1. Locates the test file (configurable via TARGET env / argv).
 *   2. If the file does NOT exist → exits 0 with a clear notice (the
 *      ratchet test is a deliberate forthcoming addition, not a required
 *      part of the v3 trunk). This is the idempotent no-op shape.
 *   3. Runs `bun test <target>` and captures stdout + stderr.
 *   4. Parses every `[silent-catch] id=… observed=… baseline=…` line into
 *      a tighten map.
 *   5. Rewrites the BASELINES array IN PLACE — only DECREASING values
 *      (a tighten); a parsed observed ABOVE the existing baseline is a
 *      regression and the script exits non-zero (the ratchet test would
 *      already be FAIL in that direction).
 *
 * Idempotence: running the script twice in a row on a clean tree
 * produces zero diff on the second invocation — verified by the dry-run
 * check at the end of `main()`.
 *
 * Zero new dependencies. Pure helpers exported for unit testing without
 * a real bun-test spawn.
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
  const re = /\[silent-catch\]\s+id=([A-Za-z0-9_.-]+)\s+observed=(\d+)\s+baseline=(\d+)\b/g
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
}

/**
 * Locate the BASELINES table inside the test source and parse each
 * `{ id: "…", observed: N }` row's id, value, and source-offsets.
 *
 * Strict shape: the table MUST be introduced by the canonical
 * declaration prefix
 *
 *   const BASELINES: ReadonlyArray<{ id: string; observed: number }> = [
 *
 * — refusing any other declaration so a future contributor's drift is
 * caught immediately rather than silently mis-parsed.
 *
 * Returns `null` if the table is absent (so the caller can decide
 * whether to error or skip; the script's "test file missing" path
 * never reaches this).
 */
export const findBaselineTable = (
  source: string,
): { readonly rows: readonly BaselineEntry[]; readonly tableEnd: number } | null => {
  const prefix = "const BASELINES: ReadonlyArray<{ id: string; observed: number }> = ["
  const head = source.indexOf(prefix)
  if (head === -1) return null
  const bodyStart = head + prefix.length
  // Scan forward, balancing brackets, until the matching `]` that
  // closes the array literal. The body contains nested `{…}` object
  // literals; we only care about the outer `[` / `]` balance.
  let depth = 1
  let i = bodyStart
  while (i < source.length && depth > 0) {
    const ch = source[i]
    if (ch === "[") depth++
    else if (ch === "]") depth--
    if (depth === 0) break
    i++
  }
  if (depth !== 0) return null
  const tableEnd = i + 1 // include the closing `]`
  const body = source.slice(bodyStart, i)
  // Match each `{ id: "X", observed: N }` row literal.
  const rowRe = /\{\s*id:\s*"([A-Za-z0-9_.-]+)"\s*,\s*observed:\s*(\d+)\s*\}/g
  const rows: BaselineEntry[] = []
  for (const m of body.matchAll(rowRe)) {
    const id = m[1]
    const valStr = m[2]
    if (id === undefined || valStr === undefined || m.index === undefined) continue
    const start = bodyStart + m.index
    const end = start + m[0].length
    rows.push({
      id,
      value: Number(valStr),
      start,
      end,
      raw: m[0],
    })
  }
  return { rows, tableEnd }
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

const resolveTarget = (repoRoot: string): string => {
  const fromEnv = process.env.QUANTA_SILENT_CATCH_RATCHET_TEST
  const fromArgv = process.argv[2]
  const raw = fromArgv ?? fromEnv ?? DEFAULT_TARGET_TEST
  return isAbsolute(raw) ? raw : join(repoRoot, raw)
}

const isMain = (): boolean => {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const here = fileURLToPath(import.meta.url)
  return here === argv1
}

const main = async (): Promise<number> => {
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const target = resolve(resolveTarget(repoRoot))

  if (!existsSync(target)) {
    // Idempotent no-op: the ratchet test is a deliberate forthcoming
    // addition. Operators running this script before it lands should
    // see a clear, non-error explanation rather than a stack trace.
    process.stdout.write(
      `[silent-catch-baseline] target ratchet test absent at ${target}; nothing to refresh (idempotent no-op).\n` +
        "  When the test lands with a BASELINES table, re-run this script.\n",
    )
    return 0
  }

  const source = await readFile(target, "utf8")
  const table = findBaselineTable(source)
  if (table === null) {
    process.stderr.write(
      `[silent-catch-baseline] FATAL: target ${target} does not contain the canonical\n` +
        "  `const BASELINES: ReadonlyArray<{ id: string; observed: number }> = [ … ]`\n" +
        "  declaration. Rewriter refuses to guess.\n",
    )
    return 2
  }

  process.stderr.write(`[silent-catch-baseline] running bun test ${target} …\n`)
  const testRun = await run(["bun", "test", target], repoRoot)
  const captured = `${testRun.stdout}\n${testRun.stderr}`
  const observed = parseObservedRows(captured)
  const plan = planTighten(table.rows, observed)

  if (plan.regressions.length > 0) {
    process.stderr.write(
      "[silent-catch-baseline] REGRESSION DETECTED — refusing to refresh.\n" +
        "  The following buckets exceeded their pinned baseline:\n" +
        plan.regressions
          .map((r) => `    - ${r.id}: observed=${r.observed} > baseline=${r.baseline}\n`)
          .join("") +
        "  Fix the silent-catch site (or justify the increase in an ADR), then re-run.\n",
    )
    return 1
  }

  if (plan.unknownIds.length > 0) {
    process.stderr.write(
      "[silent-catch-baseline] WARN: observed buckets not present in BASELINES — add manually:\n" +
        plan.unknownIds.map((id) => `    + ${id}\n`).join(""),
    )
  }

  if (plan.tightened.length === 0) {
    process.stdout.write(
      `[silent-catch-baseline] no tighten needed (${plan.unchanged.length} steady,` +
        ` ${plan.missingFromOutput.length} not reported).\n`,
    )
    return 0
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
    return 3
  }
  const planAfter = planTighten(tableAfter.rows, observed)
  if (planAfter.tightened.length !== 0) {
    process.stderr.write(
      "[silent-catch-baseline] FATAL: idempotence check failed — second pass would still tighten:\n" +
        planAfter.tightened.map((t) => `    - ${t.id}: ${t.from} → ${t.to}\n`).join(""),
    )
    return 4
  }

  process.stdout.write(
    `[silent-catch-baseline] tightened ${plan.tightened.length} bucket(s):\n` +
      plan.tightened.map((t) => `    - ${t.id}: ${t.from} → ${t.to}\n`).join("") +
      `  ${plan.unchanged.length} steady, ${plan.missingFromOutput.length} not reported.\n` +
      "  Re-run the test to confirm GREEN, then commit the tightened baseline.\n",
  )
  return 0
}

if (isMain()) {
  const code = await main()
  process.exit(code)
}

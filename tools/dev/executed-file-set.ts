/**
 * `tools/dev/executed-file-set` — did the worker run the files it was planned?
 *
 * # The defect this exists to close
 *
 * `run-test-shards.ts` accepted a chunk on `result.executedFiles ===
 * plan.files.length`. A COUNT. A worker that ran 147 of somebody else's files
 * produced a green chunk, a timing observation and a reusable cache receipt
 * claiming the planned set had passed. Nothing downstream could tell, because
 * the receipt recorded the PLAN and never the execution.
 *
 * The matrix worker already compared the exact set, in a sorted-join one-liner
 * nobody else could reach. One rail was right and the other was a count; this
 * module is the single owner, so the answer cannot differ by call site again.
 *
 * # Why a typed verdict and not a boolean
 *
 * "The set did not match" sends someone to re-run 44 chunks blind. Missing,
 * unexpected and collapsing paths are three different accidents — a file that
 * did not run, a file that ran and should not have, and two spellings that
 * normalize to one id — and each names a different thing to go look at.
 *
 * # Duplicates
 *
 * MEASURED on Bun 1.3.14: the JUnit reporter emits one `<testsuite file=…>`
 * for the FILE and one more for every `describe` in it, all with the same
 * attribute — two files produced four tags here. So repeated raw spellings are
 * NORMAL and must not be reported. What is not normal is two DISTINCT raw
 * spellings collapsing onto one id (`a/../a/x.test.ts` beside `a/x.test.ts`),
 * because that is exactly how a substitution hides inside a matching count.
 */

import { createHash } from "node:crypto"
import { relative, resolve } from "node:path"

export interface ExecutedFileSetVerdict {
  readonly ok: boolean
  /** Normalized, sorted, unique ids actually executed. */
  readonly executed: readonly string[]
  /** sha256 over the sorted ids, newline-joined. Empty set hashes the empty string. */
  readonly digestSha256: string
  /** Planned, never executed. */
  readonly missing: readonly string[]
  /** Executed, never planned. */
  readonly unexpected: readonly string[]
  /** Ids reached by more than one distinct raw spelling, or planned twice. */
  readonly duplicate: readonly string[]
  /** Empty when `ok`; otherwise names every category that fired, with ids. */
  readonly reason: string
}

/** Repository-relative, POSIX-separated, with `.`/`..` resolved. */
export const normalizeExecutedPath = (repoRoot: string, file: string): string =>
  relative(repoRoot, resolve(repoRoot, file)).split("\\").join("/")

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

/** sha256 of a normalized id set, so a receipt can carry the set in one field. */
export const executedFileSetDigest = (ids: readonly string[]): string =>
  sha256([...new Set(ids)].sort().join("\n"))

const sorted = (values: Iterable<string>): readonly string[] => [...values].sort()

/**
 * The two places a shard's executed set decides something, as one function.
 *
 * # Why this is not an `if` in the runner
 *
 * It was — `if (!set.ok) throw …` in `validateCompletedShard`, and
 * `if (!executedSet.ok) throw …` in `cacheSuccessfulShard` — and a mutation
 * audit turned BOTH into `if (set.duplicate.length > 99)` with the suite green.
 * The only guard was `expect(runner).toContain("executedFileSetVerdict(")` plus
 * two message strings, and a mutant that neuters the branch leaves every one of
 * those strings in place. `run-test-shards.ts` ends in a top-level `await
 * main()`, so nothing in it can be called from a test; the decision has to live
 * where a test can reach it.
 *
 * `undefined` means "this set is the planned set". Anything else is the message
 * the campaign aborts with, and the two phases keep their distinct wording
 * because they send a reader to different places: one is a worker that lied
 * about what it ran, the other is a receipt about to record that lie.
 */
export const executedSetRefusal = (input: {
  readonly verdict: ExecutedFileSetVerdict
  readonly phase: "verdict" | "cache"
  readonly chunkIndex: number
  readonly totalChunks?: number
}): string | undefined => {
  if (input.verdict.ok) return undefined
  if (input.phase === "cache") {
    return `[test:shards] refusing to cache chunk ${input.chunkIndex}: ${input.verdict.reason}`
  }
  const chunk =
    input.totalChunks === undefined
      ? String(input.chunkIndex)
      : `${input.chunkIndex}/${input.totalChunks}`
  return (
    `[test:shards] EXECUTED-SET MISMATCH chunk=${chunk} — the worker ` +
    `exited 0 but did not run the planned files: ${input.verdict.reason}`
  )
}

/** Raw spellings that collapse onto one id — one id per offending group. */
const collapsingIds = (repoRoot: string, rawSpellings: readonly string[]): readonly string[] => {
  const spellingsById = new Map<string, Set<string>>()
  for (const raw of new Set(rawSpellings)) {
    const id = normalizeExecutedPath(repoRoot, raw)
    const group = spellingsById.get(id) ?? new Set<string>()
    group.add(raw)
    spellingsById.set(id, group)
  }
  return sorted([...spellingsById].filter(([, group]) => group.size > 1).map(([id]) => id))
}

const describe = (label: string, ids: readonly string[]): readonly string[] =>
  ids.length === 0 ? [] : [`${label}=${ids.length} [${ids.slice(0, 8).join(", ")}]`]

/**
 * Compare what a worker was told to run against what its JUnit says it ran.
 *
 * `plannedRaw` and `executedRaw` are both normalized here rather than by the
 * caller: the two rails previously normalized differently (one resolved
 * against the repo root, one did not), which is its own way to make a real
 * mismatch look like agreement.
 */
export const executedFileSetVerdict = (input: {
  readonly repoRoot: string
  readonly plannedRaw: readonly string[]
  readonly executedRaw: readonly string[]
}): ExecutedFileSetVerdict => {
  const { repoRoot, plannedRaw, executedRaw } = input
  const plannedIds = plannedRaw.map((file) => normalizeExecutedPath(repoRoot, file))
  const executedIds = executedRaw.map((file) => normalizeExecutedPath(repoRoot, file))
  const planned = new Set(plannedIds)
  const executed = new Set(executedIds)

  const missing = sorted([...planned].filter((id) => !executed.has(id)))
  const unexpected = sorted([...executed].filter((id) => !planned.has(id)))
  const plannedTwice = sorted(
    new Set(plannedIds.filter((id, index) => plannedIds.indexOf(id) !== index)),
  )
  const duplicate = sorted(new Set([...collapsingIds(repoRoot, executedRaw), ...plannedTwice]))

  const parts = [
    ...describe("missing", missing),
    ...describe("unexpected", unexpected),
    ...describe("duplicate", duplicate),
  ]
  return {
    ok: parts.length === 0,
    executed: sorted(executed),
    digestSha256: executedFileSetDigest([...executed]),
    missing,
    unexpected,
    duplicate,
    reason: parts.join(" "),
  }
}

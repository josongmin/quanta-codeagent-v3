/**
 * `git_co_change` — co-change / related-files tool (§7.2, jun-08 long-tail).
 *
 * Where `git_churn` answers "which files change OFTEN" (single-file frequency),
 * this answers the SECOND-ORDER question Codex/Cursor surface for change-impact
 * analysis: "which OTHER files historically change in the SAME commit as this
 * one?". The co-occurrence matrix is the canonical signal for "if you touch X
 * you probably also need to touch Y" — invaluable for fault localization and
 * for not forgetting a sibling (test/types/barrel) when editing.
 *
 * Mechanism (parity with Codex change-impact / Cursor related-files):
 *   - read `git log --name-only` over a window (same blank-format trick as
 *     git_churn so stdout is purely the per-commit file lists);
 *   - group changed paths PER COMMIT (blank line = commit boundary);
 *   - for a TARGET file, count how many of those commits also touched each
 *     OTHER file → co-occurrence count, plus a Jaccard-style `affinity`
 *     (co-count / commits-touching-either) so a file that ALWAYS ships with the
 *     target ranks above one that merely changes a lot independently.
 *   - with NO target: emit the global top co-change PAIRS (the densest edges of
 *     the matrix) so the agent can spot tightly-coupled clusters.
 *
 * READ-ONLY, CONCURRENCY-SAFE. Pure ranking lives in exported fns for unit
 * tests; the tool is a thin spawn + format wrapper. NO arbitrary thresholds —
 * affinity is the standard Jaccard index, not a tuned cutoff; ties break by
 * path for determinism.
 */
import { byteCompare } from "@/shared"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type GitCoChangeInput, type GitRunner, gitCoChangeInputSchema } from "./types"

/** ASCII Record-Separator (0x1e) — emitted ONCE per commit by `--format=%x1e`.
 *  Unlike an empty `--format=` (which produces NO inter-commit delimiter —
 *  the file lists run together, so commit boundaries are lost), this gives an
 *  unambiguous per-commit marker that can never appear inside a file path. */
const COMMIT_SEP = "\x1e"

/** Build `git log --name-only --format=%x1e` args. Each commit's section is
 *  `<RS>\n\n<file>\n<file>…`, so splitting on the RS marker yields per-commit
 *  blocks the parser can group cleanly (commit boundaries are PRESERVED, which
 *  empty `--format=` does NOT do — that bug inflated co-counts into one group). */
const buildArgs = (since: string | undefined): string[] => {
  const args = ["log", "--name-only", `--format=%x1e`]
  if (since !== undefined) args.push(`--since=${since}`)
  else args.push("-n", "200")
  return args
}

/** Parse `git log --name-only --format=%x1e` output into per-commit file groups.
 *  Split on the Record-Separator marker; within each block the non-empty lines
 *  are the commit's changed files. Empty blocks (and a commit that touched no
 *  files, e.g. a merge) are dropped. Exported pure for tests. */
export const parseCommitGroups = (stdout: string): string[][] => {
  const groups: string[][] = []
  for (const block of stdout.split(COMMIT_SEP)) {
    const files: string[] = []
    for (const raw of block.split("\n")) {
      const file = raw.trim()
      if (file.length > 0) files.push(file)
    }
    if (files.length > 0) groups.push(files)
  }
  return groups
}

export interface CoChangeRow {
  readonly file: string
  /** Commits that touched BOTH the target and this file. */
  readonly coCount: number
  /** Jaccard affinity = coCount / (commits touching either). 0..1. */
  readonly affinity: number
}

/** For a TARGET file, rank the OTHER files by co-occurrence. A file the target
 *  never co-changes with is omitted. Ties: higher coCount, then higher
 *  affinity, then path (deterministic). Exported pure for tests. */
/** Tally per-file co/total commit counts against a target. Pure helper kept
 *  out of {@link rankCoChange} to bound its cognitive complexity. */
const tallyCoChange = (
  groups: readonly string[][],
  target: string,
): { targetCommits: number; co: Map<string, number>; total: Map<string, number> } => {
  const co = new Map<string, number>() // file -> commits touching both
  const total = new Map<string, number>() // file -> commits touching that file (any)
  let targetCommits = 0
  for (const g of groups) {
    const set = new Set(g)
    const hasTarget = set.has(target)
    if (hasTarget) targetCommits++
    for (const f of set) {
      if (f === target) continue
      total.set(f, (total.get(f) ?? 0) + 1)
      if (hasTarget) co.set(f, (co.get(f) ?? 0) + 1)
    }
  }
  return { targetCommits, co, total }
}

/** Descending coCount, then descending affinity, then ascending path. Pure. */
const byCoChangeRank = (a: CoChangeRow, b: CoChangeRow): number => {
  if (b.coCount !== a.coCount) return b.coCount - a.coCount
  if (b.affinity !== a.affinity) return b.affinity - a.affinity
  return byteCompare(a.file, b.file)
}

export const rankCoChange = (
  groups: readonly string[][],
  target: string,
  topN: number,
): { targetCommits: number; rows: CoChangeRow[] } => {
  const { targetCommits, co, total } = tallyCoChange(groups, target)
  const rows: CoChangeRow[] = []
  for (const [file, coCount] of co.entries()) {
    if (coCount === 0) continue
    // union(target, file) = targetCommits + total(file) - coCount (inclusion-exclusion).
    const union = targetCommits + (total.get(file) ?? 0) - coCount
    const affinity = union > 0 ? coCount / union : 0
    rows.push({ file, coCount, affinity })
  }
  rows.sort(byCoChangeRank)
  return { targetCommits, rows: rows.slice(0, topN) }
}

export interface CoChangePair {
  readonly a: string
  readonly b: string
  readonly coCount: number
}

/** With NO target — the densest edges of the co-change matrix (the most-coupled
 *  PAIRS globally). Each unordered pair counted once (a<b by byteCompare).
 *  Exported pure for tests. */
export const rankCoChangePairs = (groups: readonly string[][], topN: number): CoChangePair[] => {
  const pairs = new Map<string, number>()
  for (const g of groups) {
    const files = [...new Set(g)].sort(byteCompare)
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\x00${files[j]}`
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
  }
  return [...pairs.entries()]
    .map(([key, coCount]) => {
      const [a, b] = key.split("\x00")
      return { a: a as string, b: b as string, coCount }
    })
    .sort((x, y) =>
      y.coCount !== x.coCount
        ? y.coCount - x.coCount
        : x.a !== y.a
          ? byteCompare(x.a, y.a)
          : byteCompare(x.b, y.b),
    )
    .slice(0, topN)
}

const formatTargetBody = (target: string, targetCommits: number, rows: CoChangeRow[]): string => {
  if (targetCommits === 0) return `(no commits touched ${target} in window)`
  if (rows.length === 0)
    return `(${target} changed in ${targetCommits} commit(s), but never with another file)`
  const lines = rows.map(
    (r) => `${String(r.coCount).padStart(4)}  ${r.affinity.toFixed(2)}  ${r.file}`,
  )
  return `co-change with ${target} (${targetCommits} commit(s) touched it):\n  co  affinity  file\n${lines.join("\n")}`
}

const formatPairsBody = (pairs: CoChangePair[]): string => {
  if (pairs.length === 0) return "(no co-change pairs in window)"
  const lines = pairs.map((p) => `${String(p.coCount).padStart(4)}  ${p.a}  +  ${p.b}`)
  return `top co-change pairs:\n${lines.join("\n")}`
}

export const gitCoChangeTool = (runner: GitRunner): Tool<GitCoChangeInput> => ({
  name: "git_co_change",
  description:
    "Find files that historically change in the SAME commit as a target file " +
    "(co-occurrence matrix from git history). With `file`: ranks the other " +
    "files by how often they co-changed + a Jaccard affinity. Without `file`: " +
    "the most-coupled file PAIRS globally. Change-impact / related-files signal " +
    "(if you touch X you probably also need Y). Read-only.",
  inputSchema: gitCoChangeInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: GitCoChangeInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitCoChangeInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const { since, file, n } = parsed.data
    const topN = n ?? 20
    const args = buildArgs(since)

    yield {
      type: "progress",
      message: `git co-change${file ? ` for ${file}` : " (pairs)"}${since ? ` --since=${since}` : ""}`,
    }

    const out = await safeRun(runner, args, ctx.cwd, "git co-change", ctx.signal)
    if (out.kind === "spawn-error") {
      yield { type: "result", result: { ok: false, output: out.message } }
      return
    }
    const r = out.result
    if (r.exitCode !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: stderrReason(r.stderr, r.exitCode, "git co-change") },
      }
      return
    }
    const groups = parseCommitGroups(r.stdout)
    if (file !== undefined) {
      const { targetCommits, rows } = rankCoChange(groups, file, topN)
      yield {
        type: "result",
        result: { ok: true, output: formatTargetBody(file, targetCommits, rows) },
      }
      return
    }
    yield {
      type: "result",
      result: { ok: true, output: formatPairsBody(rankCoChangePairs(groups, topN)) },
    }
  },
})

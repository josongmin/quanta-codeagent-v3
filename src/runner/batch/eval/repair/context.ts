/**
 * b2 — Repair seed-message builder (RFC §16, ADR-0014).
 *
 * Pure function: given the running cumulative diff and the latest validator
 * failure tail, produce the seed user message for the next repair round. No
 * dataset / instance reads — same no-leak structural guarantee as the
 * validator (this file imports only from `./types`).
 *
 * Structure (in order):
 *   1. `Repair round <round>.`
 *   2. Original problem statement (verbatim, possibly trimmed if hugely over budget).
 *   3. `Your patch so far (cumulative):` + truncated cumulative diff.
 *   4. `Validation failed. Tail of failing output:` + tail-truncated failTail.
 *   5. Forceful next-step instruction (do NOT revert; fix source; re-verify).
 *
 * Truncation order to fit `maxBytes` (default 12000):
 *   failTail first (keep TAIL), then cumulativeDiff (drop middle hunks, keep
 *   `diff --git` headers + first+last hunks), then trim the problem if still
 *   over budget. Each truncation leaves a marker `… <N bytes truncated>`.
 */
import type { BuildRepairContextArgs } from "./types"

const DEFAULT_MAX = 12000

const HEADER_PROBLEM = "Original problem (verbatim):"
const HEADER_DIFF = "Your patch so far (cumulative):"
const HEADER_PREDICATE = "Typed rail note:"
const HEADER_SIBLINGS =
  "Co-change sites — these files override the SAME method and very likely need the same fix. A single-site edit is INCOMPLETE; apply the change to each:"
const HEADER_FAIL = "Validation failed. Tail of failing output:"
const NEXT_STEPS = [
  "Next steps (MANDATORY):",
  "- Do NOT revert your patch. NEVER run `git checkout`, `git reset`, `git clean`, or `git stash`.",
  "- Analyze the failing output above and fix the SOURCE code (not test files).",
  "- After your edit, rerun the SAME verification command before you stop.",
  "- An unverified edit is not done — iterate until the command passes.",
].join("\n")

const MARKER_OVERHEAD = 40 // worst-case bytes added by a "… <N bytes truncated>" line

const trimTail = (s: string, target: number): string => {
  if (s.length <= target) return s
  const room = Math.max(0, target - MARKER_OVERHEAD)
  const dropped = s.length - room
  return `… <${dropped} bytes truncated>\n${s.slice(-room)}`
}

const trimHead = (s: string, target: number): string => {
  if (s.length <= target) return s
  const room = Math.max(0, target - MARKER_OVERHEAD)
  const dropped = s.length - room
  return `${s.slice(0, room)}\n… <${dropped} bytes truncated>`
}

export const buildRepairContext = (args: BuildRepairContextArgs): string => {
  const maxBytes = args.maxBytes ?? DEFAULT_MAX
  const header = `Repair round ${args.round}.`
  let problem = args.problem
  let diff = args.cumulativeDiff
  let failTail = args.failTail
  const predicateSummary = args.predicateSummary
  // Bounded, deduped sibling list (a handful of file paths — never truncated).
  const siblingOwners = [...new Set(args.siblingOwners ?? [])]

  // Static overhead = headers + labels + next-steps + section separators.
  const compose = (p: string, d: string, f: string): string =>
    [
      header,
      "",
      HEADER_PROBLEM,
      p,
      ...(siblingOwners.length > 0
        ? ["", HEADER_SIBLINGS, siblingOwners.map((file) => `- ${file}`).join("\n")]
        : []),
      "",
      HEADER_DIFF,
      d === "" ? "(no diff produced yet)" : d,
      ...(predicateSummary !== undefined && predicateSummary !== ""
        ? ["", HEADER_PREDICATE, predicateSummary]
        : []),
      "",
      HEADER_FAIL,
      f === "" ? "(no failure output captured)" : f,
      "",
      NEXT_STEPS,
    ].join("\n")

  // Shrink in priority order: failTail TAIL → diff middle → problem HEAD.
  // After each step, re-measure; stop early if under budget. Each section can
  // be trimmed AT MOST ONCE (its budget is the slack left after committing
  // higher-priority sections at their floors).
  const floors = { failTail: 64, diff: 128, problem: 64 }
  let out = compose(problem, diff, failTail)
  if (out.length <= maxBytes) return out

  // Step 1: trim failTail to leave room for current diff+problem (or its floor).
  if (failTail !== "") {
    const otherDiff = diff.length > 0 ? diff.length : 0
    const otherProblem = problem.length
    const overhead = compose("", "", "").length + otherDiff + otherProblem
    const room = Math.max(floors.failTail, maxBytes - overhead)
    failTail = trimTail(failTail, room)
  }
  out = compose(problem, diff, failTail)
  if (out.length <= maxBytes) return out

  // Step 2: trim diff (keep `diff --git` headers + first+last hunks where possible).
  if (diff !== "") {
    const overhead = compose(problem, "", failTail).length
    const room = Math.max(floors.diff, maxBytes - overhead)
    diff = truncateDiff(diff, room)
  }
  out = compose(problem, diff, failTail)
  if (out.length <= maxBytes) return out

  // Step 3: trim problem (head-keep). Last resort.
  if (problem.length > floors.problem) {
    const overhead = compose("", diff, failTail).length
    const room = Math.max(floors.problem, maxBytes - overhead)
    problem = trimHead(problem, room)
  }
  return compose(problem, diff, failTail)
}

/**
 * Drop middle of a unified `git diff`. Keep every `diff --git` header line and
 * the first + last hunk of each file. If still over budget, fall back to a
 * naive head+tail slice (still leaves a truncation marker).
 *
 * Pure: walks the diff lines, classifies sections by `diff --git` boundaries
 * and `@@ ... @@` hunk markers. Does NOT understand instance metadata.
 */
type DiffFile = { header: string[]; hunks: string[][] }

const parseDiff = (diff: string): DiffFile[] => {
  const files: DiffFile[] = []
  let cur: DiffFile | undefined
  let curHunk: string[] | undefined
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { header: [line], hunks: [] }
      files.push(cur)
      curHunk = undefined
      continue
    }
    if (cur === undefined) {
      // Pre-`diff --git` preamble — synthetic file, no hunks.
      cur = { header: [line], hunks: [] }
      files.push(cur)
      continue
    }
    if (line.startsWith("@@")) {
      curHunk = [line]
      cur.hunks.push(curHunk)
      continue
    }
    if (curHunk !== undefined) curHunk.push(line)
    else cur.header.push(line)
  }
  return files
}

const rebuildDiff = (files: readonly DiffFile[]): string => {
  const out: string[] = []
  for (const f of files) {
    out.push(...f.header)
    if (f.hunks.length <= 2) {
      for (const h of f.hunks) out.push(...h)
      continue
    }
    const first = f.hunks[0] ?? []
    const last = f.hunks[f.hunks.length - 1] ?? []
    const droppedHunks = f.hunks.length - 2
    out.push(...first)
    out.push(`… <${droppedHunks} middle hunks truncated>`)
    out.push(...last)
  }
  return out.join("\n")
}

const headTailSqueeze = (s: string, target: number): string => {
  const half = Math.max(128, Math.floor(target / 2) - 32)
  const head = s.slice(0, half)
  const tail = s.slice(-half)
  const dropped = s.length - head.length - tail.length
  return `${head}\n… <${dropped} bytes truncated>\n${tail}`
}

const truncateDiff = (diff: string, target: number): string => {
  if (diff.length <= target) return diff
  const rebuilt = rebuildDiff(parseDiff(diff))
  if (rebuilt.length <= target) return rebuilt
  return headTailSqueeze(rebuilt, target)
}

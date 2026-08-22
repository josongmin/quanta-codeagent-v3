/**
 * `gh_pr_code_tour` — guided PR code-tour tool (§5.4, jun-08 long-tail).
 *
 * Cursor/Codex PR-review surfaces don't just dump a raw diff — they present an
 * ORDERED WALKTHROUGH ("tour stops"): each changed file, then each hunk within
 * it, with a stable anchor (file + new-side line range) the reviewer/agent can
 * jump to, plus per-stop add/del counts so the model knows where the meat is.
 * `gh_pr_review_diff` already returns the raw unified diff; THIS tool is the
 * structured tour OVER that diff — the agent gets a deterministic itinerary
 * instead of re-parsing a wall of `@@` headers itself.
 *
 * Mechanism (parity with Cursor code-tour / Codex review stops):
 *   - fetch `gh pr diff <ref>` (same spawn boundary + ref-injection guard as
 *     every other gh tool);
 *   - parse the unified diff into tour STOPS: one per hunk, carrying the file
 *     path (new side, or old side for a deletion), the new-side line range
 *     `@@ -a,b +c,d @@` → `c..c+d-1`, the optional hunk header context (the
 *     symbol after the second `@@`), and added/removed line counts;
 *   - emit a numbered itinerary; cap the number of stops (bounded output).
 *
 * READ-ONLY. The unified-diff parser is an exported pure fn (unit-tested
 * without a real PR). NO-THROW: a malformed ref, a `gh` failure, or an
 * unparseable diff all collapse to a graceful `ok:false`. NO arbitrary
 * heuristics — the line ranges are read verbatim from the `@@` hunk headers.
 */
import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { normalizeRef, refRejected } from "./ref"
import { DEFAULT_TIMEOUT_MS, defaultGhRunner, type GhRunner } from "./runner"

/** Default + ceiling number of tour stops. A PR with hundreds of hunks would
 *  blow the prompt budget; default 40, hard max 200 (matches review budgets). */
const DEFAULT_MAX_STOPS = 40
const MAX_STOPS_CEILING = 200

export const prCodeTourSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
  maxStops: z
    .number()
    .int()
    .positive()
    .max(MAX_STOPS_CEILING)
    .optional()
    .describe(
      `Max tour stops, one per hunk (default ${DEFAULT_MAX_STOPS}, max ${MAX_STOPS_CEILING})`,
    ),
})
export type PrCodeTourInput = z.infer<typeof prCodeTourSchema>

/** One tour stop = one diff hunk. */
export interface TourStop {
  readonly file: string
  /** New-side start line (1-based) from the `@@ +c,d @@` header. */
  readonly newStart: number
  /** New-side line count from the header (`d`; defaults to 1 when omitted). */
  readonly newLines: number
  /** The context after the second `@@` (often the enclosing symbol), trimmed. */
  readonly context: string
  readonly added: number
  readonly removed: number
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Mutable parse state threaded line-by-line — extracted so each line handler
 *  stays small and {@link parseDiffToTour} reads as a flat dispatch (keeps the
 *  cognitive complexity bounded). */
interface DiffParseState {
  readonly stops: TourStop[]
  currentFile: string
  pendingOldFile: string | undefined
  cur: { file: string; newStart: number; newLines: number; context: string } | undefined
  added: number
  removed: number
}

/** Push the active hunk (if any) as a stop and reset the per-hunk counters. */
const flushHunk = (s: DiffParseState): void => {
  if (s.cur === undefined) return
  s.stops.push({ ...s.cur, added: s.added, removed: s.removed })
  s.cur = undefined
  s.added = 0
  s.removed = 0
}

/** Process ONE diff line, mutating the parse state. Returns nothing. */
const consumeDiffLine = (s: DiffParseState, line: string): void => {
  if (line.startsWith("--- ")) {
    // old-side file marker — remember for deletions where +++ is /dev/null.
    const p = line.slice(4).trim()
    s.pendingOldFile = p === "/dev/null" ? undefined : stripABPrefix(p)
    return
  }
  if (line.startsWith("+++ ")) {
    flushHunk(s)
    const p = line.slice(4).trim()
    s.currentFile = p === "/dev/null" ? (s.pendingOldFile ?? "(deleted)") : stripABPrefix(p)
    s.pendingOldFile = undefined
    return
  }
  const m = HUNK_RE.exec(line)
  if (m !== null) {
    flushHunk(s)
    s.cur = {
      file: s.currentFile,
      newStart: Number(m[1]),
      newLines: m[2] !== undefined ? Number(m[2]) : 1,
      context: (m[3] ?? "").trim(),
    }
    return
  }
  if (s.cur === undefined) return
  // Count content lines inside the active hunk. `+++`/`---` already handled.
  if (line.startsWith("+")) s.added++
  else if (line.startsWith("-")) s.removed++
}

/** Parse a unified diff (as produced by `gh pr diff` / `git diff`) into ordered
 *  tour stops, one per hunk. The current file is tracked from `+++ b/<path>`
 *  headers (falling back to `--- a/<path>` for pure deletions). Exported pure
 *  for unit tests. Never throws — an unrecognized line is skipped. */
export const parseDiffToTour = (diff: string): TourStop[] => {
  const s: DiffParseState = {
    stops: [],
    currentFile: "(unknown)",
    pendingOldFile: undefined,
    cur: undefined,
    added: 0,
    removed: 0,
  }
  for (const line of diff.split("\n")) consumeDiffLine(s, line)
  flushHunk(s)
  return s.stops
}

/** Strip a leading `a/` or `b/` git diff prefix. */
const stripABPrefix = (p: string): string =>
  p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p

const formatTour = (stops: readonly TourStop[], total: number): string => {
  if (stops.length === 0) return "(no changes to tour)"
  const lines = stops.map((s, i) => {
    const end = s.newStart + Math.max(s.newLines, 1) - 1
    const ctx = s.context.length > 0 ? `  — ${s.context}` : ""
    return `${String(i + 1).padStart(3)}. ${s.file}:${s.newStart}-${end}  (+${s.added}/-${s.removed})${ctx}`
  })
  const head = `PR code tour — ${total} stop(s)${stops.length < total ? ` (showing first ${stops.length})` : ""}:`
  return `${head}\n${lines.join("\n")}`
}

export const ghPrCodeTourTool = (runner: GhRunner = defaultGhRunner): Tool<PrCodeTourInput> => ({
  name: "gh_pr_code_tour",
  description:
    "Produce an ORDERED guided walkthrough of a PR's diff — one numbered 'stop' " +
    "per hunk with the file path, new-side line range, enclosing-symbol context, " +
    "and add/remove counts. The structured itinerary over `gh pr diff` (vs " +
    "re-parsing a raw diff). Read-only.",
  inputSchema: prCodeTourSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "none",
  async *execute(input: PrCodeTourInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = prCodeTourSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const ref = normalizeRef(parsed.data.pr)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("PR", parsed.data.pr) } }
      return
    }
    const cap = parsed.data.maxStops ?? DEFAULT_MAX_STOPS
    const argv = ["gh", "pr", "diff", ref]
    yield { type: "progress", message: `gh pr code-tour #${parsed.data.pr}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr diff failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    const all = parseDiffToTour(r.stdout)
    yield {
      type: "result",
      result: { ok: true, output: formatTour(all.slice(0, cap), all.length) },
    }
  },
})

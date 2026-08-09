/** `git_review_diff` — Claude Desktop `reviewDiff` pattern absorption
 *  (ADR-0111).
 *
 *  Posture: READ-ONLY, CONCURRENCY-SAFE, hitlTier "none". The tool extracts a
 *  `git diff base...head` (default `origin/main...HEAD`) and hands it to an
 *  ISOLATED sub-agent reviewer (depth+1, read-only tool registry filtered to
 *  `{read, grep, glob}`, REVIEW-mode seed prompt). The main session's
 *  conversation history is NOT mutated — the reviewer's findings come back as
 *  a single tool result, so the loop's context window is unaffected by the
 *  review itself.
 *
 *  Slice isolation: the sub-agent runner is INJECTED via
 *  `ToolContext.reviewerAgent` (a duck-typed mirror of `SubagentRunner` from
 *  `@/subagent`). `@/tool/git` never imports `@/subagent`; the agent slice is
 *  the only place that knows how to wire the concrete runner in. Absent ⇒
 *  the tool yields a deterministic `ok:false` (no throw, no crash). */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { ReviewerRequest, ReviewerResult, Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { emitReviewCanvasDiffs } from "./review-diff-canvas"
import type { GitRunner } from "./types"

/** Cap on the diff text we inject into the reviewer seed. A 600KB diff blows
 *  past most context windows; truncating with a clear marker keeps the
 *  reviewer useful for the common case and surfaces the truncation to the
 *  caller. Mirrors the `git_diff` tool's `MAX_OUTPUT` posture. */
const MAX_DIFF_BYTES = 50_000

/** REVIEW-mode notice — phrased the same way as `REVIEW_NOTICE` in
 *  `@/agent/prompt` (slice-isolated copy so `@/tool` doesn't import `@/agent`).
 *  The reviewer's seed prepends this to anchor the read-only critique posture. */
const REVIEW_NOTICE = [
  "REVIEW MODE is active. Do NOT modify anything. Investigate with read-only",
  "tools, then deliver findings-first: each finding as { file, line, severity,",
  "what, why, impact }. Order by severity; cut generic praise. No fix patches.",
].join("\n")

/** Tools the reviewer sub-agent is allowed to call. Read-only inspection
 *  only — same posture as `taskKind:"review"` in the subagent slice
 *  (`deriveToolFilter` in `src/subagent/agent-tool.ts`), narrowed to the
 *  three primitives needed to walk the working tree + grep + glob files
 *  referenced in the diff. */
const REVIEWER_TOOL_FILTER: readonly string[] = ["read", "grep", "glob"] as const

export const gitReviewDiffInputSchema = z.object({
  /** Base revision for the three-dot diff. Default `origin/main`. */
  base: z.string().optional().describe("Base revision (default origin/main)"),
  /** Head revision for the three-dot diff. Default `HEAD`. */
  head: z.string().optional().describe("Head revision (default HEAD)"),
  /** Restrict diff to these path(s); shown verbatim to `git diff -- <paths…>`. */
  paths: z.array(z.string()).optional().describe("Restrict review to these paths"),
  /** Optional focus hint injected into the reviewer's seed prompt. */
  focus: z.string().optional().describe("Optional focus hint for the reviewer"),
})
export type GitReviewDiffInput = z.infer<typeof gitReviewDiffInputSchema>

/** Reviewer disposition for a finding (RFC09-2 / A-GAP-4). CLOSED union — the
 *  only exhaustive-guarded new field. `category` and `shortSummary` are OPEN
 *  (free string), so they carry no drift-guard. Mirrors Codex's
 *  `verdict:CONFIRMED|PLAUSIBLE`, lowercased to quanta's convention. */
export type ReviewVerdict = "confirmed" | "plausible"

/** Exhaustive-classification guard for `ReviewVerdict`. Adding a member to the
 *  union without a `true` arm here fails compile (drift-guard). The runtime
 *  `VALID_VERDICTS` set is derived from these keys so the parser cannot drift
 *  from the type. Mirrors the `severity` manual guard (parseOneFinding). */
const VERDICT_MEMBERS: Record<ReviewVerdict, true> = {
  confirmed: true,
  plausible: true,
}
const VALID_VERDICTS = new Set<string>(Object.keys(VERDICT_MEMBERS))

/** Strongly-typed shape we try to parse out of the reviewer's `finalText`. The
 *  reviewer is asked (via REVIEW_NOTICE) to deliver findings in this shape;
 *  if it returns free text instead we fall back to a single-summary result.
 *  We do NOT enforce the JSON schema (the reviewer's posture is "findings-
 *  first", not "must emit JSON"); we OPPORTUNISTICALLY parse. */
export interface ReviewFinding {
  file: string
  line?: number
  severity: "info" | "warning" | "error"
  what: string
  why?: string
  impact?: string
  /** Reviewer disposition (RFC09-2). Optional, closed union. */
  verdict?: ReviewVerdict
  /** Open-ended kebab category slug (RFC09-2). Free string, NOT an enum. */
  category?: string
  /** One-line reviewer summary of the finding (RFC09-2). */
  shortSummary?: string
  /** RFC06-4 (B5) — OPTIONAL anchor binding this finding to a REAL hunk of the
   *  diff the reviewer saw. Validated by `@/tool/git/review-anchor`; an anchor
   *  whose `hunkId`/hashes don't match the diff is marked non-actionable rather
   *  than trusted. Absent ⇒ the old blob-comment shape, byte-identical. */
  anchor?: ReviewCommentAnchor
}

/** RFC06-4 (B5) — a validated anchor for an inline review comment. Bound to a
 *  `(path, hunkId)` of a specific `(beforeHash, afterHash)` diff so the comment
 *  cannot silently re-target a diff the reviewer never saw. Consumed by the
 *  hunk-mutation receipt path; NOT a second finding schema. */
export interface ReviewCommentAnchor {
  readonly path: string
  /** 1-based line the comment addresses (within the anchored hunk's new side). */
  readonly line: number
  /** Hunk id (`h1`, `h2`, …) from `splitHunks(before, after)` on the SAME diff. */
  readonly hunkId: string
  /** sha256 of the diff's `before` content — pins the anchor to that snapshot. */
  readonly beforeHash: string
  /** sha256 of the diff's `after` content. */
  readonly afterHash: string
}

export interface ReviewReport {
  summary: string
  findings: ReviewFinding[]
}

/** Raised by `buildArgs` when `base` or `head` begins with `-` (would be
 *  parsed by `git diff` as an option, not a revision). Caught + turned into
 *  a deterministic `ok:false`. Same posture as `GitDiffBaseRejected` in
 *  `diff.ts`. */
class GitReviewRevRejected extends Error {
  constructor(field: "base" | "head", value: string) {
    super(
      `invalid ${field} revision '${value}': must not begin with '-' ` +
        "(would be parsed as a git option)",
    )
    this.name = "GitReviewRevRejected"
  }
}

const validateRev = (field: "base" | "head", v: string): void => {
  if (v.startsWith("-")) throw new GitReviewRevRejected(field, v)
}

const buildArgs = (input: GitReviewDiffInput): string[] => {
  const base = input.base ?? "origin/main"
  const head = input.head ?? "HEAD"
  validateRev("base", base)
  validateRev("head", head)
  const args: string[] = ["diff", `${base}...${head}`]
  if (input.paths && input.paths.length > 0) args.push("--", ...input.paths)
  return args
}

const truncateDiff = (s: string): { text: string; truncated: boolean } => {
  if (s.length <= MAX_DIFF_BYTES) return { text: s, truncated: false }
  return {
    text: `${s.slice(0, MAX_DIFF_BYTES)}\n… (truncated, ${s.length - MAX_DIFF_BYTES} more bytes)`,
    truncated: true,
  }
}

const buildReviewerPrompt = (
  diffText: string,
  focus: string | undefined,
  truncated: boolean,
): string => {
  const sections: string[] = [REVIEW_NOTICE, ""]
  if (focus !== undefined && focus.length > 0) {
    sections.push(`## Focus`, focus, "")
  }
  sections.push("## Diff under review")
  if (truncated) {
    sections.push("(NOTE: diff was truncated; review what is visible and flag the gap.)")
  }
  sections.push("```diff", diffText, "```", "")
  sections.push(
    "## Output shape",
    "Return JSON: {summary: string, findings: [{file, line?, severity, what, " +
      "why?, impact?, verdict?, category?, shortSummary?}]}.",
    'severity ∈ {"info","warning","error"}. Empty findings list = clean.',
    'verdict ∈ {"confirmed","plausible"} (optional; confirmed = you verified it, ' +
      "plausible = suspected). category = optional kebab-slug (e.g. resource-leak, " +
      "input-validation). shortSummary = optional one-line gist. Omit any field you " +
      "are unsure of rather than guessing.",
  )
  return sections.join("\n")
}

/** Validate + project one raw entry from the reviewer's `findings` array.
 *  Returns the typed finding or `null` if the shape doesn't match. Extracted
 *  from `tryParseReport` to keep cognitive complexity per function under the
 *  biome cap (15). */
const parseOneFinding = (raw: unknown): ReviewFinding | null => {
  if (typeof raw !== "object" || raw === null) return null
  const fo = raw as Record<string, unknown>
  if (typeof fo.file !== "string" || typeof fo.what !== "string") return null
  const sev = fo.severity
  if (sev !== "info" && sev !== "warning" && sev !== "error") return null
  const finding: ReviewFinding = { file: fo.file, severity: sev, what: fo.what }
  if (typeof fo.line === "number") finding.line = fo.line
  if (typeof fo.why === "string") finding.why = fo.why
  if (typeof fo.impact === "string") finding.impact = fo.impact
  // RFC09-2 consumed optional fields — opportunistic + omit-on-malformed.
  if (typeof fo.verdict === "string" && VALID_VERDICTS.has(fo.verdict)) {
    finding.verdict = fo.verdict as ReviewVerdict
  }
  if (typeof fo.category === "string") finding.category = fo.category
  if (typeof fo.shortSummary === "string") finding.shortSummary = fo.shortSummary
  return finding
}

/** Project the parsed JSON object into a typed `ReviewReport`, or `null` if
 *  the top-level shape (summary string + findings array) is wrong. */
const projectReport = (parsed: unknown): ReviewReport | null => {
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as { summary?: unknown; findings?: unknown }
  if (typeof obj.summary !== "string" || !Array.isArray(obj.findings)) return null
  const findings: ReviewFinding[] = []
  for (const f of obj.findings) {
    const projected = parseOneFinding(f)
    if (projected !== null) findings.push(projected)
  }
  return { summary: obj.summary, findings }
}

/** Try `JSON.parse(candidate)` and project it into a report. Returns the
 *  report on success; `null` on any failure (not-JSON, wrong shape). */
const tryParseOne = (candidate: string): ReviewReport | null => {
  const trimmed = candidate.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    return projectReport(JSON.parse(trimmed))
  } catch {
    return null
  }
}

const tryParseReport = (raw: string): ReviewReport | null => {
  // The reviewer may wrap the JSON in fences or prose. Try the raw text
  // first, then a fenced-block extraction.
  const direct = tryParseOne(raw)
  if (direct !== null) return direct
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/i
  const fenced = fenceRe.exec(raw)
  if (fenced?.[1]) return tryParseOne(fenced[1])
  return null
}

/** Render one finding into its display lines. Extracted from `renderReport`
 *  so the RFC09-2 verdict/category line keeps the caller under the biome
 *  cognitive-complexity cap (15). Absent verdict AND category ⇒ no tag line,
 *  so the old-shape render stays byte-identical. */
const renderFinding = (f: ReviewFinding): string[] => {
  const where = f.line !== undefined ? `${f.file}:${f.line}` : f.file
  const out: string[] = [`- [${f.severity}] ${where} — ${f.what}`]
  if (f.verdict !== undefined || f.category !== undefined) {
    const tags: string[] = []
    if (f.verdict !== undefined) tags.push(f.verdict)
    if (f.category !== undefined) tags.push(f.category)
    out.push(`    ${tags.join(" · ")}`)
  }
  if (f.why) out.push(`    why: ${f.why}`)
  if (f.impact) out.push(`    impact: ${f.impact}`)
  return out
}

const renderReport = (report: ReviewReport): string => {
  const lines: string[] = [report.summary, ""]
  if (report.findings.length === 0) {
    lines.push("(no findings)")
    return lines.join("\n").trimEnd()
  }
  for (const f of report.findings) {
    lines.push(...renderFinding(f))
  }
  return lines.join("\n").trimEnd()
}

/** Wrap an error value into a model-facing message. Small helper so the
 *  reviewer-call try/catch in `execute` stays a one-liner (keeps cog cap). */
const errMsg = (e: unknown): string => errMessage(e)

/** Discriminated outcome of the `git diff` extraction step. Pulled out of
 *  `execute()` so the main generator stays linear (each branch yields once
 *  and returns). */
type DiffOutcome =
  | { kind: "deny"; output: string }
  | { kind: "empty" }
  | { kind: "ok"; body: string }

/** Run the validated `git diff` invocation and classify the result.
 *  Never throws — all failure modes (spawn-error, exit>1, schema reject)
 *  surface as `kind:"deny"`. */
const extractDiff = async (
  runner: GitRunner,
  args: string[],
  ctx: ToolContext,
): Promise<DiffOutcome> => {
  const out = await safeRun(runner, args, ctx.cwd, "git diff", ctx.signal)
  if (out.kind === "spawn-error") return { kind: "deny", output: out.message }
  const r = out.result
  // git diff exits 0 (no diff) and 1 (has diff) — both OK; >1 is failure.
  if (r.exitCode > 1) {
    return { kind: "deny", output: stderrReason(r.stderr, r.exitCode, "git diff") }
  }
  const body = r.stdout.trimEnd()
  if (body.length === 0) return { kind: "empty" }
  return { kind: "ok", body }
}

const buildReviewerRequest = (prompt: string, ctx: ToolContext): ReviewerRequest => {
  const childDepth = (typeof ctx.depth === "number" && ctx.depth >= 0 ? ctx.depth : 0) + 1
  return {
    prompt,
    depth: childDepth,
    taskKind: "review",
    toolFilter: REVIEWER_TOOL_FILTER,
    signal: ctx.signal,
  }
}

export const gitReviewDiffTool = (runner: GitRunner): Tool<GitReviewDiffInput> => ({
  name: "git_review_diff",
  description:
    "Review a git diff with an ISOLATED read-only sub-agent reviewer. " +
    "Returns findings-first review output without polluting the main session " +
    "context. Default range is origin/main...HEAD; pass {base, head} to " +
    "override, {paths} to scope, {focus} to bias the reviewer's attention.",
  inputSchema: gitReviewDiffInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "none",

  async *execute(input: GitReviewDiffInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const args = parseAndBuildArgs(input)
    if (args.kind === "deny") {
      yield { type: "result", result: { ok: false, output: args.output } }
      return
    }

    yield { type: "progress", message: `git ${args.argv.join(" ")}` }
    const outcome = await extractDiff(runner, args.argv, ctx)
    if (outcome.kind === "deny") {
      yield { type: "result", result: { ok: false, output: outcome.output } }
      return
    }
    if (outcome.kind === "empty") {
      yield { type: "result", result: emptyDiffResult() }
      return
    }
    if (!ctx.reviewerAgent) {
      yield { type: "result", result: { ok: false, output: REVIEWER_NOT_ATTACHED_MSG } }
      return
    }

    const { text: diffForReviewer, truncated } = truncateDiff(outcome.body)
    const prompt = buildReviewerPrompt(diffForReviewer, args.focus, truncated)
    yield { type: "progress", message: "Delegating to isolated reviewer (depth+1)…" }

    const result = await invokeReviewer(ctx.reviewerAgent, buildReviewerRequest(prompt, ctx))
    // RFC-12 SURFACE B PRODUCER — render the reviewer's anchored findings as a
    // canvas overlay. NO-OP (byte-identical) when the canvas sink is not wired;
    // never throws (best-effort observation, the result is already computed).
    await maybeEmitReviewCanvas(runner, ctx, {
      unifiedDiff: outcome.body,
      findings: result.structured?.findings ?? [],
      base: args.base,
      head: args.head,
    })
    yield { type: "result", result }
  },
})

/** RFC-12 SURFACE B PRODUCER glue — emit the per-file canvas diffs for a review's
 *  findings. Isolated in one helper so `execute` stays under the cognitive cap and
 *  a git-I/O failure in the canvas path can never break the tool result (the
 *  findings already went back to the model). */
const maybeEmitReviewCanvas = async (
  runner: GitRunner,
  ctx: ToolContext,
  args: {
    unifiedDiff: string
    findings: readonly ReviewFinding[]
    base: string
    head: string
  },
): Promise<void> => {
  try {
    await emitReviewCanvasDiffs({ runner, ctx, ...args })
  } catch {
    // Best-effort: a canvas-render failure must never surface as a review
    // failure. Swallow (the tool result is already assembled).
  }
}

/** Result of the schema-parse + argv-build step (synchronous failure mode for
 *  bad input or rejected revisions). Carries the resolved `base`/`head` so the
 *  canvas producer can obtain the per-file before/after (`git show`) over the SAME
 *  revision range the reviewer saw. */
type ArgvOutcome =
  | { kind: "deny"; output: string }
  | { kind: "ok"; argv: string[]; base: string; head: string; focus?: string }

/** Validate input + compose argv. Returns either a deny (bad schema or
 *  leading-`-` revision) or the ready-to-spawn argv. Extracted so `execute`
 *  stays under the cog-complexity cap. */
const parseAndBuildArgs = (input: GitReviewDiffInput): ArgvOutcome => {
  const parsed = gitReviewDiffInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "deny", output: `invalid input: ${parsed.error.message}` }
  }
  try {
    const argv = buildArgs(parsed.data)
    const base = parsed.data.base ?? "origin/main"
    const head = parsed.data.head ?? "HEAD"
    return parsed.data.focus !== undefined
      ? { kind: "ok", argv, base, head, focus: parsed.data.focus }
      : { kind: "ok", argv, base, head }
  } catch (e) {
    if (e instanceof GitReviewRevRejected) return { kind: "deny", output: e.message }
    throw e
  }
}

const REVIEWER_NOT_ATTACHED_MSG =
  "git_review_diff: reviewer port not attached — " +
  "the host has not wired `ToolContext.reviewerAgent`. " +
  "Enable subagent dispatch and re-run."

const emptyDiffResult = () => {
  const report: ReviewReport = { summary: "Empty diff — no review needed.", findings: [] }
  return { ok: true, output: "(no diff to review)", structured: report }
}

/** Invoke the reviewer port and project its result into the final
 *  `ToolResult` shape (ok+structured | ok+freeText | ok:false+message).
 *  Pulled out of `execute()` so the generator stays under the cog cap. */
const invokeReviewer = async (
  reviewer: NonNullable<ToolContext["reviewerAgent"]>,
  req: ReviewerRequest,
): Promise<{ ok: boolean; output: string; structured?: ReviewReport }> => {
  let reviewerResult: ReviewerResult
  try {
    reviewerResult = await reviewer(req)
  } catch (e) {
    return { ok: false, output: `reviewer error: ${errMsg(e)}` }
  }
  if (!reviewerResult.ok) {
    return {
      ok: false,
      output: `reviewer failed: ${reviewerResult.finalText || "(no output)"}`,
    }
  }
  const report = tryParseReport(reviewerResult.finalText)
  if (report === null) {
    // Reviewer returned free text — surface it verbatim, no synthetic findings.
    const text = reviewerResult.finalText.trimEnd()
    return { ok: true, output: text, structured: { summary: text, findings: [] } }
  }
  return { ok: true, output: renderReport(report), structured: report }
}

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
import type { DiffSource, DiffSourceUnavailableReason, GitDiffOperation } from "@/git"
import { applyGeneratedFilter, diffSourceSchema, resolveDiffSource } from "@/git"
import { errMessage } from "@/shared"
import type { ReviewerRequest, ReviewerResult, Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { emitReviewCanvasDiffs } from "./review-diff-canvas"
import {
  gitRunnerAttributePort,
  gitRunnerReadPort,
  operationToArgs,
  workingTreeArgs,
} from "./review-source-adapter"
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

/** RFC-02 B4 — the OPERATOR front door reuses the domain `diffSourceSchema` arms
 *  (`branch-base` / `commit` / `range`, resolved through the port) and ADMITS two
 *  more surface arms the real tool producer can serve WITHOUT the pure resolver:
 *    • `working-tree` — uncommitted changes (`git diff <against>`, default HEAD),
 *      symbolic like `branch-base` (no ref peel);
 *    • `last-turn` — accepted at the schema so an operator can *select* it, but it
 *      is UNSUPPORTED: it resolves to a stable prerequisite error (RFC-02 B5 is
 *      parked). It is never a placeholder that silently falls back.
 *  The three domain arms are SPREAD from `diffSourceSchema.options` so the shared
 *  source contract has ONE definition (no drift between domain + front door). */
const frontDoorSourceSchema = z.discriminatedUnion("kind", [
  ...diffSourceSchema.options,
  z.object({
    kind: z.literal("working-tree"),
    against: z
      .string()
      .optional()
      .describe("Diff the working tree against this rev (default HEAD)"),
  }),
  z.object({ kind: z.literal("last-turn"), turnId: z.string() }),
])
export type FrontDoorSource = z.infer<typeof frontDoorSourceSchema>

/** Exhaustive-classification drift guard for {@link FrontDoorSource}. Adding a
 *  front-door arm without a `true` here (and a matching `case` in `prepareArgs`'s
 *  switch) fails compile. Mirrors `DIFF_SOURCE_KINDS` in `@/git`. */
const FRONT_DOOR_SOURCE_KINDS: Record<FrontDoorSource["kind"], true> = {
  "branch-base": true,
  commit: true,
  range: true,
  "working-tree": true,
  "last-turn": true,
}

/** Runtime drift guard: the zod schema arms and the classification table must
 *  enumerate the SAME kinds. Catches an arm added to only one of the two (the
 *  compile guard already catches a table/type mismatch; this catches a schema
 *  that grew a member the table never mirrored). */
const FRONT_DOOR_SCHEMA_KINDS = new Set(
  frontDoorSourceSchema.options.map((o) => o.shape.kind.value as string),
)
for (const k of Object.keys(FRONT_DOOR_SOURCE_KINDS)) {
  if (!FRONT_DOOR_SCHEMA_KINDS.has(k)) {
    throw new Error(`front-door source drift: '${k}' in table but not in schema`)
  }
}
if (FRONT_DOOR_SCHEMA_KINDS.size !== Object.keys(FRONT_DOOR_SOURCE_KINDS).length) {
  throw new Error("front-door source drift: schema has a kind the table does not classify")
}

export const gitReviewDiffInputSchema = z.object({
  /** Base revision for the three-dot diff. Default `origin/main`. */
  base: z.string().optional().describe("Base revision (default origin/main)"),
  /** Head revision for the three-dot diff. Default `HEAD`. */
  head: z.string().optional().describe("Head revision (default HEAD)"),
  /** Restrict diff to these path(s); shown verbatim to `git diff -- <paths…>`. */
  paths: z.array(z.string()).optional().describe("Restrict review to these paths"),
  /** Optional focus hint injected into the reviewer's seed prompt. */
  focus: z.string().optional().describe("Optional focus hint for the reviewer"),
  /** RFC-02 B2/B4 — first-class diff SOURCE picker. Supported arms: branch-base /
   *  commit / range / working-tree (resolved to a real diff); `last-turn` is
   *  ACCEPTED but returns a stable prerequisite error (RFC-02 B5, parked).
   *  MUTUALLY EXCLUSIVE with legacy `base`/`head`; supplying both is a typed
   *  error. ABSENT ⇒ byte-identical `origin/main...HEAD`. */
  source: frontDoorSourceSchema
    .optional()
    .describe("Diff source: branch-base | commit | range | working-tree (excludes base/head)"),
  /** RFC-02 B3 — hide repo-DECLARED generated files (`.gitattributes
   *  linguist-generated`) from the review. ATTRIBUTE-ONLY: no filename/extension
   *  heuristic. ABSENT/false ⇒ byte-identical (check-attr never invoked). */
  filterGenerated: z
    .boolean()
    .optional()
    .describe("Exclude repo-declared generated files (linguist-generated)"),
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

/** Raised by `legacyPrepared` when `base` or `head` begins with `-` (would be
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
    // LEGIT best-effort probe: a `JSON.parse` throw on non-JSON reviewer output
    // IS the answer (the caller `tryParseReport` deliberately tries multiple
    // candidates expecting most to fail). `null` is normal control flow, not a
    // swallowed error — logging every prose/fenced attempt would be pure noise.
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
    const prep = await prepareArgs(input, runner, ctx)
    if (prep.kind === "deny") {
      yield { type: "result", result: { ok: false, output: prep.output } }
      return
    }

    const finalized = await finalizeArgs(prep, runner, ctx)
    if (finalized.kind === "deny") {
      yield { type: "result", result: { ok: false, output: finalized.output } }
      return
    }
    if (finalized.kind === "empty") {
      yield { type: "result", result: emptyDiffResult() }
      return
    }

    const argv = finalized.argv
    yield { type: "progress", message: `git ${argv.join(" ")}` }
    const outcome = await extractDiff(runner, argv, ctx)
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
    const prompt = buildReviewerPrompt(diffForReviewer, prep.focus, truncated)
    yield { type: "progress", message: "Delegating to isolated reviewer (depth+1)…" }

    const result = await invokeReviewer(ctx.reviewerAgent, buildReviewerRequest(prompt, ctx))
    // RFC-12 SURFACE B PRODUCER — render the reviewer's anchored findings as a
    // canvas overlay. NO-OP (byte-identical) when the canvas sink is not wired;
    // never throws (best-effort observation, the result is already computed).
    await maybeEmitReviewCanvas(runner, ctx, {
      unifiedDiff: outcome.body,
      findings: result.structured?.findings ?? [],
      base: prep.base,
      head: prep.head,
    })
    yield { type: "result", result }
  },
})

/** Append `-- <paths…>` when paths are scoped. Kept separate from the range args
 *  so the generated-file filter (B3) can substitute its own kept-path set. */
const withPaths = (rangeArgs: readonly string[], paths: readonly string[]): string[] =>
  paths.length > 0 ? [...rangeArgs, "--", ...paths] : [...rangeArgs]

/** Final argv after the (optional) generated-file filter. `empty` short-circuits
 *  to the empty-diff result; `deny` fails the whole review CLOSED (a filter that
 *  could not run never silently degrades to an unfiltered diff). */
type FinalArgs =
  | { kind: "deny"; output: string }
  | { kind: "empty" }
  | { kind: "ok"; argv: string[] }

/** Enumerate the changed paths for the prepared range via `--name-only -z`
 *  (NUL-delimited so hostile filenames round-trip). Reuses the SAME range args
 *  as the review diff — no second diff engine. */
const enumerateChangedPaths = async (
  prep: Extract<PreparedDiff, { kind: "ok" }>,
  runner: GitRunner,
  ctx: ToolContext,
): Promise<{ kind: "deny"; output: string } | { kind: "ok"; paths: string[] }> => {
  const nameArgs = [
    "diff",
    "--name-only",
    "-z",
    ...prep.rangeArgs.slice(1),
    ...(prep.paths.length > 0 ? ["--", ...prep.paths] : []),
  ]
  const out = await safeRun(runner, nameArgs, ctx.cwd, "git diff", ctx.signal)
  if (out.kind === "spawn-error") return { kind: "deny", output: out.message }
  if (out.result.exitCode > 1) {
    return {
      kind: "deny",
      output: stderrReason(out.result.stderr, out.result.exitCode, "git diff"),
    }
  }
  return { kind: "ok", paths: out.result.stdout.split("\0").filter((p) => p.length > 0) }
}

/** Apply the generated-file filter when requested; otherwise pass the range +
 *  paths straight through (byte-identical). */
const finalizeArgs = async (
  prep: Extract<PreparedDiff, { kind: "ok" }>,
  runner: GitRunner,
  ctx: ToolContext,
): Promise<FinalArgs> => {
  if (!prep.filterGenerated) {
    return { kind: "ok", argv: withPaths(prep.rangeArgs, prep.paths) }
  }
  const names = await enumerateChangedPaths(prep, runner, ctx)
  if (names.kind === "deny") return names
  if (names.paths.length === 0) return { kind: "empty" }
  const port = gitRunnerAttributePort(runner, ctx.cwd, ctx.signal)
  const filtered = await applyGeneratedFilter(names.paths, port)
  if (!filtered.ok) {
    return {
      kind: "deny",
      output: `git_review_diff: generated-file filter failed — ${filtered.message}`,
    }
  }
  if (filtered.kept.length === 0) return { kind: "empty" }
  return { kind: "ok", argv: withPaths(prep.rangeArgs, filtered.kept) }
}

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
  // RFC-02 B4 — the `working-tree` source has NO after-ref (`head === ""`): the
  // canvas producer reads `git show <head>:path`, which cannot represent on-disk
  // uncommitted state, so skip the overlay rather than mis-anchor against the
  // index. The findings already returned to the model.
  if (args.head === "") return
  try {
    await emitReviewCanvasDiffs({ runner, ctx, ...args })
  } catch {
    // Best-effort: a canvas-render failure must never surface as a review
    // failure. Swallow (the tool result is already assembled).
  }
}

/** Prepared diff spec. The RANGE args (`git diff <range>`) are kept separate
 *  from `paths` so the generated-file filter (B3) can re-scope the path set
 *  without re-parsing argv. `base`/`head` are the endpoints the canvas producer
 *  uses for its per-file before/after (`git show`). */
type PreparedDiff =
  | { kind: "deny"; output: string }
  | {
      kind: "ok"
      rangeArgs: string[]
      paths: string[]
      base: string
      head: string
      focus?: string
      filterGenerated: boolean
    }

const SOURCE_MIXED_MSG =
  "git_review_diff: `source` is mutually exclusive with legacy `base`/`head` — " +
  "pass one or the other, not both."

/** RFC-02 B4 — the STABLE prerequisite error for the parked `last-turn` arm. It
 *  is deliberately terminal (never a silent fallback to a working/branch diff) and
 *  self-describing so the operator knows WHY the arm is unavailable and what would
 *  un-park it. Kept as a constant so its text is stable across surfaces/tests. */
const LAST_TURN_UNAVAILABLE_MSG =
  "git_review_diff: source 'last-turn' is not available yet — it requires an " +
  "immutable per-turn before/after boundary (RFC-02 B5, parked). Select " +
  "branch-base, commit, range, or working-tree instead."

/** Human-readable, fail-closed reason for an unresolvable source. */
const describeUnavailable = (r: DiffSourceUnavailableReason): string => {
  switch (r.kind) {
    case "invalid-ref":
      return `git_review_diff: invalid ${r.field} '${r.value}' (must not begin with '-')`
    case "unresolvable-ref":
      return `git_review_diff: ${r.field} '${r.value}' did not resolve to a commit`
  }
}

/** Endpoints the canvas producer diffs per-file. Derived from the RESOLVED
 *  operation so `git show <base>:path` / `<head>:path` line up with the range. */
const canvasEndpoints = (op: GitDiffOperation): { base: string; head: string } => {
  switch (op.kind) {
    case "branch-merge-base":
      return { base: op.base, head: op.head }
    case "commit-first-parent":
      return { base: op.base, head: op.commit }
    case "tree-range":
      return { base: op.from, head: op.to }
  }
}

/** Legacy (no `source`) prep — BYTE-IDENTICAL to today's `buildArgs`: default
 *  `origin/main...HEAD`, leading-`-` revs rejected, paths carried through. */
const legacyPrepared = (data: GitReviewDiffInput): PreparedDiff => {
  const base = data.base ?? "origin/main"
  const head = data.head ?? "HEAD"
  try {
    validateRev("base", base)
    validateRev("head", head)
  } catch (e) {
    if (e instanceof GitReviewRevRejected) return { kind: "deny", output: e.message }
    throw e
  }
  return {
    kind: "ok",
    rangeArgs: ["diff", `${base}...${head}`],
    paths: data.paths ?? [],
    base,
    head,
    filterGenerated: data.filterGenerated ?? false,
    ...(data.focus !== undefined ? { focus: data.focus } : {}),
  }
}

/** Source-driven prep — resolve the closed DOMAIN union (branch-base / commit /
 *  range) through the injected read port, fail closed on an unavailable source,
 *  and convert to argv via the adapter (the ONE argv mapping). */
const sourcePrepared = async (
  source: DiffSource,
  data: GitReviewDiffInput,
  runner: GitRunner,
  ctx: ToolContext,
): Promise<PreparedDiff> => {
  const port = gitRunnerReadPort(runner, ctx.cwd, ctx.signal)
  const res = await resolveDiffSource(source, port)
  if (!res.ok) return { kind: "deny", output: describeUnavailable(res.reason) }
  const { base, head } = canvasEndpoints(res.operation)
  return {
    kind: "ok",
    rangeArgs: operationToArgs(res.operation),
    paths: data.paths ?? [],
    base,
    head,
    filterGenerated: data.filterGenerated ?? false,
    ...(data.focus !== undefined ? { focus: data.focus } : {}),
  }
}

/** RFC-02 B4 — `working-tree` prep. Reviews UNCOMMITTED changes vs `against`
 *  (default `HEAD`) via `git diff <against>`. `against` stays SYMBOLIC (like
 *  `branch-base`): a leading-`-` is rejected here (no option smuggling) and an
 *  unresolvable ref fails closed at `git diff` exit — never a bare-`git diff`
 *  fallback. `head` is left EMPTY: the after-side is the on-disk working tree,
 *  which has no ref, so the (default-OFF) canvas overlay is skipped for it. */
const workingTreePrepared = (
  source: Extract<FrontDoorSource, { kind: "working-tree" }>,
  data: GitReviewDiffInput,
): PreparedDiff => {
  const against = source.against ?? "HEAD"
  if (against.startsWith("-")) {
    return {
      kind: "deny",
      output: `git_review_diff: invalid against '${against}' (must not begin with '-')`,
    }
  }
  return {
    kind: "ok",
    rangeArgs: workingTreeArgs(against),
    paths: data.paths ?? [],
    base: against,
    head: "",
    filterGenerated: data.filterGenerated ?? false,
    ...(data.focus !== undefined ? { focus: data.focus } : {}),
  }
}

const assertNeverSource = (x: never): never => {
  throw new Error(`unhandled FrontDoorSource arm: ${JSON.stringify(x)}`)
}

/** Route a parsed front-door `source` to its prep. Supported domain arms delegate
 *  to the port resolver; `working-tree` is served directly; `last-turn` returns
 *  its stable prerequisite error. Exhaustive — a new arm without a case fails
 *  compile via {@link assertNeverSource}. */
const prepareSource = async (
  source: FrontDoorSource,
  data: GitReviewDiffInput,
  runner: GitRunner,
  ctx: ToolContext,
): Promise<PreparedDiff> => {
  switch (source.kind) {
    case "branch-base":
    case "commit":
    case "range":
      return sourcePrepared(source, data, runner, ctx)
    case "working-tree":
      return workingTreePrepared(source, data)
    case "last-turn":
      return { kind: "deny", output: LAST_TURN_UNAVAILABLE_MSG }
    default:
      return assertNeverSource(source)
  }
}

/** Validate input, reject mixed source/legacy, and prepare the diff spec.
 *  Extracted so `execute` stays under the cog-complexity cap. */
const prepareArgs = async (
  input: GitReviewDiffInput,
  runner: GitRunner,
  ctx: ToolContext,
): Promise<PreparedDiff> => {
  const parsed = gitReviewDiffInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "deny", output: `invalid input: ${parsed.error.message}` }
  }
  const data = parsed.data
  if (data.source === undefined) return legacyPrepared(data)
  if (data.base !== undefined || data.head !== undefined) {
    return { kind: "deny", output: SOURCE_MIXED_MSG }
  }
  return prepareSource(data.source, data, runner, ctx)
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

/**
 * GitHub CLI (`gh`) tool slice — RFC may-22 ci-bot mode.
 *
 * Exposes 4 read + 2 write tools wrapping the `gh` binary. The slice is the
 * SINGLE place that knows about `gh` invocation; per-mode wiring decides
 * whether to register these tools (ci-bot does; interactive does only if
 * operator opts in).
 *
 * Tools:
 *   - gh_pr_view     (read) — fetch PR title/body/diff
 *   - gh_issue_view  (read) — fetch issue body
 *   - gh_pr_comment  (write) — post a PR comment
 *   - gh_pr_create   (write) — open a PR (branch must NOT be protected)
 *   - gh_check_status (read) — fetch CI check status for a PR
 *   - gh_pr_list     (read) — list open PRs
 *
 * Design:
 *   - The slice talks ONLY through the `Tool` contract — no globals.
 *   - Spawn boundary is injectable for tests (`GhRunner` port).
 *   - `gh` argv is built as a string[] (no shell ⇒ no injection).
 *   - Errors return `ok:false` with a clean message; never throws to the
 *     loop (boundary discipline, not a fallback for missing data).
 */
import { z } from "zod"
import type { LLMPort } from "../../llm"
import type { GitRunner } from "../git/types"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { ghPrBlameTool } from "./pr-blame"
import { ghPrOpenTool } from "./pr-open"
import { normalizeRef, refRejected } from "./ref"
import { DEFAULT_TIMEOUT_MS, type GhRunner, type GhRunResult, defaultGhRunner } from "./runner"

// Barrel re-exports — historical import path for outside callers.
export { defaultGhRunner } from "./runner"
export type { GhRunner, GhRunResult } from "./runner"
export { ghPrBlameTool } from "./pr-blame"
export { ghPrOpenTool } from "./pr-open"

// ── Read tools ─────────────────────────────────────────────────────────────

const prViewSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
  fields: z
    .array(z.string())
    .optional()
    .describe("gh --json fields (default: title,body,headRefName,baseRefName,state,url)"),
})
type PrViewInput = z.infer<typeof prViewSchema>

const DEFAULT_PR_FIELDS = ["title", "body", "headRefName", "baseRefName", "state", "url"]

export const ghPrViewTool = (runner: GhRunner = defaultGhRunner): Tool<PrViewInput> => ({
  name: "gh_pr_view",
  description:
    "Fetch a GitHub PR via `gh pr view`. Returns the requested fields as JSON. " +
    "Read-only — never modifies repo or PR state.",
  inputSchema: prViewSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: PrViewInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.pr)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } }
      return
    }
    const fields = input.fields ?? DEFAULT_PR_FIELDS
    const argv = ["gh", "pr", "view", ref, "--json", fields.join(",")]
    yield { type: "progress", message: `gh pr view #${input.pr}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr view failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: r.stdout.trim() } }
  },
})

const issueViewSchema = z.object({
  issue: z.union([z.string(), z.number()]).describe("Issue number or URL"),
})
type IssueViewInput = z.infer<typeof issueViewSchema>

export const ghIssueViewTool = (runner: GhRunner = defaultGhRunner): Tool<IssueViewInput> => ({
  name: "gh_issue_view",
  description: "Fetch a GitHub issue via `gh issue view --json`. Read-only.",
  inputSchema: issueViewSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: IssueViewInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.issue)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("issue", input.issue) } }
      return
    }
    const argv = ["gh", "issue", "view", ref, "--json", "title,body,state,labels,url"]
    yield { type: "progress", message: `gh issue view #${input.issue}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh issue view failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: r.stdout.trim() } }
  },
})

const checkStatusSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number"),
})
type CheckStatusInput = z.infer<typeof checkStatusSchema>

export const ghCheckStatusTool = (runner: GhRunner = defaultGhRunner): Tool<CheckStatusInput> => ({
  name: "gh_check_status",
  description: "Fetch CI check status for a PR via `gh pr checks --json`. Read-only.",
  inputSchema: checkStatusSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: CheckStatusInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.pr)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } }
      return
    }
    const argv = ["gh", "pr", "checks", ref, "--json", "name,state,bucket,description"]
    yield { type: "progress", message: `gh pr checks #${input.pr}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr checks failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: r.stdout.trim() } }
  },
})

// ── Write tools ────────────────────────────────────────────────────────────

const prCommentSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number"),
  body: z.string().min(1).describe("Comment body (markdown allowed)"),
})
type PrCommentInput = z.infer<typeof prCommentSchema>

export const ghPrCommentTool = (runner: GhRunner = defaultGhRunner): Tool<PrCommentInput> => ({
  name: "gh_pr_comment",
  description:
    "Post a comment on a GitHub PR via `gh pr comment`. Write — gated by " +
    "the mode's permission policy. Returns the comment URL on success.",
  inputSchema: prCommentSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: PrCommentInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.pr)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } }
      return
    }
    const argv = ["gh", "pr", "comment", ref, "--body", input.body]
    yield { type: "progress", message: `gh pr comment #${input.pr}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr comment failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: r.stdout.trim() || "comment posted" } }
  },
})

const prCreateSchema = z.object({
  title: z.string().min(1).describe("PR title"),
  body: z.string().describe("PR body (markdown allowed)"),
  base: z.string().describe("Base branch (e.g. main)"),
  head: z.string().describe("Head branch — MUST be a feature branch, not protected"),
  /** ADR-0104: open the PR as a draft (no review requested, no checks
   *  auto-required). Useful for early CI feedback before opening for review. */
  draft: z.boolean().optional().describe("Open as draft PR"),
})
type PrCreateInput = z.infer<typeof prCreateSchema>

export interface GhPrCreateToolOpts {
  readonly gitDirectiveEmitter?: import("../../agent/git-directives").GitDirectiveEmitter
  readonly gitDirectiveCollector?: import("../../git/directive-emit").GitDirectiveCollector
}

export const ghPrCreateTool = (
  runner: GhRunner = defaultGhRunner,
  opts: GhPrCreateToolOpts = {},
): Tool<PrCreateInput> => ({
  name: "gh_pr_create",
  description:
    "Open a new GitHub PR via `gh pr create`. Write — the head branch MUST " +
    "be a feature branch (not main/master/protected). The mode's gitWrite " +
    "lever is the structural gate; this tool just invokes `gh`. Optional " +
    "`draft:true` opens as a draft PR.",
  inputSchema: prCreateSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: PrCreateInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const argv = [
      "gh",
      "pr",
      "create",
      "--title",
      input.title,
      "--body",
      input.body,
      "--base",
      input.base,
      "--head",
      input.head,
    ]
    if (input.draft === true) argv.push("--draft")
    yield { type: "progress", message: `gh pr create ${input.head} → ${input.base}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS * 2)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr create failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    const url = r.stdout.trim()
    // ADR-0241 — success-only publish of `create-pr` directive on both
    // surfaces. Absent surfaces ⇒ no-op (byte-identical to pre-wire).
    const { publishGitDirective } = await import("../git/_directive-publish")
    const publishOpts: {
      emitter?: import("../../agent/git-directives").GitDirectiveEmitter
      collector?: import("../../git/directive-emit").GitDirectiveCollector
    } = {}
    if (opts.gitDirectiveEmitter !== undefined) publishOpts.emitter = opts.gitDirectiveEmitter
    if (opts.gitDirectiveCollector !== undefined) publishOpts.collector = opts.gitDirectiveCollector
    publishGitDirective({ kind: "create-pr", url, isDraft: input.draft === true }, publishOpts)
    yield { type: "result", result: { ok: true, output: url } }
  },
})

// ── ADR-0104 additions: review-diff + auto-merge ────────────────────────
// (ADR-0103 `gh_pr_blame` moved to `./pr-blame.ts` for structural clarity.)

/** Default cap for `gh_pr_review_diff` — 64 KiB matches the agent-side
 *  prompt budget. 1 MiB is the hard ceiling (schema). */
const PR_DIFF_DEFAULT_MAX_BYTES = 64 * 1024

const prReviewDiffSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .optional()
    .describe("Truncate diff at this many bytes (default 64 KiB, max 1 MiB)"),
})
type PrReviewDiffInput = z.infer<typeof prReviewDiffSchema>

export const ghPrReviewDiffTool = (
  runner: GhRunner = defaultGhRunner,
): Tool<PrReviewDiffInput> => ({
  name: "gh_pr_review_diff",
  description:
    "Fetch the unified diff for a pull request via `gh pr diff`. Truncates at " +
    "`maxBytes` (default 64 KiB, max 1 MiB). Read-only.",
  inputSchema: prReviewDiffSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: PrReviewDiffInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.pr)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } }
      return
    }
    const cap = input.maxBytes ?? PR_DIFF_DEFAULT_MAX_BYTES
    const argv = ["gh", "pr", "diff", ref]
    yield { type: "progress", message: `gh pr diff #${input.pr}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr diff failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    const diff = r.stdout
    const body =
      diff.length > cap
        ? `${diff.slice(0, cap)}\n\n[truncated: ${diff.length} bytes total, showing first ${cap} bytes]`
        : diff
    yield { type: "result", result: { ok: true, output: body } }
  },
})

const prAutoMergeSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
  method: z
    .enum(["merge", "squash", "rebase"])
    .optional()
    .describe("Merge method: merge (default) | squash | rebase"),
})
type PrAutoMergeInput = z.infer<typeof prAutoMergeSchema>

export const ghPrAutoMergeTool = (runner: GhRunner = defaultGhRunner): Tool<PrAutoMergeInput> => ({
  name: "gh_pr_auto_merge",
  description:
    "Enable auto-merge on a pull request — merges when all checks pass. " +
    "`method`: merge (default) | squash | rebase. Write — the mode's gitWrite " +
    "lever is the structural gate; this tool just invokes `gh`.",
  inputSchema: prAutoMergeSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: PrAutoMergeInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.pr)
    if (ref === undefined) {
      yield { type: "result", result: { ok: false, output: refRejected("PR", input.pr) } }
      return
    }
    const argv: string[] = ["gh", "pr", "merge", ref, "--auto"]
    switch (input.method) {
      case "squash":
        argv.push("--squash")
        break
      case "rebase":
        argv.push("--rebase")
        break
      default:
        argv.push("--merge")
        break
    }
    yield {
      type: "progress",
      message: `gh pr merge #${input.pr} --auto --${input.method ?? "merge"}`,
    }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr merge failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    yield {
      type: "result",
      result: { ok: true, output: r.stdout.trim() || "auto-merge enabled" },
    }
  },
})

const prListSchema = z.object({
  state: z
    .enum(["open", "closed", "merged", "all"])
    .optional()
    .describe("Filter state (default open)"),
  limit: z.number().int().positive().optional().describe("Max results (default 20)"),
})
type PrListInput = z.infer<typeof prListSchema>

export const ghPrListTool = (runner: GhRunner = defaultGhRunner): Tool<PrListInput> => ({
  name: "gh_pr_list",
  description: "List GitHub PRs via `gh pr list --json`. Read-only.",
  inputSchema: prListSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: PrListInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const argv = [
      "gh",
      "pr",
      "list",
      "--state",
      input.state ?? "open",
      "--limit",
      String(input.limit ?? 20),
      "--json",
      "number,title,state,headRefName,baseRefName,url",
    ]
    yield { type: "progress", message: `gh pr list state=${input.state ?? "open"}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
    if (r.code !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: `gh pr list failed: ${r.stderr.slice(0, 500)}` },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: r.stdout.trim() } }
  },
})

/** All gh tools (6 RFC may-22 + 3 ADR-0103/0104 = 9). Pass an injected
 *  runner for tests. Order: read-only first (view/issue/checks/list/blame/
 *  review_diff), then mutating (comment/create/auto_merge). */
/** Options for {@link ghTools}. Extends {@link GhPrCreateToolOpts} (directive
 *  wiring) with the two slots `gh_pr_open` needs: an author LLM and a git
 *  runner. DEFAULT-OFF — when EITHER is absent `gh_pr_open` is NOT registered,
 *  so the tool set stays byte-identical for every existing caller (RFC §1.2). */
export interface GhToolsOpts extends GhPrCreateToolOpts {
  readonly authorLLM?: LLMPort
  readonly gitRunner?: GitRunner
}

export const ghTools = (runner: GhRunner = defaultGhRunner, opts: GhToolsOpts = {}): Tool[] => [
  ghPrViewTool(runner) as Tool,
  ghIssueViewTool(runner) as Tool,
  ghCheckStatusTool(runner) as Tool,
  ghPrListTool(runner) as Tool,
  // ADR-0103/0104 additions — read-only tools first.
  ghPrBlameTool(runner) as Tool,
  ghPrReviewDiffTool(runner) as Tool,
  // Mutating.
  ghPrCommentTool(runner) as Tool,
  ghPrCreateTool(runner) as Tool,
  ghPrAutoMergeTool(runner) as Tool,
  // ADR-0459 `gh_pr_open` (author + open) — OFF unless BOTH an author LLM and a
  // git runner are wired; absent ⇒ no extra tool (byte-identical).
  ...(opts.authorLLM !== undefined && opts.gitRunner !== undefined
    ? [ghPrOpenTool(runner, opts.gitRunner, opts.authorLLM, opts) as Tool]
    : []),
]

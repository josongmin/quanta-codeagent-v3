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
import { scrubEnv } from "@/runtime"
import type { Tool, ToolContext, ToolEvent } from "../types"

/**
 * SECURITY (mirrors `git/diff.ts` leading-dash rejection): a PR/issue
 * identifier is a bare POSITIONAL argument to `gh` (`gh pr view <id>`). A
 * `-`-leading value (`--web`, `-R/owner/evil`, `--repo=…`) would be parsed by
 * `gh` as a FLAG rather than a number/URL — arg-injection. `gh` accepts a
 * numeric issue/PR number OR a full `https://…` URL; both are validated here.
 * A malformed identifier is rejected before it reaches argv, surfaced as a
 * deterministic `ok:false` (never thrown to the loop).
 *
 * Accepted: a positive integer (`42`, `#42`) or an `http(s)://…` URL. Anything
 * beginning with `-`, or any other shape, is rejected.
 */
const normalizeRef = (raw: string | number): string | undefined => {
  const s = String(raw).trim()
  if (s.length === 0) return undefined
  // Plain number, optionally with a leading `#` (a common human shorthand).
  const num = s.startsWith("#") ? s.slice(1) : s
  if (/^[0-9]+$/.test(num)) return num
  // Full URL form — must be http(s) so it can never be a `-`-leading flag.
  if (/^https?:\/\//i.test(s)) return s
  return undefined
}

/** Raised (and caught in `execute`) when a PR/issue identifier is malformed. */
const refRejected = (kind: "PR" | "issue", raw: string | number): string =>
  `invalid ${kind} identifier '${String(raw)}': expected a positive number or an ` +
  "http(s) URL (a leading-dash value would be parsed as a gh flag)"

/** Injectable subprocess boundary — argv, cwd, timeout → result. */
export interface GhRunResult {
  code: number
  stdout: string
  stderr: string
}
export type GhRunner = (argv: string[], cwd: string, timeoutMs: number) => Promise<GhRunResult>

/** Default runner via Bun.spawn (no shell). Env is the CI-scoped allowlist
 *  from `@/runtime` — NEVER leaks `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` etc.
 *  The allowlist accepts `PATH`/`HOME`/`TMPDIR`/locale + `GH_TOKEN`/`GITHUB_*`,
 *  so `gh` authenticates from its own scoped token, not the user's host env. */
const CI_ENV_ALLOWLIST_LOCAL: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
])

export const defaultGhRunner: GhRunner = async (argv, cwd, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubEnv(CI_ENV_ALLOWLIST_LOCAL),
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

const DEFAULT_TIMEOUT_MS = 60_000

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
      yield { type: "result", result: { ok: false, output: `gh pr view failed: ${r.stderr.slice(0, 500)}` } }
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
      yield { type: "result", result: { ok: false, output: `gh issue view failed: ${r.stderr.slice(0, 500)}` } }
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
      yield { type: "result", result: { ok: false, output: `gh pr checks failed: ${r.stderr.slice(0, 500)}` } }
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
      yield { type: "result", result: { ok: false, output: `gh pr comment failed: ${r.stderr.slice(0, 500)}` } }
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
})
type PrCreateInput = z.infer<typeof prCreateSchema>

export const ghPrCreateTool = (runner: GhRunner = defaultGhRunner): Tool<PrCreateInput> => ({
  name: "gh_pr_create",
  description:
    "Open a new GitHub PR via `gh pr create`. Write — the head branch MUST " +
    "be a feature branch (not main/master/protected). The mode's gitWrite " +
    "lever is the structural gate; this tool just invokes `gh`.",
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
    yield { type: "progress", message: `gh pr create ${input.head} → ${input.base}` }
    const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS * 2)
    if (r.code !== 0) {
      yield { type: "result", result: { ok: false, output: `gh pr create failed: ${r.stderr.slice(0, 500)}` } }
      return
    }
    yield { type: "result", result: { ok: true, output: r.stdout.trim() } }
  },
})

const prListSchema = z.object({
  state: z.enum(["open", "closed", "merged", "all"]).optional().describe("Filter state (default open)"),
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
      yield { type: "result", result: { ok: false, output: `gh pr list failed: ${r.stderr.slice(0, 500)}` } }
      return
    }
    yield { type: "result", result: { ok: true, output: r.stdout.trim() } }
  },
})

/** All 6 gh tools. Pass an injected runner for tests. */
export const ghTools = (runner: GhRunner = defaultGhRunner): Tool[] => [
  ghPrViewTool(runner) as Tool,
  ghIssueViewTool(runner) as Tool,
  ghCheckStatusTool(runner) as Tool,
  ghPrCommentTool(runner) as Tool,
  ghPrCreateTool(runner) as Tool,
  ghPrListTool(runner) as Tool,
]

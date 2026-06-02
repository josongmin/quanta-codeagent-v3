/**
 * `gh_pr_open` — author + open a GitHub PR in ONE step (ADR-0460).
 *
 * The missing link between `git_compose_pr` (authors title/body, opens nothing)
 * and `gh_pr_create` (opens a PR from a title/body you already have). Competitor
 * agents (Claude Code, Cursor) wire "finish work → read diff → draft PR → open
 * PR" as a SINGLE agent flow; quanta had the two halves but no seam joining
 * them. This tool is that seam — atomic, with one consistent failure path and a
 * single place for the push precondition.
 *
 * Flow:
 *   1. resolve branches — gh needs branch NAMES (`main`, `feat/x`), not the
 *      `origin/main...HEAD` REVISION range the author uses; default head =
 *      current branch, default base = `main`.
 *   2. author the prose via the shared `composePrText` core (diff `origin/<base>
 *      ...<head>` + commit log → one-shot LLM).
 *   3. `dryRun:true` ⇒ return the authored title/body and STOP (preview, no PR).
 *   4. push precondition — `origin/<head>` must exist locally (best-effort;
 *      `gh pr create` would otherwise fail non-interactively with a worse msg).
 *   5. `gh pr create --title --body --base --head [--draft]`.
 *   6. success-only publish of the `create-pr` directive (same as gh_pr_create).
 *
 * SLICE FENCE: lives in the `gh` slice, which already type/value-imports the
 * `git` slice (`_directive-publish`). It reuses the `git/compose` authoring core
 * rather than duplicating diff/log/LLM logic. Write tool — gated by the mode's
 * gitWrite lever (registration is OFF unless an author LLM is wired).
 */
import { z } from "zod"
import type { LLMPort } from "../../llm"
import { publishGitDirective } from "../git/_directive-publish"
import { composePrText } from "../git/compose"
import type { GitRunner } from "../git/types"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { GhPrCreateToolOpts } from "./index"
import { DEFAULT_TIMEOUT_MS, defaultGhRunner, type GhRunner } from "./runner"

const prOpenSchema = z.object({
  base: z
    .string()
    .optional()
    .describe("Base branch (default: main). 'origin/' prefix is stripped."),
  head: z.string().optional().describe("Head branch (default: the current branch)"),
  hint: z.string().optional().describe("Optional intent hint for the PR author"),
  draft: z.boolean().optional().describe("Open as a draft PR"),
  dryRun: z
    .boolean()
    .optional()
    .describe("Author the title + body but do NOT open the PR (preview)"),
})
type PrOpenInput = z.infer<typeof prOpenSchema>

/** Branches a PR must never open FROM. The mode's gitWrite lever is the real
 *  structural gate; this is a fast, message-friendly guard. */
const PROTECTED_HEADS = new Set(["main", "master", "develop"])

const stripOriginPrefix = (b: string): string =>
  b.startsWith("origin/") ? b.slice("origin/".length) : b

/** Resolve the current branch via `git rev-parse --abbrev-ref HEAD`. Returns
 *  undefined on detached HEAD ("HEAD") or any git failure. */
const currentBranch = async (runner: GitRunner, ctx: ToolContext): Promise<string | undefined> => {
  try {
    const r = await runner.run(["rev-parse", "--abbrev-ref", "HEAD"], ctx.cwd, ctx.signal)
    const name = r.stdout.trim()
    return r.exitCode === 0 && name.length > 0 && name !== "HEAD" ? name : undefined
  } catch {
    return undefined
  }
}

/** Best-effort: does the local repo know an `origin/<head>` ref? A false
 *  negative (pushed but not fetched) is possible — the message says so. */
const headOnOrigin = async (
  runner: GitRunner,
  head: string,
  ctx: ToolContext,
): Promise<boolean> => {
  try {
    const r = await runner.run(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${head}`],
      ctx.cwd,
      ctx.signal,
    )
    return r.exitCode === 0
  } catch {
    return false
  }
}

const err = (output: string): ToolEvent => ({ type: "result", result: { ok: false, output } })

/** Resolve + validate the gh branch NAMES (distinct from the author's revision
 *  range). Extracted from `execute` to keep its cognitive complexity in budget. */
const resolveBranches = async (
  input: PrOpenInput,
  gitRunner: GitRunner,
  ctx: ToolContext,
): Promise<{ ok: true; base: string; head: string } | { ok: false; output: string }> => {
  const base = stripOriginPrefix(input.base ?? "main")
  const head = input.head ?? (await currentBranch(gitRunner, ctx))
  if (head === undefined) {
    return {
      ok: false,
      output: "could not resolve the current branch (detached HEAD?) — pass {head}",
    }
  }
  if (PROTECTED_HEADS.has(head)) {
    return {
      ok: false,
      output: `head '${head}' is protected — a PR opens FROM a feature branch, not '${head}'`,
    }
  }
  if (head === base) {
    return { ok: false, output: `head and base are both '${head}' — nothing to open a PR for` }
  }
  return { ok: true, base, head }
}

/** Run `gh pr create` with argv built as DISTINCT items (no shell ⇒ no
 *  injection). Extracted to keep `execute` within the complexity budget. */
const runGhCreate = async (
  ghRunner: GhRunner,
  a: { title: string; body: string; base: string; head: string; draft: boolean },
  ctx: ToolContext,
): Promise<{ ok: true; url: string } | { ok: false; output: string }> => {
  const argv = [
    "gh",
    "pr",
    "create",
    "--title",
    a.title,
    "--body",
    a.body,
    "--base",
    a.base,
    "--head",
    a.head,
  ]
  if (a.draft) argv.push("--draft")
  const r = await ghRunner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS * 2)
  if (r.code !== 0) return { ok: false, output: `gh pr create failed: ${r.stderr.slice(0, 500)}` }
  return { ok: true, url: r.stdout.trim() }
}

/** Success-only publish of the `create-pr` directive (mirrors gh_pr_create,
 *  ADR-0241). Absent emitter/collector ⇒ no-op (byte-identical). */
const publishCreatePr = (url: string, isDraft: boolean, opts: GhPrCreateToolOpts): void => {
  const publishOpts: {
    emitter?: import("../../agent/git-directives").GitDirectiveEmitter
    collector?: import("../../git/directive-emit").GitDirectiveCollector
  } = {}
  if (opts.gitDirectiveEmitter !== undefined) publishOpts.emitter = opts.gitDirectiveEmitter
  if (opts.gitDirectiveCollector !== undefined) publishOpts.collector = opts.gitDirectiveCollector
  publishGitDirective({ kind: "create-pr", url, isDraft }, publishOpts)
}

export const ghPrOpenTool = (
  ghRunner: GhRunner = defaultGhRunner,
  gitRunner: GitRunner,
  authorLLM: LLMPort,
  opts: GhPrCreateToolOpts = {},
): Tool<PrOpenInput> => ({
  name: "gh_pr_open",
  description:
    "AUTHOR + OPEN a GitHub PR in one step: reads the branch-vs-base diff + " +
    "commit log, drafts a title + body with a one-shot LLM, then runs `gh pr " +
    "create`. Defaults: head = current branch, base = main. Write — head MUST " +
    "be a feature branch (mode gitWrite lever is the gate). Use {dryRun:true} " +
    "to preview the prose without opening, {draft:true} for a draft PR. " +
    "Prefer this over calling git_compose_pr + gh_pr_create separately.",
  inputSchema: prOpenSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async *execute(input: PrOpenInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = prOpenSchema.safeParse(input)
    if (!parsed.success) {
      yield err(`invalid input: ${parsed.error.message}`)
      return
    }
    const { hint, draft, dryRun } = parsed.data

    // 1. resolve branch NAMES for gh (distinct from the author's revision range)
    const branches = await resolveBranches(parsed.data, gitRunner, ctx)
    if (!branches.ok) {
      yield err(branches.output)
      return
    }
    const { base: baseBranch, head: headBranch } = branches

    // 2. author the prose from the diff range (gh branch names → git revisions)
    const messages: ToolEvent[] = []
    const composed = await composePrText(
      gitRunner,
      authorLLM,
      { base: `origin/${baseBranch}`, head: headBranch, ...(hint !== undefined ? { hint } : {}) },
      ctx,
      (message) => messages.push({ type: "progress", message }),
    )
    for (const m of messages) yield m
    if (!composed.ok) {
      const output =
        composed.reason === "empty"
          ? `gh_pr_open: no changes in origin/${baseBranch}...${headBranch} — nothing to open a PR for.`
          : composed.output
      yield err(output)
      return
    }

    // 3. dry-run — preview the prose, open nothing
    if (dryRun === true) {
      const preview = [`[dry-run] title: ${composed.title}`, "", composed.body].join("\n")
      yield { type: "result", result: { ok: true, output: preview, structured: composed.parsed } }
      return
    }

    // 4. push precondition (best-effort)
    if (!(await headOnOrigin(gitRunner, headBranch, ctx))) {
      yield err(
        `head branch '${headBranch}' is not on origin — push it first:\n  git push -u origin ${headBranch}\n` +
          "(if you already pushed, run `git fetch origin` so the local ref exists)",
      )
      return
    }

    // 5. open the PR
    yield { type: "progress", message: `gh pr create ${headBranch} → ${baseBranch}` }
    const opened = await runGhCreate(
      ghRunner,
      {
        title: composed.title,
        body: composed.body,
        base: baseBranch,
        head: headBranch,
        draft: draft === true,
      },
      ctx,
    )
    if (!opened.ok) {
      yield err(opened.output)
      return
    }

    // 6. success-only directive publish (mirrors gh_pr_create, ADR-0241)
    publishCreatePr(opened.url, draft === true, opts)
    yield { type: "result", result: { ok: true, output: opened.url } }
  },
})

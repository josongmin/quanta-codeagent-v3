/**
 * `gh_pr_resolve_thread` — resolve PR review threads + handle the
 * concurrent-push race (RFC jun-6).
 *
 * quanta can READ review threads (`gh_pr_blame`) and post a flat PR comment
 * (`gh_pr_comment`) but could not RESOLVE a review thread — the write that
 * closes the review loop. GitHub exposes thread resolution ONLY via GraphQL
 * (`resolveReviewThread(input:{threadId})`); there is no `gh pr` subcommand. So
 * this is the first gh tool that routes through `gh api graphql` rather than a
 * `gh pr <verb>` porcelain call.
 *
 * Three modes (by input):
 *   - LIST   (no threadId, no all): GraphQL query → unresolved thread ids +
 *            paths + first-comment snippets. Read fallback so the model can pick.
 *   - RESOLVE-ONE (threadId set): `resolveReviewThread` mutation for that id.
 *   - RESOLVE-ALL (all:true): list → resolve each currently-unresolved thread.
 *
 * Concurrent-push race (§4.3). Resolution must reflect the CURRENT review state.
 * When `rebaseOnDivergence:true` and the local branch has diverged from
 * `origin/<headRef>` (a teammate / CI bot pushed first), the tool performs a
 * BOUNDED (≤1) fetch + rebase before resolving:
 *     fetch origin <headRef>; if local != origin/<headRef>: rebase
 *       on CONFLICT → rebase --abort, fail-closed (no resolve)
 *     a SECOND divergence after the single rebase → fail-closed (NO unbounded
 *       fetch/rebase loop — the prior-audit "unbounded retry" trap).
 * When `rebaseOnDivergence:false` (default) divergence → `ok:false
 * {reason:"head_moved"}` and NO git mutation runs (the agent rebases explicitly).
 *
 * SECURITY:
 *   - `normalizeRef` guards the positional PR ref (arg-injection).
 *   - `threadId` is validated as an opaque GitHub node id
 *     (`/^[A-Za-z0-9_=-]+$/`, reject `-`-leading) BEFORE argv.
 *   - Every GraphQL value is passed as a NAMED `-F`/`-f` variable, never
 *     interpolated into the query body (the query/mutation are module
 *     constants), so a malicious `threadId` cannot break out of the variable.
 *   - The injected `GhRunner` carries the `scrubEnv` fence (provider keys never
 *     reach `gh`); the injected `GitRunner` is the only repo boundary. No clock,
 *     no randomness, no network/repo in tests.
 *
 * Permission posture: `isReadOnly:()=>false`; the mode's gitWrite lever is the
 * structural gate (mirrors `gh_pr_auto_merge`). The whole tool is `mutating` in
 * the manifest even though LIST mode is read-shaped — one mutating tool, no
 * "read tool that sometimes writes" classification hole. Default-OFF under the
 * shared `QUANTA_GIT_TOOLS` gate; `gh_pr_resolve_thread` registers only when a
 * `GitRunner` is wired (the rebase boundary).
 */
import { z } from "zod"
import { errMessage } from "../../shared"
import type { GitRunner } from "../git/types"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import { normalizeRef, refRejected } from "./ref"
import { DEFAULT_TIMEOUT_MS, defaultGhRunner, type GhRunner } from "./runner"

const prResolveThreadSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
  threadId: z
    .string()
    .optional()
    .describe("Specific review-thread node id to resolve. Omit to LIST unresolved threads."),
  all: z
    .boolean()
    .optional()
    .describe("Resolve ALL currently-unresolved threads (bulk; routes through the mutating gate)."),
  rebaseOnDivergence: z
    .boolean()
    .optional()
    .describe(
      "On concurrent-push divergence, perform a BOUNDED (≤1) fetch+rebase before " +
        "resolving (default false → divergence fails closed so the agent rebases explicitly).",
    ),
})
export type PrResolveThreadInput = z.infer<typeof prResolveThreadSchema>

// ── GraphQL query/mutation — MODULE CONSTANTS (no user input interpolated) ──

/** Enumerate a PR's review threads (resolved + unresolved); the tool filters to
 *  unresolved client-side. `owner`/`repo`/`pr` are NAMED variables passed via
 *  `-F`, never interpolated. */
export const UNRESOLVED_THREADS_QUERY =
  "query($owner:String!,$repo:String!,$pr:Int!){" +
  "repository(owner:$owner,name:$repo){pullRequest(number:$pr){" +
  "headRefName " +
  "reviewThreads(first:100){nodes{id isResolved isOutdated " +
  "comments(first:1){nodes{path body author{login}}}}}}}}"

/** Resolve a single review thread. `threadId` is a NAMED `-F` variable. */
export const RESOLVE_THREAD_MUTATION =
  "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){" +
  "thread{id isResolved}}}"

/** Opaque GitHub node id: base64url-ish alphabet only. Rejects `-`-leading and
 *  anything that could be parsed as a flag — fail-closed before argv (same
 *  posture as `normalizeRef`). */
const NODE_ID_RE = /^[A-Za-z0-9_=-]+$/
const isUnsafeThreadId = (id: string): boolean => !NODE_ID_RE.test(id) || id.startsWith("-")

const threadIdRejected = (id: string): string =>
  `invalid threadId '${id}': expected an opaque GitHub node id ([A-Za-z0-9_=-], ` +
  "no leading '-')"

// ── Parsed GraphQL shapes (the runner returns raw stdout we JSON.parse) ──

interface ThreadNode {
  readonly id?: string
  readonly isResolved?: boolean
  readonly isOutdated?: boolean
  readonly comments?: { readonly nodes?: ReadonlyArray<{ readonly path?: string }> }
}
interface ThreadsQueryJson {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly headRefName?: string
        readonly reviewThreads?: { readonly nodes?: ReadonlyArray<ThreadNode> }
      }
    }
  }
}
interface RepoViewJson {
  readonly owner?: { readonly login?: string }
  readonly name?: string
}

const err = (output: string): ToolEvent => ({ type: "result", result: { ok: false, output } })

/** Resolve owner/repo via `gh repo view --json owner,name` through the same
 *  injected runner. (When `pr` is a URL gh resolves the repo from context; this
 *  call still yields the canonical owner/repo for the typed `-F` vars.) */
const resolveRepo = async (
  runner: GhRunner,
  ctx: CoreToolContext,
): Promise<{ ok: true; owner: string; repo: string } | { ok: false; output: string }> => {
  const r = await runner(
    ["gh", "repo", "view", "--json", "owner,name"],
    ctx.cwd,
    DEFAULT_TIMEOUT_MS,
  )
  if (r.code !== 0) return { ok: false, output: `gh repo view failed: ${r.stderr.slice(0, 500)}` }
  let parsed: RepoViewJson
  try {
    parsed = JSON.parse(r.stdout) as RepoViewJson
  } catch (e) {
    return { ok: false, output: `gh repo view returned non-JSON: ${errMessage(e)}` }
  }
  const owner = parsed.owner?.login
  const repo = parsed.name
  if (owner === undefined || repo === undefined) {
    return { ok: false, output: "gh repo view did not return owner/name" }
  }
  return { ok: true, owner, repo }
}

/** Run the unresolved-threads GraphQL query → parsed `{headRefName, threads}`.
 *  Threads are filtered to UNRESOLVED only. */
const listUnresolved = async (
  runner: GhRunner,
  owner: string,
  repo: string,
  prNum: string,
  ctx: CoreToolContext,
): Promise<
  | { ok: true; headRefName?: string; threads: Array<{ id: string; path?: string }> }
  | { ok: false; output: string }
> => {
  const argv = [
    "gh",
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repo}`,
    "-F",
    `pr=${prNum}`,
    "-f",
    `query=${UNRESOLVED_THREADS_QUERY}`,
  ]
  const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
  if (r.code !== 0) return { ok: false, output: `gh api graphql failed: ${r.stderr.slice(0, 500)}` }
  let parsed: ThreadsQueryJson
  try {
    parsed = JSON.parse(r.stdout) as ThreadsQueryJson
  } catch (e) {
    return { ok: false, output: `gh api graphql returned non-JSON: ${errMessage(e)}` }
  }
  const pr = parsed.data?.repository?.pullRequest
  const nodes = pr?.reviewThreads?.nodes ?? []
  const threads: Array<{ id: string; path?: string }> = []
  for (const n of nodes) {
    if (n.isResolved === true) continue
    if (n.id === undefined) continue
    const path = n.comments?.nodes?.[0]?.path
    threads.push(path !== undefined ? { id: n.id, path } : { id: n.id })
  }
  const result: {
    ok: true
    headRefName?: string
    threads: Array<{ id: string; path?: string }>
  } = { ok: true, threads }
  if (pr?.headRefName !== undefined) result.headRefName = pr.headRefName
  return result
}

/** Run the `resolveReviewThread` mutation for one id. */
const resolveOne = async (
  runner: GhRunner,
  threadId: string,
  ctx: CoreToolContext,
): Promise<{ ok: true } | { ok: false; output: string }> => {
  const argv = [
    "gh",
    "api",
    "graphql",
    "-F",
    `threadId=${threadId}`,
    "-f",
    `query=${RESOLVE_THREAD_MUTATION}`,
  ]
  const r = await runner(argv, ctx.cwd, DEFAULT_TIMEOUT_MS)
  if (r.code !== 0) return { ok: false, output: `gh api graphql failed: ${r.stderr.slice(0, 500)}` }
  return { ok: true }
}

/** Outcome of the bounded concurrent-push handling. */
type DivergenceOutcome =
  | { kind: "ok" } // local == origin/<head>, OR a single clean rebase landed
  | { kind: "head_moved" } // diverged + rebaseOnDivergence:false (no git mutation)
  | { kind: "rebase_conflict" } // rebase conflicted → aborted, fail-closed
  | { kind: "bad_head_ref"; ref: string } // headRefName from GraphQL is arg-injection-unsafe
  | { kind: "git_failed"; detail: string }

/** SECURITY — `headRefName` arrives from the GraphQL RESPONSE (a network trust
 *  boundary), then flows straight into `git fetch origin <ref>` argv. A
 *  `-`-leading ref (`--upload-pack=…`, `--exec=…`) would be parsed by git as a
 *  FLAG — arg-injection — and an embedded whitespace / control char is never a
 *  valid git branch ref anyway. Reject such a head ref BEFORE any git argv is
 *  built (same fail-closed posture as `normalizeRef` for the positional PR ref).
 *  The `origin/<ref>` forms in rev-list/rebase can't be `-`-leading, but the
 *  bare `git fetch origin <ref>` can — so this is the load-bearing guard. */
export const isUnsafeHeadRef = (ref: string): boolean => {
  if (ref.length === 0) return true
  if (ref.startsWith("-")) return true
  // No whitespace — a git branch ref never contains a space/tab/newline; its
  // presence signals a poisoned value, not a real branch. (Interior dashes are
  // fine: `feat/foo-bar` is a normal branch; only a LEADING dash flag-injects.)
  if (/\s/.test(ref)) return true
  // No ASCII control chars (0x00-0x1f) — git refs forbid them outright.
  for (let i = 0; i < ref.length; i++) {
    if (ref.charCodeAt(i) < 0x20) return true
  }
  return false
}

/** Has the local branch diverged from `origin/<headRef>`? A rev-list of
 *  `HEAD..origin/<headRef>` with ANY output ⇒ the remote moved ahead. */
const remoteAhead = async (
  git: GitRunner,
  headRef: string,
  ctx: CoreToolContext,
): Promise<
  { outcome: "diverged" } | { outcome: "same" } | { outcome: "git_failed"; detail: string }
> => {
  try {
    const r = await git.run(["rev-list", "--count", `HEAD..origin/${headRef}`], ctx.cwd, ctx.signal)
    if (r.exitCode !== 0) return { outcome: "git_failed", detail: r.stderr.trim().slice(0, 200) }
    const count = Number.parseInt(r.stdout.trim(), 10)
    if (Number.isNaN(count)) {
      return { outcome: "git_failed", detail: `unparseable rev-list count: ${r.stdout.trim()}` }
    }
    return count > 0 ? { outcome: "diverged" } : { outcome: "same" }
  } catch (e) {
    return { outcome: "git_failed", detail: errMessage(e) }
  }
}

/** BOUNDED (≤1) fetch+rebase on concurrent-push divergence. Fail-closed on
 *  conflict (rebase --abort) and on a SECOND divergence after the single rebase
 *  (no unbounded loop). NO git mutation runs when `rebaseOnDivergence` is false. */
const handleDivergence = async (
  git: GitRunner,
  headRef: string,
  rebaseOnDivergence: boolean,
  ctx: CoreToolContext,
): Promise<DivergenceOutcome> => {
  // SECURITY — `headRef` came from the GraphQL response (network trust boundary);
  // reject an arg-injection-unsafe ref BEFORE it reaches ANY git argv (the bare
  // `git fetch origin <ref>` below would parse a `-`-leading value as a flag).
  if (isUnsafeHeadRef(headRef)) return { kind: "bad_head_ref", ref: headRef }
  // 1. fetch the remote head (read-only network; needed to compare local vs remote)
  const fetched = await git.run(["fetch", "origin", headRef], ctx.cwd, ctx.signal)
  if (fetched.exitCode !== 0) {
    return { kind: "git_failed", detail: fetched.stderr.trim().slice(0, 200) }
  }
  const before = await remoteAhead(git, headRef, ctx)
  if (before.outcome === "git_failed") return { kind: "git_failed", detail: before.detail }
  if (before.outcome === "same") return { kind: "ok" }
  // Diverged.
  if (!rebaseOnDivergence) return { kind: "head_moved" } // NO git mutation runs
  // 2. exactly ONE rebase attempt.
  const rebased = await git.run(["rebase", `origin/${headRef}`], ctx.cwd, ctx.signal)
  if (rebased.exitCode !== 0) {
    // Conflict (or any rebase failure) → abort, fail-closed (no resolve).
    await git.run(["rebase", "--abort"], ctx.cwd, ctx.signal)
    return { kind: "rebase_conflict" }
  }
  // 3. BOUNDED: re-check ONCE; a SECOND divergence ⇒ fail-closed (NOT a loop).
  const after = await remoteAhead(git, headRef, ctx)
  if (after.outcome === "git_failed") return { kind: "git_failed", detail: after.detail }
  if (after.outcome === "diverged") return { kind: "head_moved" }
  return { kind: "ok" }
}

/** Map a {@link DivergenceOutcome} to a terminal `ok:false` ToolEvent, or
 *  `null` when resolution may proceed ("ok"). Pulled out of `execute` so the
 *  generator's branching stays within the cognitive-complexity budget. */
const divergenceBlock = (div: DivergenceOutcome, headRef: string): ToolEvent | null => {
  switch (div.kind) {
    case "ok":
      return null
    case "head_moved":
      return {
        type: "result",
        result: {
          ok: false,
          output:
            `PR head '${headRef}' moved on origin (concurrent push). ` +
            "Fetch + rebase, then retry — or pass {rebaseOnDivergence:true} to " +
            "rebase automatically (bounded, fail-closed on conflict).",
          failure: { mode: "rejected", reason: "head_moved" },
        },
      }
    case "rebase_conflict":
      return {
        type: "result",
        result: {
          ok: false,
          output:
            "rebase onto the updated PR head CONFLICTED — aborted (no thread " +
            "resolved). Resolve the conflict manually, then retry.",
          failure: { mode: "rejected", reason: "rebase_conflict" },
        },
      }
    case "bad_head_ref":
      return {
        type: "result",
        result: {
          ok: false,
          output:
            `refusing to operate on PR head '${div.ref}': the head ref name returned ` +
            "by GitHub is not a safe git ref (leading dash / whitespace / control " +
            "char) — it would be parsed as a flag. No git command was run.",
          failure: { mode: "rejected", reason: "bad_head_ref" },
        },
      }
    default:
      return err(`could not run git (${div.detail}) — could not verify the PR head`)
  }
}

const renderList = (
  prRef: string,
  threads: ReadonlyArray<{ id: string; path?: string }>,
): string => {
  if (threads.length === 0) return `PR #${prRef}: no unresolved review threads.`
  const lines = threads.map((t) => `- ${t.id}${t.path !== undefined ? `  (${t.path})` : ""}`)
  return [`PR #${prRef}: ${threads.length} unresolved review thread(s):`, ...lines].join("\n")
}

export const ghPrResolveThreadTool = (
  runner: GhRunner = defaultGhRunner,
  gitRunner: GitRunner,
): Tool<PrResolveThreadInput> => ({
  name: "gh_pr_resolve_thread",
  description:
    "Resolve GitHub PR review threads via the `resolveReviewThread` GraphQL " +
    "mutation. Omit {threadId} to LIST unresolved thread ids; pass {threadId} to " +
    "resolve one; {all:true} resolves every unresolved thread. Write — the mode's " +
    "gitWrite lever is the structural gate. {rebaseOnDivergence:true} performs a " +
    "bounded (≤1) fetch+rebase if the PR head moved underneath you, fail-closed " +
    "on conflict (so you never resolve against a stale head).",
  inputSchema: prResolveThreadSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: PrResolveThreadInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const ref = normalizeRef(input.pr)
    if (ref === undefined) {
      yield err(refRejected("PR", input.pr))
      return
    }
    if (input.threadId !== undefined && isUnsafeThreadId(input.threadId)) {
      yield err(threadIdRejected(input.threadId))
      return
    }
    const repo = await resolveRepo(runner, ctx)
    if (!repo.ok) {
      yield err(repo.output)
      return
    }
    const r = { owner: repo.owner, repo: repo.repo }
    // LIST mode (no threadId, no all) vs RESOLVE modes (resolve-one / resolve-all).
    yield* input.threadId === undefined && input.all !== true
      ? runListMode(runner, r, ref, input.pr, ctx)
      : runResolveModes(runner, gitRunner, r, ref, input, ctx)
  },
})

/** LIST mode — query unresolved threads, render the picker list. */
async function* runListMode(
  runner: GhRunner,
  r: { owner: string; repo: string },
  ref: string,
  prLabel: string | number,
  ctx: CoreToolContext,
): AsyncIterable<ToolEvent> {
  yield { type: "progress", message: `gh api graphql (list threads) #${prLabel}` }
  const listed = await listUnresolved(runner, r.owner, r.repo, ref, ctx)
  if (!listed.ok) {
    yield err(listed.output)
    return
  }
  yield { type: "result", result: { ok: true, output: renderList(ref, listed.threads) } }
}

/** RESOLVE modes — list (for headRef + ids) → bounded concurrent-push handling →
 *  resolve the target thread(s). Split out of `execute` so each generator stays
 *  within the cognitive-complexity budget. */
async function* runResolveModes(
  runner: GhRunner,
  gitRunner: GitRunner,
  r: { owner: string; repo: string },
  ref: string,
  input: PrResolveThreadInput,
  ctx: CoreToolContext,
): AsyncIterable<ToolEvent> {
  const listed = await listUnresolved(runner, r.owner, r.repo, ref, ctx)
  if (!listed.ok) {
    yield err(listed.output)
    return
  }
  // Concurrent-push handling (only when a head ref is known).
  if (listed.headRefName !== undefined) {
    yield { type: "progress", message: `git fetch origin ${listed.headRefName}` }
    const div = await handleDivergence(
      gitRunner,
      listed.headRefName,
      input.rebaseOnDivergence === true,
      ctx,
    )
    const blocked = divergenceBlock(div, listed.headRefName)
    if (blocked !== null) {
      yield blocked
      return
    }
  }
  // Resolve-one: the validated threadId. Resolve-all: the unresolved ids,
  // RE-LISTED after a potential rebase (ids may have changed under the new head).
  let targets: string[]
  if (input.all === true) {
    const fresh =
      listed.headRefName !== undefined
        ? await listUnresolved(runner, r.owner, r.repo, ref, ctx)
        : listed
    if (!fresh.ok) {
      yield err(fresh.output)
      return
    }
    targets = fresh.threads.map((t) => t.id)
  } else {
    targets = [input.threadId as string]
  }
  if (targets.length === 0) {
    yield { type: "result", result: { ok: true, output: "no unresolved threads to resolve" } }
    return
  }
  const resolved: string[] = []
  for (const id of targets) {
    yield { type: "progress", message: `gh api graphql resolveReviewThread ${id}` }
    const res = await resolveOne(runner, id, ctx)
    if (!res.ok) {
      yield err(res.output)
      return
    }
    resolved.push(id)
  }
  yield {
    type: "result",
    result: { ok: true, output: `resolved ${resolved.length} thread(s): ${resolved.join(", ")}` },
  }
}

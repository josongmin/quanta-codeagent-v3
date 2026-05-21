import type { Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type GitRunner, type GitUpstreamCheckInput, gitUpstreamCheckInputSchema } from "./types"

/** A branch with no configured upstream produces a recognizable stderr from
 *  `git rev-parse @{upstream}` (the wording varies slightly across git
 *  versions). Treat any of these as the graceful "no upstream" path rather
 *  than a hard error. */
const isNoUpstream = (stderr: string): boolean =>
  /no upstream|does not point to a branch|no such (branch|ref)|HEAD does not/i.test(stderr)

/** `git rev-list --left-right --count HEAD...@{upstream}` prints two
 *  whitespace-separated integers: commits unique to the left side (HEAD =
 *  ahead) and to the right side (upstream = behind). */
const parseAheadBehind = (stdout: string): { ahead: number; behind: number } => {
  const m = /^(\d+)\s+(\d+)/.exec(stdout.trim())
  if (!m?.[1] || !m[2]) return { ahead: 0, behind: 0 }
  return { ahead: Number(m[1]), behind: Number(m[2]) }
}

const formatUpstream = (args: {
  branch: string
  upstream: string
  ahead: number
  behind: number
}): string => {
  const { branch, upstream, ahead, behind } = args
  const head = `Branch ${branch} → upstream ${upstream}: ahead ${ahead}, behind ${behind}`
  const note =
    behind > 0
      ? `upstream has ${behind} new commit(s); consider pulling`
      : "up to date with upstream"
  return `${head}\n${note}`
}

/** absorb #5 — upstream-change detection. READ-ONLY + CONCURRENCY-SAFE: it
 *  never touches the index or the network. It compares HEAD against the
 *  already-fetched remote-tracking ref and reports ahead/behind, with an
 *  actionable note when the upstream is ahead (commits to pull). */
export const gitUpstreamCheckTool = (runner: GitRunner): Tool<GitUpstreamCheckInput> => ({
  name: "git_upstream_check",
  description:
    "Report whether the current branch's upstream (already-fetched remote-tracking ref) " +
    "is ahead/behind. Does NOT fetch — run a fetch via bash first to refresh.",
  inputSchema: gitUpstreamCheckInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(_input: GitUpstreamCheckInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    yield { type: "progress", message: "git upstream check" }

    // 1. Resolve the upstream ref name. A missing upstream is a graceful ok.
    const upstreamOut = await safeRun(
      runner,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      ctx.cwd,
      "git upstream check",
    )
    if (upstreamOut.kind === "spawn-error") {
      yield { type: "result", result: { ok: false, output: upstreamOut.message } }
      return
    }
    const upstreamRes = upstreamOut.result
    if (upstreamRes.exitCode !== 0) {
      if (isNoUpstream(upstreamRes.stderr)) {
        yield { type: "result", result: { ok: true, output: "no upstream tracking branch" } }
        return
      }
      yield {
        type: "result",
        result: {
          ok: false,
          output: stderrReason(upstreamRes.stderr, upstreamRes.exitCode, "git upstream check"),
        },
      }
      return
    }
    const upstream = upstreamRes.stdout.trim()

    // 2. Resolve the current branch name (best-effort; falls back to HEAD).
    const branchOut = await safeRun(
      runner,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ctx.cwd,
      "git upstream check",
    )
    const branch =
      branchOut.kind === "ok" && branchOut.result.exitCode === 0
        ? branchOut.result.stdout.trim() || "HEAD"
        : "HEAD"

    // 3. Count ahead/behind against the already-fetched upstream.
    const countOut = await safeRun(
      runner,
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      ctx.cwd,
      "git upstream check",
    )
    if (countOut.kind === "spawn-error") {
      yield { type: "result", result: { ok: false, output: countOut.message } }
      return
    }
    const countRes = countOut.result
    if (countRes.exitCode !== 0) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: stderrReason(countRes.stderr, countRes.exitCode, "git upstream check"),
        },
      }
      return
    }
    const { ahead, behind } = parseAheadBehind(countRes.stdout)

    yield {
      type: "result",
      result: { ok: true, output: formatUpstream({ branch, upstream, ahead, behind }) },
    }
  },
})

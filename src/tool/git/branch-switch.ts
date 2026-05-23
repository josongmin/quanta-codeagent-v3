/** `git_branch_switch` — Claude Desktop 1.7196.3 `commitWipForBranchSwitch`
 *  pattern absorption. Atomically:
 *
 *    1. probe working tree with `git status --porcelain`
 *    2. if dirty + autoWip=true ⇒ run a `git_commit({mode:'wip'})` flow
 *       (stage all + auto-message) before switching
 *    3. if dirty + autoWip=false (default) ⇒ return ok:false with a stash hint
 *    4. `git switch <branch>` (or `-c <branch>` when create=true)
 *
 *  Tier = "pre-approval-ok": a branch switch is reversible (the user can
 *  switch back, the wip commit is recoverable). Branch name is gated at the
 *  schema layer ([A-Za-z0-9._/+-], no leading '-', 64-char cap) so a malicious
 *  name cannot escape the argv we hand to `git`. */

import type { Tool, ToolContext, ToolEvent } from "../types"
import { mutate } from "./_shared"
import { type GitBranchSwitchInput, type GitRunner, gitBranchSwitchInputSchema } from "./types"

const autoWipMessage = (): string => `wip: ${new Date().toISOString()}`

const DIRTY_REJECTION =
  "working tree is dirty; pass autoWip:true to create a wip checkpoint, or `git stash` first"

/** True ⇒ `git status --porcelain` stdout contains any change line. The
 *  porcelain format emits one line per changed/untracked file; an empty
 *  string means clean. We trim to ignore a possible trailing newline. */
const isDirty = (porcelainStdout: string): boolean => porcelainStdout.trim().length > 0

const buildSwitchArgs = (branch: string, create: boolean | undefined): string[] =>
  create ? ["switch", "-c", branch] : ["switch", "--", branch]

type Step = { ok: true; dirty: boolean } | { ok: false; error: string }
type Outcome = { ok: true } | { ok: false; error: string }

/** Probe the working tree. Returns either an error message or the dirty flag. */
const probeWorkingTree = async (
  runner: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<Step> => {
  const out = await mutate(runner, ["status", "--porcelain"], cwd, "git status", signal)
  if (out.kind === "err") return { ok: false, error: out.output }
  return { ok: true, dirty: isDirty(out.stdout) }
}

/** Stage all + commit wip checkpoint. Hooks run (no `--no-verify`). */
const runWipCheckpoint = async (
  runner: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<Outcome> => {
  const addOut = await mutate(runner, ["add", "--", "."], cwd, "git add", signal)
  if (addOut.kind === "err") return { ok: false, error: addOut.output }
  const commitOut = await mutate(
    runner,
    ["commit", "-m", autoWipMessage()],
    cwd,
    "git commit",
    signal,
  )
  if (commitOut.kind === "err") return { ok: false, error: commitOut.output }
  return { ok: true }
}

const runSwitch = async (
  runner: GitRunner,
  cwd: string,
  branch: string,
  create: boolean | undefined,
  signal: AbortSignal | undefined,
): Promise<Outcome> => {
  const out = await mutate(runner, buildSwitchArgs(branch, create), cwd, "git switch", signal)
  if (out.kind === "err") return { ok: false, error: out.output }
  return { ok: true }
}

const failResult = (output: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output },
})

export const gitBranchSwitchTool = (runner: GitRunner): Tool<GitBranchSwitchInput> => ({
  name: "git_branch_switch",
  description:
    "Switch branches with an optional session-boundary wip checkpoint. When the working tree is dirty and autoWip=true, commits a wip checkpoint first; otherwise fails with a stash hint.",
  inputSchema: gitBranchSwitchInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

  async *execute(input: GitBranchSwitchInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitBranchSwitchInputSchema.safeParse(input)
    if (!parsed.success) {
      yield failResult(`invalid input: ${parsed.error.message}`)
      return
    }
    const { branch, autoWip, create } = parsed.data

    yield { type: "progress", message: "git status --porcelain" }
    const probe = await probeWorkingTree(runner, ctx.cwd, ctx.signal)
    if (!probe.ok) {
      yield failResult(probe.error)
      return
    }
    const dirty = probe.dirty

    if (dirty && !autoWip) {
      yield failResult(DIRTY_REJECTION)
      return
    }

    if (dirty) {
      yield { type: "progress", message: "git add + commit (wip checkpoint)" }
      const wip = await runWipCheckpoint(runner, ctx.cwd, ctx.signal)
      if (!wip.ok) {
        yield failResult(wip.error)
        return
      }
    }

    yield { type: "progress", message: `git switch ${branch}` }
    const sw = await runSwitch(runner, ctx.cwd, branch, create, ctx.signal)
    if (!sw.ok) {
      yield failResult(sw.error)
      return
    }

    const wipNote = dirty ? " (wip checkpoint created)" : ""
    const createNote = create ? " (created)" : ""
    yield {
      type: "result",
      result: { ok: true, output: `switched to ${branch}${createNote}${wipNote}` },
    }
  },
})

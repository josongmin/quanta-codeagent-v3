/** `git_branch_switch` — Claude Desktop 1.7196.3 `commitWipForBranchSwitch`
 *  pattern absorption, extended (§7.4) with a 3-WAY dirty-checkout action.
 *  Atomically:
 *
 *    1. probe working tree with `git status --porcelain`
 *    2. if dirty, clear it via the resolved dirtyAction:
 *         - "commit-wip" (or legacy autoWip=true): stage all + wip commit
 *         - "stash": `git stash push -u` (recoverable via `git stash pop`)
 *         - "discard": `git checkout -- .` + `git clean -fd` (DESTRUCTIVE)
 *    3. if dirty + no action resolved (legacy autoWip=false, no dirtyAction)
 *       ⇒ return ok:false with a hint
 *    4. `git switch <branch>` (or `-c <branch>` when create=true)
 *
 *  Tier = "pre-approval-ok": a branch switch is reversible (the user can
 *  switch back, the wip commit is recoverable). Branch name is gated at the
 *  schema layer ([A-Za-z0-9._/+-], no leading '-', 64-char cap) so a malicious
 *  name cannot escape the argv we hand to `git`. */

import type { GitDirectiveEmitter } from "../../agent/git-directives"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { mutate } from "./_shared"
import {
  type GitBranchSwitchInput,
  type GitDirtyAction,
  type GitRunner,
  gitBranchSwitchInputSchema,
} from "./types"

/** ADR-0220 wire — caller-injected opts. Default-OMIT under
 *  `exactOptionalPropertyTypes`. When supplied, a successful switch with
 *  `create:true` emits `{ kind: "create-branch", name }`; a wip checkpoint
 *  that ran before the switch emits `{ kind: "commit", sha, message }`
 *  (sha best-effort via `git rev-parse HEAD`). Switch-without-create does
 *  NOT emit (no directive kind exists for plain checkout). */
export interface GitBranchSwitchToolOpts {
  readonly gitDirectiveEmitter?: GitDirectiveEmitter
}

const autoWipMessage = (): string => `wip: ${new Date().toISOString()}`

/** Stash label for the §7.4 stash flow. Identifiable prefix so the user can
 *  `git stash list | grep branch-switch` and `git stash pop` later. The ISO
 *  timestamp disambiguates repeated stashes. */
const stashLabel = (): string => `branch-switch wip: ${new Date().toISOString()}`

const DIRTY_REJECTION =
  'working tree is dirty; pass dirtyAction:"commit-wip"|"stash"|"discard" (or autoWip:true) — or `git stash` first'

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

/** §7.4 stash flow — non-destructive. `git stash push -u` saves tracked AND
 *  untracked edits to the stash stack (recover with `git stash pop`). Mirrors
 *  the `-u -m <label>` shape used by `@/apps/cli/rewind-git`. */
const runStash = async (
  runner: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<Outcome> => {
  const out = await mutate(
    runner,
    ["stash", "push", "-u", "-m", stashLabel()],
    cwd,
    "git stash",
    signal,
  )
  if (out.kind === "err") return { ok: false, error: out.output }
  return { ok: true }
}

/** §7.4 discard flow — DESTRUCTIVE. Drops tracked edits (`git checkout -- .`)
 *  AND untracked files/dirs (`git clean -fd`). Mirrors the `clean -fd` shape
 *  used by `@/storage/shadow-odb` for `untracked:"discard"`. No reflog entry
 *  for working-tree edits, so this is irreversible. Tracked discard runs FIRST
 *  so a mid-flow failure leaves the (still-present) untracked files for the
 *  user to inspect rather than deleting them before the tracked discard even
 *  succeeded. */
const runDiscard = async (
  runner: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<Outcome> => {
  const checkoutOut = await mutate(runner, ["checkout", "--", "."], cwd, "git checkout", signal)
  if (checkoutOut.kind === "err") return { ok: false, error: checkoutOut.output }
  const cleanOut = await mutate(runner, ["clean", "-fd"], cwd, "git clean", signal)
  if (cleanOut.kind === "err") return { ok: false, error: cleanOut.output }
  return { ok: true }
}

/** Resolve the effective dirty action. `dirtyAction` (explicit 3-way) takes
 *  precedence; otherwise fall back to the legacy `autoWip` toggle. Returns
 *  `undefined` ⇒ the dirty tree must be REJECTED (legacy autoWip:false). */
const resolveDirtyAction = (
  dirtyAction: GitDirtyAction | undefined,
  autoWip: boolean | undefined,
): GitDirtyAction | undefined => {
  if (dirtyAction !== undefined) return dirtyAction
  return autoWip === true ? "commit-wip" : undefined
}

/** Run the chosen dirty-tree clearing flow. Pure dispatch over the resolved
 *  action; the caller has already confirmed the tree is dirty. */
const runDirtyFlow = async (
  action: GitDirtyAction,
  runner: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<Outcome> => {
  if (action === "stash") return runStash(runner, cwd, signal)
  if (action === "discard") return runDiscard(runner, cwd, signal)
  return runWipCheckpoint(runner, cwd, signal)
}

/** Progress + result-note copy for each action. */
const PROGRESS: Record<GitDirtyAction, string> = {
  "commit-wip": "git add + commit (wip checkpoint)",
  stash: "git stash push -u (saving dirty tree)",
  discard: "git checkout -- . + git clean -fd (DISCARDING dirty tree)",
}
const RESULT_NOTE: Record<GitDirtyAction, string> = {
  "commit-wip": " (wip checkpoint created)",
  stash: " (dirty tree stashed; recover with `git stash pop`)",
  discard: " (dirty tree discarded)",
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

export const gitBranchSwitchTool = (
  runner: GitRunner,
  opts: GitBranchSwitchToolOpts = {},
): Tool<GitBranchSwitchInput> => ({
  name: "git_branch_switch",
  description:
    'Switch branches, clearing a dirty tree first via dirtyAction: "commit-wip" (stage all + a recoverable wip commit), "stash" (git stash push -u, recover with `git stash pop`), or "discard" (irreversibly drop tracked + untracked edits). With no dirtyAction, a dirty tree commits a wip checkpoint when autoWip=true, otherwise fails with a hint.',
  inputSchema: gitBranchSwitchInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  // A plain switch + commit-wip + stash are all reversible (switch back, pop
  // the stash, recover the wip commit) ⇒ pre-approval-ok. `dirtyAction:discard`
  // irreversibly drops uncommitted work (no reflog for working-tree edits) ⇒
  // escalate to always-confirm, mirroring git_commit's mode-driven tiering.
  hitlTier: (input): "pre-approval-ok" | "always-confirm" =>
    input.dirtyAction === "discard" ? "always-confirm" : "pre-approval-ok",

  async *execute(input: GitBranchSwitchInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitBranchSwitchInputSchema.safeParse(input)
    if (!parsed.success) {
      yield failResult(`invalid input: ${parsed.error.message}`)
      return
    }
    const { branch, autoWip, dirtyAction, create } = parsed.data

    yield { type: "progress", message: "git status --porcelain" }
    const probe = await probeWorkingTree(runner, ctx.cwd, ctx.signal)
    if (!probe.ok) {
      yield failResult(probe.error)
      return
    }
    const dirty = probe.dirty

    // Resolve the effective dirty action: explicit `dirtyAction` wins, else the
    // legacy `autoWip` toggle. `undefined` ⇒ a dirty tree must be rejected.
    const action = resolveDirtyAction(dirtyAction, autoWip)

    if (dirty && action === undefined) {
      yield failResult(DIRTY_REJECTION)
      return
    }

    const emitter = opts.gitDirectiveEmitter

    if (dirty && action !== undefined) {
      yield { type: "progress", message: PROGRESS[action] }
      const cleared = await runDirtyFlow(action, runner, ctx.cwd, ctx.signal)
      if (!cleared.ok) {
        yield failResult(cleared.error)
        return
      }
      // ADR-0220 wire — only the commit-wip flow produces a recoverable commit
      // to attribute. stash/discard have no closed directive kind, so they
      // never emit. Byte-identical to the legacy autoWip emit.
      if (emitter !== undefined && action === "commit-wip") {
        let sha = ""
        const shaOut = await mutate(
          runner,
          ["rev-parse", "HEAD"],
          ctx.cwd,
          "git rev-parse",
          ctx.signal,
        )
        if (shaOut.kind === "ok") sha = shaOut.stdout.trim()
        try {
          emitter.emit({ kind: "commit", sha, message: "wip checkpoint (branch-switch)" })
        } catch {
          // never poison the tool result; see ADR-0220.
        }
      }
    }

    yield { type: "progress", message: `git switch ${branch}` }
    const sw = await runSwitch(runner, ctx.cwd, branch, create, ctx.signal)
    if (!sw.ok) {
      yield failResult(sw.error)
      return
    }

    // ADR-0220 wire — only `create:true` emits a create-branch directive
    // (no closed-union kind exists for a plain checkout).
    if (emitter !== undefined && create === true) {
      try {
        emitter.emit({ kind: "create-branch", name: branch })
      } catch {
        // never poison the tool result; see ADR-0220.
      }
    }

    const dirtyNote = dirty && action !== undefined ? RESULT_NOTE[action] : ""
    const createNote = create ? " (created)" : ""
    yield {
      type: "result",
      result: { ok: true, output: `switched to ${branch}${createNote}${dirtyNote}` },
    }
  },
})

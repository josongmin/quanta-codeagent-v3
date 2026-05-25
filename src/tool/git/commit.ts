/** `git_commit` — Claude Desktop 1.7196.3 `commitWipForBranchSwitch` pattern
 *  absorption. Two modes:
 *
 *    • mode="regular" (default): `git add <paths|.> && git commit -m <msg>`.
 *      Tier = "always-confirm" — this commit can be pushed; permanent.
 *    • mode="wip": session-boundary checkpoint. Auto-generates `wip: <ts>`
 *      message when caller omits one, stages everything, but does NOT pass
 *      `--no-verify` so hooks still run. Tier = "pre-approval-ok" — reversible
 *      checkpoint that user trust-scope eligibly elides per HITL 4-tier.
 *
 *  All git invocations are argv-based (`Bun.spawn(['git', ...args])` via the
 *  injected `GitRunner`), so a commit message with shell metacharacters is
 *  carried as a single argv slot — no shell expansion.
 *
 *  ADR-0220 wire (opt-in): when `opts.gitDirectiveEmitter` is supplied, a
 *  successful commit emits a `{ kind: "commit", sha, message }` directive
 *  AFTER the commit succeeds — never on the error path. The SHA is resolved
 *  via a follow-up `git rev-parse HEAD`; if that lookup fails (rare; e.g.
 *  hook side-effects) the tool falls back to `sha: ""` so the wire never
 *  poisons the success result. Absent emitter ⇒ byte-identical legacy
 *  behavior (no rev-parse, no emit). */

import type { GitDirectiveEmitter } from "../../agent/git-directives"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { mutate } from "./_shared"
import { type GitCommitInput, type GitRunner, gitCommitInputSchema } from "./types"

/** ADR-0220 wire — caller-injected opts. Default-OMIT under
 *  `exactOptionalPropertyTypes`. */
export interface GitCommitToolOpts {
  readonly gitDirectiveEmitter?: GitDirectiveEmitter
}

/** Build the auto-generated `wip:` message when the caller did not supply one.
 *  Format: `wip: <ISO timestamp>` — short enough to read in `git log` but
 *  stable enough to surface in a diff against the prior session boundary. */
const autoWipMessage = (): string => `wip: ${new Date().toISOString()}`

const buildAddArgs = (paths: readonly string[] | undefined): string[] => {
  if (paths && paths.length > 0) return ["add", "--", ...paths]
  return ["add", "--", "."]
}

/** Resolve the final commit message based on mode. Returns either the message
 *  string or an `err` shape the caller yields as the terminal result. */
const resolveMessage = (
  mode: "wip" | "regular",
  message: string | undefined,
): { ok: true; value: string } | { ok: false; output: string } => {
  if (mode === "wip") {
    const value = message && message.length > 0 ? message : autoWipMessage()
    return { ok: true, value }
  }
  if (!message || message.length === 0) {
    return { ok: false, output: "regular commit requires a non-empty message" }
  }
  return { ok: true, value: message }
}

export const gitCommitTool = (
  runner: GitRunner,
  opts: GitCommitToolOpts = {},
): Tool<GitCommitInput> => ({
  name: "git_commit",
  description:
    "Create a git commit. mode='regular' (default) stages + commits as a permanent commit; mode='wip' stages all files + auto-generates a session-boundary checkpoint message.",
  inputSchema: gitCommitInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: (input): "pre-approval-ok" | "always-confirm" =>
    input.mode === "wip" ? "pre-approval-ok" : "always-confirm",

  async *execute(input: GitCommitInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitCommitInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const { message, mode, paths } = parsed.data
    const effectiveMode = mode ?? "regular"

    // Resolve message — wip auto-generates when absent; regular requires it.
    const resolved = resolveMessage(effectiveMode, message)
    if (!resolved.ok) {
      yield { type: "result", result: { ok: false, output: resolved.output } }
      return
    }
    const finalMessage = resolved.value

    // Stage.
    yield { type: "progress", message: "git add" }
    const addArgs = buildAddArgs(paths)
    const addOut = await mutate(runner, addArgs, ctx.cwd, "git add", ctx.signal)
    if (addOut.kind === "err") {
      yield { type: "result", result: { ok: false, output: addOut.output } }
      return
    }

    // Commit. Argv-based — `finalMessage` is one slot, no shell expansion.
    yield { type: "progress", message: "git commit" }
    const commitArgs = ["commit", "-m", finalMessage]
    const commitOut = await mutate(runner, commitArgs, ctx.cwd, "git commit", ctx.signal)
    if (commitOut.kind === "err") {
      yield { type: "result", result: { ok: false, output: commitOut.output } }
      return
    }

    // ADR-0220 wire — success-only emit (best-effort SHA resolve; failure
    // never poisons the result). Default-OFF: no emitter ⇒ no rev-parse,
    // no allocation, byte-identical legacy.
    const emitter = opts.gitDirectiveEmitter
    if (emitter !== undefined) {
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
        emitter.emit({ kind: "commit", sha, message: finalMessage })
      } catch {
        // Emit failures NEVER poison the tool result (host channel may be
        // unavailable; commit already succeeded). Swallow per ADR-0220.
      }
    }

    yield {
      type: "result",
      result: {
        ok: true,
        output: `committed (${effectiveMode}): ${finalMessage}`,
      },
    }
  },
})

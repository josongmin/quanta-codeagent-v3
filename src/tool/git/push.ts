/** `git_push` — first-class push tool (ADR-0240, completes the ADR-
 *  0221 5-directive `push` kind wire).
 *
 *  Mode (single): `git push [<remote>] [<branch>] [--force-with-lease]`.
 *  Tier = `always-confirm` — pushes are PERMANENT from the local
 *  perspective (the remote sees the new ref; recovering requires
 *  cooperation from other clones). When `force=true`, we pass
 *  `--force-with-lease` rather than `--force` so a race against a
 *  concurrent push is detected (the lease check fails ⇒ git aborts).
 *  This is the SAFE force variant; the unsafe `--force` and the
 *  catastrophic `--force --delete` combinations are STILL HARD_DENY-gated
 *  through the bash tool (policy-rules.ts) — `git_push` deliberately
 *  exposes ONLY the safe lease variant so the tool surface cannot be
 *  abused for the catastrophic combinations.
 *
 *  Argv-based — `remote` and `branch` are validated at the schema layer
 *  (no leading dash, conservative alphabet for branch / refspec / remote
 *  identifiers) so a malicious value cannot be parsed as a `git push` flag.
 *
 *  ADR-0220 + ADR-0234 wire (opt-in dual surface — same posture as
 *  `commit.ts` / `branch-switch.ts` / `stage.ts`). The two ADRs disagree
 *  on the wire shape (`{remote,branch}` vs `{ref,force}`) — published as
 *  the union locally. Absent both surfaces ⇒ byte-identical legacy. */

import { z } from "zod"
import type { GitDirective as Directive0220, GitDirectiveEmitter } from "../../agent/git-directives"
import type { GitDirective as Directive0234, GitDirectiveCollector } from "../../git/directive-emit"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import { mutate } from "./_shared"
import type { GitRunner } from "./types"

/** Remote / branch validation. Same alphabet `git_branch_switch` uses for
 *  branch names (mirrors `safeBranch` in `@/runtime/worktree-fork`). The
 *  remote uses the same alphabet — `origin`, `upstream`, `my-fork.v2`
 *  cover the realistic set without risking flag confusion. */
const IDENT_RE = /^(?!-)[A-Za-z0-9._/+-]{1,64}$/

export const gitPushInputSchema = z.object({
  remote: z
    .string()
    .min(1)
    .max(64)
    .regex(IDENT_RE, "remote must match [A-Za-z0-9._/+-] (no leading '-')")
    .optional()
    .describe("Remote name (default: origin)"),
  branch: z
    .string()
    .min(1)
    .max(64)
    .regex(IDENT_RE, "branch must match [A-Za-z0-9._/+-] (no leading '-')")
    .optional()
    .describe("Branch to push (default: current HEAD via `git push`)"),
  /** When true, `--force-with-lease` is added. The unsafe `--force` is NOT
   *  reachable through this tool — see the file header. */
  force: z.boolean().optional().describe("Pass --force-with-lease (safe force variant)"),
})
export type GitPushInput = z.infer<typeof gitPushInputSchema>

/** ADR-0240 wire — caller-injected opts. */
export interface GitPushToolOpts {
  readonly gitDirectiveEmitter?: GitDirectiveEmitter
  readonly gitDirectiveCollector?: GitDirectiveCollector
}

const DEFAULT_REMOTE = "origin"

/** Build the argv. When `branch` is absent, git pushes the current HEAD
 *  to its upstream (or `origin/<branch>` if `remote` is provided). */
const buildPushArgs = (input: GitPushInput): string[] => {
  const args: string[] = ["push"]
  if (input.force === true) args.push("--force-with-lease")
  if (input.remote !== undefined) args.push(input.remote)
  if (input.branch !== undefined) args.push(input.branch)
  return args
}

/** Resolve the wire `ref` for the ADR-0221 directive shape. The wire form
 *  prefers an `origin/<branch>` ref when both fields are known; when only
 *  the remote is set, falls back to that; when both are absent, falls back
 *  to `HEAD`. Identical-coordinate ref preserves UI tail consumers' "where
 *  did this push land" inference. */
const wireRef = (input: GitPushInput): string => {
  const remote = input.remote ?? DEFAULT_REMOTE
  if (input.branch !== undefined) return `${remote}/${input.branch}`
  return remote
}

/** Build the ADR-0220 wire shape (`{remote, branch}`). When the caller did
 *  not specify a branch, we publish `branch: ""` rather than guess — the
 *  tail consumer SHOULD interpret empty branch as "use the configured
 *  upstream". The default remote is materialized so the wire is concrete. */
const build0220Push = (input: GitPushInput): Extract<Directive0220, { kind: "push" }> => ({
  kind: "push",
  remote: input.remote ?? DEFAULT_REMOTE,
  branch: input.branch ?? "",
})

/** Build the ADR-0234 wire shape (`{ref, force}`). The ref is the
 *  `<remote>/<branch>` coordinate; `force` is the literal flag we passed. */
const build0234Push = (input: GitPushInput): Extract<Directive0234, { kind: "push" }> => ({
  kind: "push",
  ref: wireRef(input),
  force: input.force === true,
})

const publishPush = (
  input: GitPushInput,
  surfaces: {
    readonly emitter?: GitDirectiveEmitter
    readonly collector?: GitDirectiveCollector
  },
): void => {
  const { emitter, collector } = surfaces
  if (emitter !== undefined) {
    try {
      emitter.emit(build0220Push(input))
    } catch {
      /* swallow per ADR-0220 */
    }
  }
  if (collector !== undefined) {
    try {
      collector.record(build0234Push(input))
    } catch {
      /* defense-in-depth */
    }
  }
}

export const gitPushTool = (runner: GitRunner, opts: GitPushToolOpts = {}): Tool<GitPushInput> => ({
  name: "git_push",
  description:
    "Push the current branch to a remote via `git push [<remote>] [<branch>]`. " +
    "Tier=always-confirm (publishes commits to a remote). `force:true` passes " +
    "`--force-with-lease` (safe force variant); unsafe `--force` is NOT reachable.",
  inputSchema: gitPushInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: (): "always-confirm" => "always-confirm",
  // PDP capability (P2-T3): pushing commits to a remote is an inherently
  // SENSITIVE, externally-visible, hard-to-reverse action ⇒ the UNIVERSAL floor.
  // Confirmed on EVERY surface even under bypass (an autonomous surface that
  // accepts the risk opts out via `hitl.autoApprove`).
  capability: (): { confirm: "sensitive" } => ({ confirm: "sensitive" }),

  async *execute(input: GitPushInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitPushInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const data = parsed.data

    yield { type: "progress", message: `git push ${data.remote ?? ""} ${data.branch ?? ""}`.trim() }
    const out = await mutate(runner, buildPushArgs(data), ctx.cwd, "git push", ctx.signal)
    if (out.kind === "err") {
      yield { type: "result", result: { ok: false, output: out.output } }
      return
    }

    const publishOpts: {
      emitter?: GitDirectiveEmitter
      collector?: GitDirectiveCollector
    } = {}
    if (opts.gitDirectiveEmitter !== undefined) publishOpts.emitter = opts.gitDirectiveEmitter
    if (opts.gitDirectiveCollector !== undefined) publishOpts.collector = opts.gitDirectiveCollector
    publishPush(data, publishOpts)

    yield {
      type: "result",
      result: {
        ok: true,
        output: `pushed${data.branch !== undefined ? ` ${data.branch}` : ""}${
          data.force === true ? " (--force-with-lease)" : ""
        }`,
      },
    }
  },
})

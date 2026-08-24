/** `git_stage` — first-class staging tool (ADR-0240, completes the ADR-
 *  0221 5-directive `stage` kind wire).
 *
 *  Mode (single): `git add -- <paths>`. Tier = `pre-approval-ok` —
 *  staging is reversible (`git restore --staged <paths>`), so trust-scope-
 *  eligible. Argv-based — paths carry no shell expansion (the schema also
 *  rejects leading-dash paths so a malicious filename cannot be parsed as
 *  a `git add` flag).
 *
 *  ADR-0220 + ADR-0234 wire (opt-in dual surface — same posture as
 *  `commit.ts` and `branch-switch.ts`): when `opts.gitDirectiveEmitter`
 *  AND/OR `opts.gitDirectiveCollector` are supplied, a successful stage
 *  publishes the typed directive on each wired surface. The two ADRs
 *  disagree on the field name (`paths` vs `files`); we publish the union
 *  shape locally so both surfaces get bytes that round-trip cleanly.
 *  Absent both ⇒ byte-identical legacy (no allocation, no publish). */

import { z } from "zod"
import type { GitDirective as Directive0220, GitDirectiveEmitter } from "../../agent/git-directives"
import type { GitDirective as Directive0234, GitDirectiveCollector } from "../../git/directive-emit"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import { mutate } from "./_shared"
import type { GitRunner } from "./types"

/** Path validation (mirrors `git/diff.ts` leading-dash rejection): a
 *  leading `-` would be parsed by `git add` as a FLAG (`-A`, `--patch`)
 *  rather than a path. We require at least one path and reject any leading
 *  dash at the schema layer so the malformed input never reaches argv. */
export const gitStageInputSchema = z.object({
  paths: z
    .array(
      z
        .string()
        .min(1)
        .refine((p) => !p.startsWith("-"), {
          message: "paths must not start with '-' (would be parsed as a git add flag)",
        }),
    )
    .min(1)
    .describe("Paths to stage (passed verbatim to `git add --`)"),
})
export type GitStageInput = z.infer<typeof gitStageInputSchema>

/** ADR-0240 wire — caller-injected opts. Default-OMIT under
 *  `exactOptionalPropertyTypes`. Both surfaces are independent; either,
 *  both, or neither may be set. */
export interface GitStageToolOpts {
  readonly gitDirectiveEmitter?: GitDirectiveEmitter
  readonly gitDirectiveCollector?: GitDirectiveCollector
}

/** Build the ADR-0220 wire shape ({@link Directive0220.kind === "stage"} —
 *  field name `paths`). */
const build0220Stage = (paths: readonly string[]): Extract<Directive0220, { kind: "stage" }> => ({
  kind: "stage",
  paths: Object.freeze([...paths]),
})

/** Build the ADR-0234 wire shape ({@link Directive0234.kind === "stage"} —
 *  field name `files`). */
const build0234Stage = (paths: readonly string[]): Extract<Directive0234, { kind: "stage" }> => ({
  kind: "stage",
  files: Object.freeze([...paths]),
})

/** Publish the stage directive on each wired surface. Each try/catch keeps
 *  a sink failure from poisoning the tool result (the stage already
 *  succeeded). Mirror of `_directive-publish.ts` but kind-specialized
 *  because the two surfaces use different field names for `stage`. */
const publishStage = (
  paths: readonly string[],
  surfaces: {
    readonly emitter?: GitDirectiveEmitter
    readonly collector?: GitDirectiveCollector
  },
): void => {
  const { emitter, collector } = surfaces
  if (emitter !== undefined) {
    try {
      emitter.emit(build0220Stage(paths))
    } catch {
      /* swallow per ADR-0220 — wire failures never poison success. */
    }
  }
  if (collector !== undefined) {
    try {
      collector.record(build0234Stage(paths))
    } catch {
      /* defense-in-depth — record() is no-throw per contract. */
    }
  }
}

export const gitStageTool = (
  runner: GitRunner,
  opts: GitStageToolOpts = {},
): Tool<GitStageInput> => ({
  name: "git_stage",
  description:
    "Stage paths for the next commit via `git add -- <paths>`. Tier=pre-approval-ok " +
    "(reversible via `git restore --staged`). Use this instead of the bash tool when " +
    "the path list is statically known — the dedicated tool routes through the typed " +
    "directive wire (ADR-0221/0234) for UI sync.",
  inputSchema: gitStageInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

  async *execute(input: GitStageInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitStageInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const { paths } = parsed.data

    yield { type: "progress", message: `git add -- ${paths.length} path(s)` }
    const addOut = await mutate(runner, ["add", "--", ...paths], ctx.cwd, "git add", ctx.signal)
    if (addOut.kind === "err") {
      // Failure path: NEVER publish a directive (mutation did not succeed).
      yield { type: "result", result: { ok: false, output: addOut.output } }
      return
    }

    // Success-only publish — wired surfaces see the stage directive with the
    // SAME path list. Failures on either surface are swallowed (see publishStage).
    const publishOpts: {
      emitter?: GitDirectiveEmitter
      collector?: GitDirectiveCollector
    } = {}
    if (opts.gitDirectiveEmitter !== undefined) publishOpts.emitter = opts.gitDirectiveEmitter
    if (opts.gitDirectiveCollector !== undefined) publishOpts.collector = opts.gitDirectiveCollector
    publishStage(paths, publishOpts)

    yield {
      type: "result",
      result: { ok: true, output: `staged ${paths.length} path(s)` },
    }
  },
})

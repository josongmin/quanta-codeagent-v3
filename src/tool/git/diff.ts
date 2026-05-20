import type { Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type GitDiffInput, type GitRunner, gitDiffInputSchema } from "./types"

const MAX_OUTPUT = 50_000

const truncate = (s: string): string => {
  if (s.length <= MAX_OUTPUT) return s
  return `${s.slice(0, MAX_OUTPUT)}\n… (truncated, ${s.length - MAX_OUTPUT} more chars)`
}

const buildArgs = (input: GitDiffInput): string[] => {
  const args: string[] = ["diff"]
  if (input.staged) args.push("--staged")
  if (input.base) args.push(input.base)
  if (input.paths && input.paths.length > 0) args.push("--", ...input.paths)
  return args
}

export const gitDiffTool = (runner: GitRunner): Tool<GitDiffInput> => ({
  name: "git_diff",
  description: "Show unified diff vs working tree / staged area / a base revision.",
  inputSchema: gitDiffInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: GitDiffInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitDiffInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const args = buildArgs(parsed.data)
    yield { type: "progress", message: `git ${args.join(" ")}` }

    const out = await safeRun(runner, args, ctx.cwd, "git diff")
    if (out.kind === "spawn-error") {
      yield { type: "result", result: { ok: false, output: out.message } }
      return
    }
    const r = out.result
    // git diff exits 0 (no diff) and 1 (has diff) — both are OK; >1 is failure.
    if (r.exitCode > 1) {
      yield {
        type: "result",
        result: { ok: false, output: stderrReason(r.stderr, r.exitCode, "git diff") },
      }
      return
    }
    const body = r.stdout.trimEnd()
    yield {
      type: "result",
      result: { ok: true, output: body.length === 0 ? "(no diff)" : truncate(body) },
    }
  },
})

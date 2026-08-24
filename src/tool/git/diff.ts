import type { CoreToolContext, Tool, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type GitDiffInput, type GitRunner, gitDiffInputSchema } from "./types"

const MAX_OUTPUT = 50_000

/** Raised by {@link buildArgs} when `base` begins with `-` (would be parsed as
 *  a `git diff` option rather than a revision). Caught in `execute` and turned
 *  into a deterministic `ok:false` result — never thrown to the loop. */
class GitDiffBaseRejected extends Error {
  constructor(base: string) {
    super(
      `invalid base revision '${base}': a revision must not begin with '-' ` +
        "(would be parsed as a git option)",
    )
    this.name = "GitDiffBaseRejected"
  }
}

const truncate = (s: string): string => {
  if (s.length <= MAX_OUTPUT) return s
  return `${s.slice(0, MAX_OUTPUT)}\n… (truncated, ${s.length - MAX_OUTPUT} more chars)`
}

const buildArgs = (input: GitDiffInput): string[] => {
  const args: string[] = ["diff"]
  if (input.staged) args.push("--staged")
  // SECURITY: `base` is a bare positional that MUST precede the `--` path
  // separator, so it cannot be `--`-guarded like `paths`. A revision never
  // begins with `-`; a leading-dash value (`--output=/etc/x`, `--ext-diff`,
  // `-G<re>`) would be parsed by `git diff` as an OPTION — `--output` in
  // particular is an arbitrary-file WRITE primitive that escapes this tool's
  // read-only contract. Reject it before it reaches argv. The caller-facing
  // contract (revision string) is unchanged for every legitimate input.
  if (input.base?.startsWith("-")) {
    throw new GitDiffBaseRejected(input.base)
  }
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

  async *execute(input: GitDiffInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitDiffInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    let args: string[]
    try {
      args = buildArgs(parsed.data)
    } catch (e) {
      if (e instanceof GitDiffBaseRejected) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }
    yield { type: "progress", message: `git ${args.join(" ")}` }

    const out = await safeRun(runner, args, ctx.cwd, "git diff", ctx.signal)
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

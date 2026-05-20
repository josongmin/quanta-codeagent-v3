import type { Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type GitLogInput, type GitRunner, gitLogInputSchema } from "./types"

const formatLine = (raw: string): string | null => {
  // hash<TAB>author<TAB>iso8601<TAB>subject
  const parts = raw.split("\t")
  if (parts.length < 4) return null
  const [hash, author, iso, ...subjectParts] = parts
  if (!hash || !author || !iso) return null
  const subject = subjectParts.join("\t")
  return `${hash.slice(0, 8)} (${author}, ${iso.slice(0, 10)}) ${subject}`
}

const buildArgs = (count: number, file: string | undefined): string[] => {
  const args: string[] = ["log", "--format=%H%x09%an%x09%ai%x09%s", "-n", String(count)]
  if (file) args.push("--follow", "--", file)
  return args
}

const formatBody = (stdout: string): string => {
  const body = stdout.trimEnd()
  if (body.length === 0) return "(no commits)"
  const rows = body
    .split("\n")
    .map(formatLine)
    .filter((x): x is string => x !== null)
  return rows.length === 0 ? "(no commits)" : rows.join("\n")
}

export const gitLogTool = (runner: GitRunner): Tool<GitLogInput> => ({
  name: "git_log",
  description: "List recent commits (optionally for one file).",
  inputSchema: gitLogInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: GitLogInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = gitLogInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    const { file, n } = parsed.data
    const count = n ?? 10
    const args = buildArgs(count, file)

    yield { type: "progress", message: `git log -n ${count}${file ? ` -- ${file}` : ""}` }

    const out = await safeRun(runner, args, ctx.cwd, "git log")
    if (out.kind === "spawn-error") {
      yield { type: "result", result: { ok: false, output: out.message } }
      return
    }
    const r = out.result
    if (r.exitCode !== 0) {
      yield {
        type: "result",
        result: { ok: false, output: stderrReason(r.stderr, r.exitCode, "git log") },
      }
      return
    }
    yield { type: "result", result: { ok: true, output: formatBody(r.stdout) } }
  },
})

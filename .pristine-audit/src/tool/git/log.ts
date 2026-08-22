import type { Tool, ToolContext, ToolEvent } from "../types"
import { safeRun, stderrReason } from "./_shared"
import { type GitLogInput, type GitRunner, gitLogInputSchema } from "./types"

/**
 * US-separator (`\x1f`, ASCII 31, the "Unit Separator" control char) chosen
 * deliberately as the field delimiter instead of TAB (`\x09`) — Codex §18.7
 * absorption (ADR-0105). Commit subjects and author names CAN contain TABs
 * (rare but legal), which silently breaks a TAB-split parser. `\x1f` is in
 * the ASCII control-character range that git treats as opaque bytes and
 * commit messages never legitimately contain. Pin this constant so a future
 * format-string edit stays in lock-step with {@link formatLine}.
 */
const US_SEP = "\x1f"

const formatLine = (raw: string): string | null => {
  // hash<US>author<US>iso8601<US>subject
  const parts = raw.split(US_SEP)
  if (parts.length < 4) return null
  const [hash, author, iso, ...subjectParts] = parts
  if (!hash || !author || !iso) return null
  // Rejoin subject parts in case it contained a US char (it shouldn't, but
  // be conservative).
  const subject = subjectParts.join(US_SEP)
  return `${hash.slice(0, 8)} (${author}, ${iso.slice(0, 10)}) ${subject}`
}

const buildArgs = (count: number, file: string | undefined): string[] => {
  // `--no-textconv --no-ext-diff` add belt-and-suspenders determinism: a
  // user's `.gitattributes` textconv driver or external diff command MUST
  // NOT influence the log format. (`git log` doesn't actually use these
  // by default, but pinning them eliminates a class of "weird output"
  // surprises if the repo grows attributes-based config.)
  const args: string[] = [
    "log",
    "--no-textconv",
    "--no-ext-diff",
    "--format=%H%x1f%an%x1f%ai%x1f%s",
    "-n",
    String(count),
  ]
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

    const out = await safeRun(runner, args, ctx.cwd, "git log", ctx.signal)
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

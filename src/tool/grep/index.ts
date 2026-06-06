import { z } from "zod"
import { runShell } from "@/runtime"
import { FsJailError, resolveJailed } from "@/storage"
import { defineTool } from "../factory"
import type { ToolContext, ToolEvent } from "../types"

const schema = z.object({
  pattern: z.string().describe("Regex pattern (ripgrep syntax)"),
  path: z.string().optional().describe("File or directory to search (default cwd)"),
  glob: z.string().optional().describe("Filter files by glob, e.g. '*.ts'"),
  // Context lines (rg -A/-B/-C). Bounded + integer-validated before use; under
  // count / files_with_matches modes they are ignored (see CONTEXT_MAX note).
  A: z.number().int().optional().describe("Context lines AFTER each match (rg -A)"),
  B: z.number().int().optional().describe("Context lines BEFORE each match (rg -B)"),
  C: z.number().int().optional().describe("Context lines AROUND each match (rg -C)"),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe("content (default, path:line:match) | files_with_matches (rg -l) | count (rg -c)"),
  i: z.boolean().optional().describe("Case-insensitive search (rg -i)"),
  multiline: z.boolean().optional().describe("Multiline + dotall (rg -U --multiline-dotall)"),
  type: z.string().optional().describe("Restrict to a ripgrep file type, e.g. 'ts', 'py'"),
})

type Input = z.infer<typeof schema>

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

const MAX_LINES = 200

// DoS bound for context line counts. rg buffers `N` extra lines per match; an
// unbounded `N` (e.g. 1e9 from a confused/hostile model) would blow up output
// and memory. 10000 is a hard ceiling — far above any legitimate review need
// yet bounded — NOT a UX number. Out-of-bound / non-integer counts are dropped
// (fail-closed), never clamped silently or forwarded raw.
const CONTEXT_MAX = 10_000

/** Validate a model-supplied context count: a finite integer in [0, CONTEXT_MAX].
 *  Returns the string form for an UNQUOTED rg argv token, or undefined to drop. */
const ctxArg = (n: number | undefined): string | undefined => {
  if (n === undefined) return undefined
  if (!Number.isInteger(n) || n < 0 || n > CONTEXT_MAX) return undefined
  return String(n)
}

/**
 * Pure argv builder for the grep tool — separated from `execute` so the flag
 * surface (an injection / DoS boundary) is exhaustively testable. `jailedPath`
 * is already jail-resolved by the caller; this function does NOT touch the FS.
 *
 * Invariants proven by `grep-flags-hellgate.test.ts`:
 *   - string flags (`type`) go through `sq()` → single shell token (no inject)
 *   - integer flags are `Number.isInteger` + bounded, passed UNQUOTED
 *   - absent all new fields → argv byte-identical to the original fixed argv
 *   - context flags are dropped under count / files_with_matches (rg-incompatible)
 */
export const buildGrepArgv = (input: Input, jailedPath?: string): string[] => {
  const mode = input.output_mode ?? "content"
  const parts = ["rg", "--line-number", "--no-heading", "--color=never"]

  // Mode flags. content = today's default (no extra flag). The line-oriented
  // base flags are inert under -l/-c, so the baseline stays byte-identical.
  if (mode === "files_with_matches") parts.push("-l")
  else if (mode === "count") parts.push("-c")

  if (input.i === true) parts.push("-i")
  if (input.multiline === true) parts.push("-U", "--multiline-dotall")
  if (input.type !== undefined) parts.push("--type", sq(input.type))

  // Context lines apply only in content mode (rg ignores/conflicts otherwise).
  if (mode === "content") {
    const a = ctxArg(input.A)
    const b = ctxArg(input.B)
    const c = ctxArg(input.C)
    if (a !== undefined) parts.push("-A", a)
    if (b !== undefined) parts.push("-B", b)
    if (c !== undefined) parts.push("-C", c)
  }

  if (input.glob) parts.push("-g", sq(input.glob))
  parts.push("-e", sq(input.pattern))
  if (jailedPath !== undefined) parts.push(sq(jailedPath))
  return parts
}

export const grepTool = defineTool<Input>({
  name: "grep",
  description:
    "Search file contents with ripgrep. Returns `path:line:match` rows. " +
    "Row output is capped at 200 lines. If you hit the cap, NARROW with a more " +
    "specific pattern or restrict the `path` (e.g. `src/agent/`) before switching " +
    "to a different tool or asking the user (ADR-0062).",
  inputSchema: schema,
  isReadOnly: () => true,
  // Read-only content search (rg has no side effects); safe to parallelize.
  isConcurrencySafe: () => true,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    yield { type: "progress", message: `searching for ${input.pattern}…` }

    // S14: jail-validate the model-supplied path BEFORE building argv.
    // Without this, `path: "/etc"` would escape the workspace via the
    // ripgrep subprocess; the storage seam's `resolveJailed` is the only
    // legitimate way to construct a `JailedPath`.
    let jailedPath: string | undefined
    if (input.path !== undefined) {
      try {
        jailedPath = resolveJailed(input.path, ctx.cwd)
      } catch (e) {
        if (e instanceof FsJailError) {
          yield { type: "result", result: { ok: false, output: e.message } }
          return
        }
        throw e
      }
    }

    const parts = buildGrepArgv(input, jailedPath)

    const r = await runShell(parts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })

    if (r.exitCode === 1 && !r.stdout) {
      yield { type: "result", result: { ok: true, output: "(no matches)" } }
      return
    }
    if (r.exitCode > 1 || r.timedOut) {
      yield {
        type: "result",
        result: { ok: false, output: r.stderr.trim() || `ripgrep failed (exit ${r.exitCode})` },
      }
      return
    }
    const lines = r.stdout.trimEnd().split("\n")
    const shown = lines.slice(0, MAX_LINES).join("\n")
    const more = lines.length > MAX_LINES ? `\n… (${lines.length - MAX_LINES} more matches)` : ""
    yield { type: "result", result: { ok: true, output: shown + more } }
  },
})

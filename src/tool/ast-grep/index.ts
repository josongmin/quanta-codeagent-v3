import { z } from "zod"
import { runShell } from "@/runtime"
import { defineTool } from "../factory"
import type { ToolContext, ToolEvent } from "../types"

const schema = z.object({
  pattern: z
    .string()
    .describe("ast-grep pattern. Use $VAR for metavariables matching any code."),
  path: z
    .string()
    .optional()
    .describe("Directory or file to search. Default: current working directory."),
  language: z
    .string()
    .optional()
    .describe(
      "Language hint (e.g. python, typescript, rust). Auto-detected from file extension if omitted.",
    ),
})

type Input = z.infer<typeof schema>

const MAX_MATCHES = 50

/** Timeout for the availability probe (fast binary exec — ≤10 s is generous). */
const PROBE_TIMEOUT_MS = 10_000
/** Timeout for a full structural search pass. 30 s caps runaway regex/AST walks;
 *  most repo-wide searches complete in <5 s. Bounded by the CLI turn abort
 *  signal which supersedes this in practice. */
const SEARCH_TIMEOUT_MS = 30_000

// Module-level probe cache: undefined = not yet probed, true = available,
// string = error message (ast-grep not installed or broken).
let probeResult: true | string | undefined = undefined

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Probe for ast-grep once; cache the result. Returns undefined on success, error
 *  message string on failure. */
async function probeAstGrep(cwd: string): Promise<string | undefined> {
  if (probeResult !== undefined) {
    return probeResult === true ? undefined : probeResult
  }
  const r = await runShell("ast-grep --version", { cwd, timeoutMs: PROBE_TIMEOUT_MS })
  if (r.exitCode === 0) {
    probeResult = true
    return undefined
  }
  const msg =
    "ast-grep not installed; run: brew install ast-grep  (or: cargo install ast-grep)"
  probeResult = msg
  return msg
}

export const astGrepTool = defineTool<Input>({
  name: "ast_grep",
  description:
    "Structural code search using ast-grep patterns. Finds code by AST shape, not text — " +
    "no false positives from comments or strings. " +
    "Example: pattern 'console.log($A)' finds all console.log calls regardless of whitespace or argument. " +
    "Requires ast-grep CLI (brew install ast-grep / cargo install ast-grep).",
  inputSchema: schema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    yield { type: "progress", message: `ast-grep: searching for pattern ${input.pattern}…` }

    const probeError = await probeAstGrep(ctx.cwd)
    if (probeError !== undefined) {
      yield { type: "result", result: { ok: false, output: probeError } }
      return
    }

    const parts: string[] = ["ast-grep", "run", "--pattern", sq(input.pattern)]
    if (input.language !== undefined) {
      parts.push("--lang", sq(input.language))
    }
    parts.push("--json")
    if (input.path !== undefined) {
      parts.push(sq(input.path))
    }

    const r = await runShell(parts.join(" "), {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: SEARCH_TIMEOUT_MS,
    })

    if (r.timedOut) {
      yield { type: "result", result: { ok: false, output: "ast-grep timed out after 30s" } }
      return
    }

    // ast-grep exits 0 on matches, 1 on no matches, >1 on error.
    // When there are no matches stdout is empty or "[]".
    if (r.exitCode > 1) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: r.stderr.trim() || `ast-grep failed (exit ${r.exitCode})`,
        },
      }
      return
    }

    const stdout = r.stdout.trim()
    if (!stdout || stdout === "[]") {
      yield { type: "result", result: { ok: true, output: "(no matches)" } }
      return
    }

    let matches: Array<{ file: string; range: { start: { line: number } }; text: string }>
    try {
      matches = JSON.parse(stdout)
    } catch {
      yield {
        type: "result",
        result: { ok: false, output: `ast-grep returned non-JSON output: ${stdout.slice(0, 200)}` },
      }
      return
    }

    if (!Array.isArray(matches) || matches.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no matches)" } }
      return
    }

    const shown = matches.slice(0, MAX_MATCHES)
    const lines = shown.map((m) => {
      const line = m.range?.start?.line ?? 0
      const text = (m.text ?? "").trim()
      return `${m.file}:${line + 1}: ${text}`
    })

    const more =
      matches.length > MAX_MATCHES
        ? `\n... ${matches.length - MAX_MATCHES} more matches`
        : ""

    yield { type: "result", result: { ok: true, output: lines.join("\n") + more } }
  },
})

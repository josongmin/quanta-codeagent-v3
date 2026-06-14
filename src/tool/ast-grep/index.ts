import { z } from "zod"
import { runShell } from "@/runtime"
import { FsJailError, resolveJailed } from "@/storage"
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
/**
 * Maximum number of bytes to read from ast-grep's stdout before parsing JSON.
 * Prevents OOM on large repos where a broad pattern (e.g. `$A`) matches
 * millions of nodes and ast-grep streams gigabytes of JSON.
 * 2 MB is generous for 50 shown matches at ~100 bytes each; truncating here
 * causes JSON.parse to throw a SyntaxError which the catch block handles as
 * ok:false + error message.
 */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024 // 2 MB

/** Timeout for the availability probe (fast binary exec — ≤10 s is generous). */
const PROBE_TIMEOUT_MS = 10_000
/** Timeout for a full structural search pass. 30 s caps runaway regex/AST walks;
 *  most repo-wide searches complete in <5 s. Bounded by the CLI turn abort
 *  signal which supersedes this in practice. */
const SEARCH_TIMEOUT_MS = 30_000

// B2 fix: Cache ONLY a successful probe result as `true`.
// Failure results are NOT cached so that a subsequent install of ast-grep
// during the same session allows the tool to work without a process restart.
// Concurrent-probe race: a `Promise<string | undefined>` deduplicates parallel
// first-call probes (both await the same Promise instead of spawning two).
let probePromise: Promise<string | undefined> | undefined = undefined
let probeSucceeded = false

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Probe for ast-grep; cache only on success. Returns undefined on success,
 *  error message string on failure. Concurrent callers share the same Promise
 *  for the in-flight probe, then on failure the cache is cleared so the next
 *  call re-probes (allowing install-then-use workflows). */
async function probeAstGrep(cwd: string): Promise<string | undefined> {
  // Fast path: if a previous probe succeeded, skip re-probing.
  if (probeSucceeded) return undefined

  // In-flight deduplication: if a probe is already running, await it.
  if (probePromise !== undefined) return probePromise

  probePromise = runShell("ast-grep --version", { cwd, timeoutMs: PROBE_TIMEOUT_MS }).then(
    (r) => {
      if (r.exitCode === 0) {
        probeSucceeded = true
        // Keep probePromise set (resolved) so concurrent callers get the success.
        return undefined
      }
      const msg =
        "ast-grep not installed; run: brew install ast-grep  (or: cargo install ast-grep)"
      // B2 fix: do NOT permanently cache the failure. Clear the in-flight
      // promise so the next call re-probes. probeSucceeded stays false.
      probePromise = undefined
      return msg
    },
  )

  return probePromise
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

    // B1 fix: validate the path against the workspace fs-jail before use.
    // Without this check, `path: "/etc/passwd"` would escape the workspace
    // via the ast-grep subprocess, reading an arbitrary file on the host.
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

    const parts: string[] = ["ast-grep", "run", "--pattern", sq(input.pattern)]
    if (input.language !== undefined) {
      parts.push("--lang", sq(input.language))
    }
    // B7 fix: cap output at source to avoid buffering millions of JSON matches.
    // --max-count is supported by ast-grep ≥0.20; older versions silently ignore
    // unknown flags (harmless), so we always pass it.
    parts.push("--max-count", String(MAX_MATCHES))
    parts.push("--json")
    if (jailedPath !== undefined) {
      parts.push(sq(jailedPath))
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

    // B7 fix: cap the raw stdout string before JSON.parse to bound RAM usage.
    // If ast-grep emits more than MAX_STDOUT_BYTES despite --max-count (e.g. on
    // an older version that ignores the flag), we truncate here. The truncated
    // JSON will fail to parse; the catch block reports ok:false with a clear
    // error rather than OOM.
    const rawStdout = r.stdout.length > MAX_STDOUT_BYTES
      ? r.stdout.slice(0, MAX_STDOUT_BYTES)
      : r.stdout
    const stdout = rawStdout.trim()

    if (!stdout || stdout === "[]") {
      yield { type: "result", result: { ok: true, output: "(no matches)" } }
      return
    }

    let matches: Array<{ file: string; range: { start: { line: number } }; text: string }>
    try {
      matches = JSON.parse(stdout)
    } catch (_e) {
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
      // B4 fix: ast-grep can match multi-line constructs (e.g. entire function
      // bodies). m.text may contain embedded '\n' characters. After .trim(),
      // those internal newlines remain, breaking the file:line: one-per-line
      // contract when lines.join('\n') is called. Replace internal newlines
      // with a visible marker so each match stays on exactly one output line.
      const text = (m.text ?? "").replace(/\n/g, "↵").trim()
      return `${m.file}:${line + 1}: ${text}`
    })

    const more =
      matches.length > MAX_MATCHES
        ? `\n... ${matches.length - MAX_MATCHES} more matches`
        : ""

    yield { type: "result", result: { ok: true, output: lines.join("\n") + more } }
  },
})

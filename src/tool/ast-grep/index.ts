import { z } from "zod"
import { runShell } from "@/runtime"
import { FsJailError, resolveJailed } from "@/storage"
import { defineTool } from "../factory"
import type { CoreToolContext, ToolEvent } from "../types"

const schema = z.object({
  pattern: z.string().describe("ast-grep pattern. Use $VAR for metavariables matching any code."),
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
let probePromise: Promise<string | undefined> | undefined
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

  probePromise = runShell("ast-grep --version", { cwd, timeoutMs: PROBE_TIMEOUT_MS }).then((r) => {
    if (r.exitCode === 0) {
      probeSucceeded = true
      // Keep probePromise set (resolved) so concurrent callers get the success.
      return undefined
    }
    const msg = "ast-grep not installed; run: brew install ast-grep  (or: cargo install ast-grep)"
    // B2 fix: do NOT permanently cache the failure. Clear the in-flight
    // promise so the next call re-probes. probeSucceeded stays false.
    probePromise = undefined
    return msg
  })

  return probePromise
}

/** The one terminal answer an ast-grep invocation produces. */
type AstGrepResult = { readonly ok: boolean; readonly output: string }

/**
 * Resolve the optional `path` against the workspace fs-jail.
 *
 * B1 fix: validate the path against the workspace fs-jail before use. Without
 * this check, `path: "/etc/passwd"` would escape the workspace via the ast-grep
 * subprocess, reading an arbitrary file on the host.
 *
 * Its own unit because it is the only gate whose refusal is a SECURITY answer
 * rather than a tool failure — and because a non-jail error must still
 * propagate (it is a bug, not a refusal), which is easy to lose in a rewrite.
 */
const jailSearchPath = (
  input: Input,
  ctx: CoreToolContext,
): { readonly jailedPath: string | undefined } | { readonly refusal: string } => {
  if (input.path === undefined) return { jailedPath: undefined }
  try {
    return { jailedPath: resolveJailed(input.path, ctx.cwd) }
  } catch (e) {
    if (e instanceof FsJailError) return { refusal: e.message }
    throw e
  }
}

/** Build the ast-grep argv string. A unit so the exact flag set (and its ORDER)
 *  is readable in one place — every flag here is version-sensitive. */
const astGrepCommand = (input: Input, jailedPath: string | undefined): string => {
  const parts: string[] = ["ast-grep", "run", "--pattern", sq(input.pattern)]
  if (input.language !== undefined) {
    parts.push("--lang", sq(input.language))
  }
  // B7 fix: cap output at source to avoid buffering millions of JSON matches.
  // NOTE: ast-grep `sg run` has no per-result count flag (unlike ripgrep).
  // Clap CLIs error on unrecognised arguments (exit 2), so any unknown flag
  // would break every invocation on all installed versions. The stdout-slice
  // guard below (MAX_STDOUT_BYTES) is the correct OOM defence — it truncates
  // the raw string before JSON.parse and reports a clear error on truncation.
  parts.push("--json")
  if (jailedPath !== undefined) {
    parts.push(sq(jailedPath))
  }
  return parts.join(" ")
}

type AstGrepMatch = { file: string; range: { start: { line: number } }; text: string }

/**
 * Render the match list. Split out because it is the only PURE part of the
 * pipeline — everything above it is a gate over an external process.
 */
const formatMatches = (matches: readonly AstGrepMatch[], truncated: boolean): string => {
  const shown = matches.slice(0, MAX_MATCHES)
  const lines = shown.map((m) => {
    const line = m.range?.start?.line ?? 0
    // B4 fix: ast-grep can match multi-line constructs (e.g. entire function
    // bodies). m.text may contain embedded '\n' or '\r\n' characters. After
    // .trim(), those internal newlines remain, breaking the file:line:
    // one-per-line contract when lines.join('\n') is called. Replace internal
    // newlines (CRLF or LF) with a visible marker so each match stays on
    // exactly one output line. Use \r?\n to strip the \r before replacing the
    // \n, preventing a stray \r from corrupting ANSI terminal output.
    const text = (m.text ?? "").replace(/\r?\n/g, "↵").trim()
    return `${m.file}:${line + 1}: ${text}`
  })

  const more =
    matches.length > MAX_MATCHES ? `\n... ${matches.length - MAX_MATCHES} more matches` : ""

  let output = lines.join("\n") + more
  if (truncated) {
    output += "\n(warning: output was truncated at 2 MB — result may be incomplete)"
  }
  return output
}

/**
 * Interpret one completed ast-grep run.
 *
 * A unit because it is a LADDER of five mutually exclusive terminal readings of
 * the same shell result — timeout, hard error, no output, unparseable output,
 * non-array output — and inline each rung sat inside the async generator and
 * paid its nesting surcharge on top of its own `yield`/`return` pair.
 */
const readAstGrepRun = (r: {
  timedOut: boolean
  exitCode: number
  stdout: string
  stderr: string
}): AstGrepResult => {
  if (r.timedOut) return { ok: false, output: "ast-grep timed out after 30s" }

  // ast-grep exits 0 on matches, 1 on no matches, >1 on error.
  // When there are no matches stdout is empty or "[]".
  if (r.exitCode > 1) {
    return { ok: false, output: r.stderr.trim() || `ast-grep failed (exit ${r.exitCode})` }
  }

  // B7 fix: cap the raw stdout string before JSON.parse to bound RAM usage.
  // This stdout-slice is the sole OOM guard (no per-result count CLI flag in
  // ast-grep). Truncated JSON will fail to parse; the catch block below
  // reports ok:false with a clear error rather than crashing the process.
  const truncated = r.stdout.length > MAX_STDOUT_BYTES
  const rawStdout = truncated ? r.stdout.slice(0, MAX_STDOUT_BYTES) : r.stdout
  const stdout = rawStdout.trim()

  if (!stdout || stdout === "[]") return { ok: true, output: "(no matches)" }

  let matches: AstGrepMatch[]
  try {
    matches = JSON.parse(stdout)
  } catch (_e) {
    return { ok: false, output: `ast-grep returned non-JSON output: ${stdout.slice(0, 200)}` }
  }

  if (!Array.isArray(matches) || matches.length === 0) return { ok: true, output: "(no matches)" }

  return { ok: true, output: formatMatches(matches, truncated) }
}

/** The whole search, start to finish, as ONE value. Keeping it out of the
 *  generator is what collapses seven `yield`/`return` pairs into a single
 *  `yield` at the call site. */
const runAstGrep = async (input: Input, ctx: CoreToolContext): Promise<AstGrepResult> => {
  const probeError = await probeAstGrep(ctx.cwd)
  if (probeError !== undefined) return { ok: false, output: probeError }

  const jail = jailSearchPath(input, ctx)
  if ("refusal" in jail) return { ok: false, output: jail.refusal }

  const r = await runShell(astGrepCommand(input, jail.jailedPath), {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
  })
  return readAstGrepRun(r)
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

  async *execute(input: Input, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    yield { type: "progress", message: `ast-grep: searching for pattern ${input.pattern}…` }
    yield { type: "result", result: await runAstGrep(input, ctx) }
  },
})

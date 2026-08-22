/**
 * `/web <url> [--no-markdown] [--max-bytes=N]` (ADR-0224 — Aider `/web`
 * absorption).
 *
 * Fetches an HTTPS URL via the existing `web_fetch` tool (ADR-0148) and
 * attaches the result (HTML→Markdown by default, raw text with
 * `--no-markdown`) to the SURFACE's text-inbox so the very next user turn
 * carries the page as context.
 *
 * Surface contract:
 *   - `ctx.textInbox` wired ⇒ output is queued for the next turn; slash
 *     prints `/web: queued (N chars, total Q in inbox)`.
 *   - `ctx.textInbox` absent ⇒ slash prints the body to stdout directly so
 *     a one-shot / shell-entry surface still benefits ("not wired" parity
 *     would lose the fetch result the user just paid for).
 *
 * Slice posture (RFC §3.1):
 *   - Lives in `apps/cli`. Imports `@/tool/web` (the existing tool factory)
 *     + the local `./text-inbox` + `./slash-commands` for the SlashContext
 *     extension. NO `@/agent`, `@/permission`, `@/storage`.
 *   - exactOptionalPropertyTypes-clean — every optional field on the input /
 *     argument-parse result is gated by a presence check before spread.
 *   - No-throw: every failure mode (bad URL, SSRF deny, non-2xx, oversize,
 *     binary content) is surfaced through the tool's typed ok:false
 *     {@link ToolResult}; the slash never re-throws.
 *
 * Default-OFF: the tool is always available (read-only, no provider);
 * what's gated is the inbox wiring — without it, the fetched text still
 * reaches the user (printed to stdout) so `/web` is never silently broken.
 */

import { webFetchTool } from "@/tool/web"
import type { SlashCommand } from "./slash-commands"
import type { TextInbox } from "./text-inbox"

/* ------------------------------------------------------------------ */
/* SlashContext extension                                              */
/* ------------------------------------------------------------------ */

declare module "./slash-commands" {
  interface SlashContext {
    /** ADR-0224 single-shot text inbox the next-turn `PromptSource.next()`
     *  drains and prepends to the user's literal text. Absent ⇒ `/web` and
     *  `/paste` print the body to stdout instead (degraded, not broken). */
    readonly textInbox?: TextInbox | undefined
    /** Optional injection of a `fetch` impl for testing without touching
     *  the network. Threaded straight into `webFetchTool({ fetcher })`. */
    readonly webFetcher?: typeof fetch | undefined
  }
}

/* ------------------------------------------------------------------ */
/* arg parsing                                                          */
/* ------------------------------------------------------------------ */

interface ParsedArgs {
  readonly url: string
  readonly markdown: boolean
  readonly maxBytes?: number
}

const parseArgs = (args: readonly string[]): ParsedArgs | string => {
  let url: string | undefined
  let markdown = true
  let maxBytes: number | undefined
  for (const a of args) {
    if (a === "--no-markdown") {
      markdown = false
      continue
    }
    if (a.startsWith("--max-bytes=")) {
      const raw = a.slice("--max-bytes=".length)
      const n = Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return `invalid --max-bytes: ${raw}`
      }
      maxBytes = n
      continue
    }
    if (a.startsWith("--")) return `unknown flag: ${a}`
    if (url !== undefined) return `unexpected extra argument: ${a}`
    url = a
  }
  if (url === undefined) return "missing required <url> argument"
  return maxBytes === undefined ? { url, markdown } : { url, markdown, maxBytes }
}

/* ------------------------------------------------------------------ */
/* tool invocation                                                      */
/* ------------------------------------------------------------------ */

/** Drive the tool's async-iterable execute to completion and return the
 *  single `result` event. The web_fetch tool emits exactly one `result`
 *  event per invocation (no progress/notification events), so we collect
 *  the first and stop. */
const runWebFetch = async (args: {
  readonly url: string
  readonly maxBytes: number | undefined
  readonly fetcher: typeof fetch | undefined
  readonly signal: AbortSignal
  readonly cwd: string
}): Promise<{ ok: true; output: string } | { ok: false; output: string }> => {
  const tool = args.fetcher !== undefined ? webFetchTool({ fetcher: args.fetcher }) : webFetchTool()
  const input =
    args.maxBytes === undefined ? { url: args.url } : { url: args.url, maxBytes: args.maxBytes }
  const ctx = { cwd: args.cwd, signal: args.signal }
  for await (const ev of tool.execute(input, ctx)) {
    if (ev.type === "result") {
      const r = ev.result
      if (r.ok) return { ok: true, output: r.output }
      return { ok: false, output: r.output }
    }
  }
  // Defensive: webFetchTool always yields a result; this arm only fires if a
  // future refactor regresses the contract. Surface as ok:false so callers
  // still see a typed exit code instead of a hang.
  return { ok: false, output: "web_fetch produced no result event" }
}

/* ------------------------------------------------------------------ */
/* output stripping (--no-markdown)                                     */
/* ------------------------------------------------------------------ */

/** Extract just the BODY of a `web_fetch` ok output. The tool emits a
 *  4-line header (`URL:`, `Status:`, `Content-Type:`, `Length:`) followed
 *  by a blank line and then the markdown/text body. We strip the header
 *  ONLY for `--no-markdown` mode (where the user explicitly wants the raw
 *  bytes). The default path keeps the header so the model can ground its
 *  understanding ("this is a Status 200 text/html page").
 *
 *  Defensive: if the header layout ever changes (extra fields), we look
 *  for the FIRST blank line as the body sentinel; absent ⇒ return the
 *  whole string. */
const stripFetchHeader = (output: string): string => {
  const idx = output.indexOf("\n\n")
  if (idx < 0) return output
  return output.slice(idx + 2)
}

/* ------------------------------------------------------------------ */
/* delivery                                                             */
/* ------------------------------------------------------------------ */

const MAX_LABEL_LEN = 100

const truncateLabel = (s: string): string =>
  s.length <= MAX_LABEL_LEN ? s : `${s.slice(0, MAX_LABEL_LEN - 3)}...`

/** Deliver the fetched body to the inbox when wired, else stdout. Returns
 *  the exit code (0 on success, 1 when the inbox rejects on cap). */
const deliver = (args: {
  readonly inbox: TextInbox | undefined
  readonly url: string
  readonly body: string
  readonly out: (s: string) => void
  readonly err: (s: string) => void
}): number => {
  if (args.inbox === undefined) {
    args.out(`${args.body}\n`)
    args.out(`/web: ok (${args.body.length} chars; inbox not wired — printed inline)\n`)
    return 0
  }
  const res = args.inbox.add({
    kind: "web",
    label: truncateLabel(args.url),
    text: args.body,
  })
  if (res.kind === "over_cap") {
    args.err(`/web: inbox full (cap=${res.cap}); use /paste/web sparingly or restart REPL\n`)
    return 1
  }
  args.out(`/web: queued (${args.body.length} chars, ${args.inbox.size()} in inbox)\n`)
  return 0
}

/* ------------------------------------------------------------------ */
/* command                                                              */
/* ------------------------------------------------------------------ */

export const webCmd: SlashCommand = {
  name: "/web",
  describe: "Fetch an HTTPS URL and attach as markdown to the next turn",
  category: "session",
  async run(args, ctx) {
    const parsed = parseArgs(args)
    if (typeof parsed === "string") {
      ctx.err(`/web: ${parsed}\n`)
      ctx.err("usage: /web <https-url> [--no-markdown] [--max-bytes=N]\n")
      return 1
    }
    // The web_fetch tool's own AbortController; we never want a slash to
    // hang forever, so we install a 60s ceiling. Surfaces with their own
    // cancel signal (raw-line-reader) can refine this later via a SlashContext
    // field, but a hardcoded ceiling is the safe default for a CLI command.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    let res: { ok: true; output: string } | { ok: false; output: string }
    try {
      res = await runWebFetch({
        url: parsed.url,
        maxBytes: parsed.maxBytes,
        fetcher: ctx.webFetcher,
        signal: controller.signal,
        cwd: ctx.cwd,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      ctx.err(`/web: ${res.output}\n`)
      return 1
    }
    const body = parsed.markdown ? res.output : stripFetchHeader(res.output)
    return deliver({
      inbox: ctx.textInbox,
      url: parsed.url,
      body,
      out: ctx.out,
      err: ctx.err,
    })
  },
  complete(_args, _partial, _ctx) {
    return [
      { value: "--no-markdown", kind: "argument", description: "skip HTML→markdown conversion" },
      { value: "--max-bytes=", kind: "argument", description: "response cap in bytes (≤5MB)" },
    ]
  },
}

/** Test-only re-exports. */
export const __test = {
  parseArgs,
  stripFetchHeader,
  runWebFetch,
  deliver,
  truncateLabel,
}

/** ADR-0197 — interactive CLI `ElicitationPrompter`.
 *
 *  Renders the request to a writer, awaits one line from a reader, validates,
 *  retries ONCE on validation error, aborts on `signal`. The reader is an
 *  injectable port so tests (and a future TUI) can substitute their own
 *  source; the default reads `process.stdin` line by line via `readline`.
 *
 *  Empty options list short-circuits to `reason: "empty-enum"` BEFORE
 *  prompting (no IO performed). NaN / Infinity inputs surface as
 *  `reason: "invalid-input"` (the second-time-around path of the retry). */

import { spawn } from "node:child_process"
import { sanitizeLogText } from "@/shared"
import type { ElicitationFailureReason, ElicitationPrompter, ElicitationResult } from "./port"
import {
  type BooleanRequest,
  type EnumOption,
  type EnumRequest,
  enumOptionLabel,
  type IntegerRequest,
  type MultiSelectEnumRequest,
  type NumberRequest,
  type SingleSelectEnumRequest,
  type StringRequest,
  type UrlRequest,
  validateBoolean,
  validateInteger,
  validateNumber,
  validateString,
  validateUrl,
} from "./schemas"

/** Pluggable IO. `read` resolves with a single trimmed line; `null` signals
 *  EOF (treated as cancellation). */
export interface CliPrompterIO {
  write(s: string): void
  read(signal: AbortSignal): Promise<string | null>
}

/** TICKET-22 — the default system browser opener for the URL variant.
 *
 *  MIRRORS (does not import — the OAuth opener is private to `@/auth`) the
 *  system-open idiom in `src/auth/chatgpt-oauth/browser-flow.ts`: `open` on
 *  darwin, `cmd /c start` on win32, `xdg-open` elsewhere, spawned detached and
 *  unref'd so the child outlives this process and we never block on the
 *  browser. Fire-and-forget: a spawn failure is SWALLOWED (no throw escapes)
 *  because the elicitation succeeds the moment the user said "yes" — the
 *  browser launch is best-effort, not part of the result contract.
 *
 *  Injected as a seam (`cliPrompter(io, opener)`) per the surface model: a
 *  Tauri/Web surface owns its own navigation (`WebviewWindow` / `location.href`)
 *  and passes its own opener; tests pass a capturing opener. */
const defaultOpener = (url: string): void => {
  const platform = process.platform
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
  const args = platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
    child.unref()
  } catch {
    // best-effort: a failed browser launch must not fail the elicitation.
  }
}

/** SECURITY — every string interpolated into a prompt LINE below originates
 *  with the REMOTE MCP server (`elicitation/create` params), and `io.write`
 *  goes straight to the operator's TTY. Raw ANSI/CSI + CR lets that server
 *  erase the line the harness just printed and repaint a harness-looking
 *  prompt (`[quanta] Paste your AWS secret key:`) whose answer is returned to
 *  the SAME server; a raw LF forges an extra line. Unlike sampling there is no
 *  `QUANTA_MCP_CAPS` gate in front of this surface.
 *
 *  We reuse `@/shared` {@link sanitizeLogText} (the log-plane defence) rather
 *  than `@/tool` `neutralizeTerminalOutput`: the two differ exactly on LF/TAB,
 *  which that one PRESERVES because model-visible command output needs its own
 *  line structure. Here the PROMPTER owns the line structure (it inserts the
 *  `\n` between prompt and options and the trailing `> `), so a server LF is
 *  itself the forge vector — the single-line discipline of the log plane is
 *  the matching threat model, and it also folds the C1 8-bit CSI introducer
 *  and NFKC-equivalent homographs that a caret-defang would leave standing.
 *
 *  DISPLAY-ONLY: the enum matcher and the returned value still use the RAW
 *  label, so the wire contract with the server is byte-unchanged (widening the
 *  matcher to also accept the sanitized form would change which answers
 *  resolve — a behavior change this hardening deliberately avoids). A benign
 *  request is unaffected: control-free text passes through untouched. */
const safeText = (s: string): string => sanitizeLogText(s)

/** The `[Title] ` prefix when a request carries one, else "". */
const titlePrefix = (title: string | undefined): string =>
  title !== undefined ? `[${safeText(title)}] ` : ""

/** Render one option row. A structured option shows its label plus (when set) a
 *  `— description` and a `[preview]` affordance; a bare string renders as before
 *  (byte-identical to the pre-widening single-line form). */
const renderOption = (o: EnumOption, i: number): string => {
  if (typeof o === "string") return `  ${i + 1}. ${safeText(o)}`
  const desc = o.description !== undefined ? ` — ${safeText(o.description)}` : ""
  const prev = o.preview !== undefined ? ` [${safeText(o.preview)}]` : ""
  return `  ${i + 1}. ${safeText(o.label)}${desc}${prev}`
}

const renderOptions = (options: ReadonlyArray<EnumOption>): string =>
  options.map(renderOption).join("\n")

/** The chip-header prefix (`(Header) `) when a request carries one, else "".
 *  Combined AFTER the title prefix so both render (title is the port label, the
 *  header is the AskUserQuestion chip). */
const headerPrefix = (header: string | undefined): string =>
  header !== undefined ? `(${safeText(header)}) ` : ""

const fail = <T>(reason: ElicitationFailureReason): ElicitationResult<T> => ({
  ok: false,
  reason,
})

/** Run a validator with one retry on failure. Distinguishes cancellation
 *  (signal aborted between reads) from validation failure (two invalid lines). */
const withRetry = async <T>(
  io: CliPrompterIO,
  signal: AbortSignal,
  validate: (raw: string) => { ok: true; value: T } | { ok: false },
): Promise<ElicitationResult<T>> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return fail<T>("cancelled")
    const raw = await io.read(signal)
    if (signal.aborted) return fail<T>("cancelled")
    if (raw === null) return fail<T>("cancelled")
    const v = validate(raw)
    if (v.ok) return { ok: true, value: v.value }
    if (attempt === 0) io.write("invalid — try once more: ")
  }
  return fail<T>("validation-error")
}

/** Validate the answer "n" against a typed enum option list. The CLI accepts
 *  either the 1-based index or the literal option LABEL. A structured option's
 *  `label` is the pickable+returned text; description/preview never match. */
const matchEnum = (
  options: ReadonlyArray<EnumOption>,
  raw: string,
): { ok: true; value: string } | { ok: false } => {
  const trimmed = raw.trim()
  const asIdx = Number.parseInt(trimmed, 10)
  if (Number.isInteger(asIdx) && asIdx >= 1 && asIdx <= options.length) {
    return { ok: true, value: enumOptionLabel(options[asIdx - 1] as EnumOption) }
  }
  const byLabel = options.find((o) => enumOptionLabel(o) === trimmed)
  if (byLabel !== undefined) return { ok: true, value: enumOptionLabel(byLabel) }
  return { ok: false }
}

const matchMultiEnum = (
  req: MultiSelectEnumRequest,
  raw: string,
): { ok: true; value: ReadonlyArray<string> } | { ok: false } => {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return { ok: false }
  const selected: string[] = []
  for (const t of tokens) {
    const m = matchEnum(req.options, t)
    if (!m.ok) return { ok: false }
    if (!selected.includes(m.value)) selected.push(m.value)
  }
  if (req.minSelected !== undefined && selected.length < req.minSelected) return { ok: false }
  if (req.maxSelected !== undefined && selected.length > req.maxSelected) return { ok: false }
  return { ok: true, value: selected }
}

export const cliPrompter = (
  io: CliPrompterIO,
  opener: (url: string) => void = defaultOpener,
): ElicitationPrompter => ({
  async promptString(req: StringRequest, signal?: AbortSignal) {
    const s = signal ?? new AbortController().signal
    io.write(`${titlePrefix(req.title)}${safeText(req.prompt)}: `)
    return withRetry<string>(io, s, (raw) => validateString(req, raw))
  },
  async promptNumber(req: NumberRequest, signal?: AbortSignal) {
    const s = signal ?? new AbortController().signal
    io.write(`${titlePrefix(req.title)}${safeText(req.prompt)}: `)
    const result = await withRetry<number>(io, s, (raw) => validateNumber(req, raw))
    // After two validation failures, surface `invalid-input` (NaN/Infinity)
    // as the more-specific reason — Number/Integer is the only schema family
    // where "validation-error" is dominated by the non-finite case.
    return result.ok ? result : { ok: false, reason: "invalid-input" }
  },
  async promptInteger(req: IntegerRequest, signal?: AbortSignal) {
    const s = signal ?? new AbortController().signal
    io.write(`${titlePrefix(req.title)}${safeText(req.prompt)}: `)
    const result = await withRetry<number>(io, s, (raw) => validateInteger(req, raw))
    return result.ok ? result : { ok: false, reason: "invalid-input" }
  },
  async promptBoolean(req: BooleanRequest, signal?: AbortSignal) {
    const s = signal ?? new AbortController().signal
    io.write(`${titlePrefix(req.title)}${safeText(req.prompt)} (y/n): `)
    return withRetry<boolean>(io, s, validateBoolean)
  },
  async promptEnum(req: EnumRequest, signal?: AbortSignal) {
    if (req.options.length === 0) return fail<string>("empty-enum")
    const s = signal ?? new AbortController().signal
    io.write(
      `${titlePrefix(req.title)}${headerPrefix(req.header)}${safeText(req.prompt)}\n${renderOptions(req.options)}\n> `,
    )
    return withRetry<string>(io, s, (raw) => matchEnum(req.options, raw))
  },
  async promptMultiEnum(req: MultiSelectEnumRequest, signal?: AbortSignal) {
    if (req.options.length === 0) return fail<ReadonlyArray<string>>("empty-enum")
    const s = signal ?? new AbortController().signal
    io.write(
      `${titlePrefix(req.title)}${headerPrefix(req.header)}${safeText(req.prompt)}\n${renderOptions(req.options)}\n(comma-separated)> `,
    )
    return withRetry<ReadonlyArray<string>>(io, s, (raw) => matchMultiEnum(req, raw))
  },
  async promptSingleEnum(req: SingleSelectEnumRequest, signal?: AbortSignal) {
    if (req.options.length === 0) return fail<string>("empty-enum")
    const s = signal ?? new AbortController().signal
    io.write(
      `${titlePrefix(req.title)}${headerPrefix(req.header)}${safeText(req.prompt)}\n${renderOptions(req.options)}\n> `,
    )
    return withRetry<string>(io, s, (raw) => matchEnum(req.options, raw))
  },
  async promptUrl(req: UrlRequest, signal?: AbortSignal) {
    const s = signal ?? new AbortController().signal
    // DEFENSE-IN-DEPTH: the schema (`urlRequestSchema`) already rejects non-
    // http(s) urls, but a caller that hands us a directly-built `UrlRequest`
    // bypasses it — so re-assert the http/https invariant HERE before ever
    // rendering or opening. A `file:`/`javascript:`/`data:` url must never reach
    // the system opener.
    if (!validateUrl(req).ok) return fail<string>("invalid-input")
    // Render the FULL url on its OWN line (phishing safety — the user sees the
    // exact destination, not a truncated/styled label), then confirm.
    io.write(
      `${titlePrefix(req.title)}${safeText(req.prompt)}\n${safeText(req.url)}\nOpen in browser? (y/n): `,
    )
    const confirm = await withRetry<boolean>(io, s, validateBoolean)
    if (!confirm.ok) return confirm // cancelled / validation-error pass through
    if (!confirm.value) return fail<string>("cancelled") // declined → cancelled
    try {
      opener(req.url) // fire-and-forget — never await the browser
    } catch {
      // a failed launch must not fail the elicitation (user already said yes).
    }
    return { ok: true, value: req.url }
  },
})

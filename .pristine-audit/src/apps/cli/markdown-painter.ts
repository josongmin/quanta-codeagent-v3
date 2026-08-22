/**
 * Inline Markdown highlighter for the CLI assistant text stream.
 *
 * The agent emits `assistant_text` events as raw provider deltas (an LLM token
 * stream is a sequence of UTF-8 string fragments with no logical alignment to
 * lines, words, or markdown tokens). The CLI's {@link StdoutStream} adapter
 * writes those deltas directly to `process.stdout`. This module wraps that
 * write path with a small streaming FSM that recognises a CONSERVATIVE subset
 * of markdown (atx headers + triple-backtick code fences + single-line inline
 * code spans) and rewrites them with ANSI escapes for terminal colour.
 *
 * Design constraints (RFC §1.2 default-OFF byte-identical):
 *  - When the painter is OFF (env disabled / NO_COLOR / non-TTY / pipe / OFF
 *    mode), `write(delta)` returns the delta unchanged — the surface skips
 *    constructing a painter in those cases, so the stdout byte stream is
 *    indistinguishable from the pre-feature path.
 *  - The painter is line-buffering: a delta that does not end in `\n` is held
 *    until the next delta completes the line, OR until {@link MarkdownPainter#flush}
 *    is called at turn-end. This is what makes a header token split across two
 *    deltas (`"# "` + `"Title\n"`) paint correctly without false positives on
 *    a `#` that turns out to be part of a sentence.
 *  - Inside an open code fence ALL lines are painted in `dim` regardless of
 *    their content (no header / inline-code recognition inside fences — code
 *    can contain `#` and ``backticks`` legitimately).
 *  - Markdown bold (`**x**`) and italic (`*x*`) are DELIBERATELY not recognised:
 *    they collide with C-style variable names (`*ptr`, `**ptr`) common in LLM
 *    code answers. The `aggressive` mode is reserved for a follow-up PR.
 *
 * State machine
 * ─────────────
 *      ┌──────────────────────────────────────────────────┐
 *      │                                                  │
 *      │  start ──► text ──fence-open──► code-fence ──┐   │
 *      │            │  ▲                  │           │   │
 *      │            │  └────fence-close───┘           │   │
 *      │            │                                 │   │
 *      │            └──flush──► (reset if fence open)─┘   │
 *      │                                                  │
 *      └──────────────────────────────────────────────────┘
 *
 *  - `text` lines that match `^#{1,3} ` are headers (cyan + bold).
 *  - `text` lines that contain a single pair of backticks paint the inner
 *    span with reverse video.
 *  - Bullet-list markers (`- `, `* `, `1. `) at line start are painted dim.
 *  - A line that starts with ` ```lang` opens a fence; ` ``` ` closes it.
 *  - Flush at turn-end: if a fence is still open, emit a closing RESET so a
 *    half-streamed code block does not leave the terminal in dim mode.
 *
 * The FSM is byte-streaming-safe: every `write()` returns exactly the chunk
 * that should be emitted at that moment (possibly empty when buffering a
 * partial line), so the call site can simply pipe `write(delta)` into
 * `process.stdout.write(...)` without coordinating any further state.
 */

import { ColorPolicyResolver } from "@/ui"

/** Public painter handle returned by {@link createMarkdownPainter}. */
export interface MarkdownPainter {
  /** Push a text delta from the assistant stream. Returns the rendered
   *  chunk that should be written to stdout (may include ANSI escapes).
   *  Returns the empty string when the painter is buffering an incomplete
   *  line that hasn't been classified yet. */
  write(delta: string): string
  /** Flush any remaining buffered content at turn-end. Emits the trailing
   *  partial line (if any), then if a code fence is still open emits a
   *  RESET so the terminal does not stay in dim mode. */
  flush(): string
}

export interface MarkdownPainterOptions {
  /** Force colour on/off. When undefined, resolved from the shared
   *  `ColorPolicyResolver` (NO_COLOR / FORCE_COLOR / stdout.isTTY). */
  readonly enabled?: boolean
  /** Recognition mode. `off` ⇒ pass-through (no ANSI). `conservative` ⇒
   *  headers + code fence + inline code + bullet markers. `aggressive` is
   *  reserved for a future PR (bold/italic) — currently equivalent to
   *  conservative so the API surface is stable. */
  readonly mode?: "off" | "conservative" | "aggressive"
}

// ────────────────────────────────────────────────────────────────────────
// ANSI palette
// ────────────────────────────────────────────────────────────────────────

const ESC = "\x1b["
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const REVERSE = `${ESC}7m`
const CYAN = `${ESC}36m`
const MAGENTA = `${ESC}35m`

// ────────────────────────────────────────────────────────────────────────
// Line-level paint helpers (pure)
// ────────────────────────────────────────────────────────────────────────

/** Match an atx header line (`# Title`, `## H2`, `### H3`). Returns the
 *  header level (1..3) and the title body when matched, undefined otherwise.
 *  Deliberately limited to depth 3 — deeper headers are rare in chat output
 *  and the visual budget for distinct colours is small. */
const matchHeader = (line: string): { level: 1 | 2 | 3; body: string } | undefined => {
  // No leading whitespace: a `# ` inside an indented code block is not a
  // header. (And we never enter `paintLine` while inside a fence.)
  const m = /^(#{1,3}) (.+)$/.exec(line)
  if (!m) return undefined
  const level = m[1]?.length as 1 | 2 | 3
  return { level, body: m[2] ?? "" }
}

/** Paint an atx header line with a level-appropriate colour. Level 1 gets
 *  bold cyan, level 2 bold magenta, level 3 bold (no colour) so the eye can
 *  scan the structure without colour fatigue. */
const paintHeader = (level: 1 | 2 | 3, body: string): string => {
  const marker = "#".repeat(level)
  if (level === 1) return `${BOLD}${CYAN}${marker} ${body}${RESET}`
  if (level === 2) return `${BOLD}${MAGENTA}${marker} ${body}${RESET}`
  return `${BOLD}${marker} ${body}${RESET}`
}

/** Match a list marker at line start (`- `, `* `, `1. ` … `999. `). Returns
 *  the marker token (including the trailing space) when matched. Indented
 *  list markers are NOT matched (the FSM uses this only on flush-aligned
 *  whole lines from non-fence state). */
const matchBullet = (line: string): string | undefined => {
  const m = /^(-|\*|\d{1,3}\.) /.exec(line)
  return m ? m[0] : undefined
}

/** Paint a single line's inline single-backtick code spans with REVERSE.
 *  Multiple spans on the same line are all rewritten; an unmatched single
 *  backtick is left as-is. The regex requires non-empty content between the
 *  backticks so a stray pair `` `` `` (double-backtick) is not mis-painted. */
const paintInlineCode = (line: string): string =>
  line.replace(/`([^`\n]+?)`/g, `${REVERSE}$1${RESET}`)

/** Paint a list-marker line: dim the marker, then apply inline-code rules
 *  to the rest. */
const paintBullet = (marker: string, rest: string): string =>
  `${DIM}${marker}${RESET}${paintInlineCode(rest)}`

/** Test whether a line opens or closes a triple-backtick code fence. The
 *  prefix MUST be exactly three backticks (we deliberately don't recognise
 *  4+ backticks because Anthropic / OpenAI both emit 3). Optional language
 *  tag after the backticks. Returns the lang token (possibly empty) when
 *  matched, undefined otherwise. */
const matchFence = (line: string): string | undefined => {
  const m = /^```(\S*)\s*$/.exec(line)
  return m ? (m[1] ?? "") : undefined
}

// ────────────────────────────────────────────────────────────────────────
// Color policy gate
// ────────────────────────────────────────────────────────────────────────

const resolveEnabled = (opts: MarkdownPainterOptions | undefined): boolean => {
  if (opts?.enabled !== undefined) return opts.enabled
  const r = new ColorPolicyResolver()
  return r.resolve() === "on"
}

const resolveMode = (
  opts: MarkdownPainterOptions | undefined,
): "off" | "conservative" | "aggressive" => opts?.mode ?? "conservative"

// ────────────────────────────────────────────────────────────────────────
// Painter factory
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a streaming markdown painter. The returned object owns a small
 * per-stream FSM (one line buffer + one fence-state flag). Call
 * {@link MarkdownPainter#write} for each provider delta and
 * {@link MarkdownPainter#flush} once at turn-end.
 *
 * When colour is OFF (NO_COLOR / non-TTY / explicit `enabled: false` /
 * `mode: "off"`) the painter is a structural no-op: `write` returns the
 * delta verbatim and `flush` returns the empty string. Surfaces that want
 * byte-identical default behaviour should skip constructing the painter
 * altogether in those cases — this fallback exists so a caller that hands
 * the painter a delta in an OFF environment cannot accidentally drop bytes.
 */
export const createMarkdownPainter = (opts?: MarkdownPainterOptions): MarkdownPainter => {
  const enabled = resolveEnabled(opts)
  const mode = resolveMode(opts)

  // OFF — pass-through. We still buffer nothing so a caller that switches the
  // env mid-process gets predictable behaviour (no carry-over state).
  if (!enabled || mode === "off") {
    return {
      write: (delta: string): string => delta,
      flush: (): string => "",
    }
  }

  // FSM state (closure-private).
  let buf = ""
  let inFence = false

  /** Paint a line while inside a code fence. Every line is dim; a line
   *  that matches a closing fence flips the FSM back to text mode. */
  const paintFenceBody = (line: string): string => {
    if (matchFence(line) !== undefined) inFence = false
    return `${DIM}${line}${RESET}`
  }

  /** Paint a text-mode line (outside any fence). Order: fence-open ⇒
   *  header ⇒ bullet ⇒ inline-code (fallback). */
  const paintTextLine = (line: string): string => {
    const open = matchFence(line)
    if (open !== undefined) {
      inFence = true
      const langSuffix = open === "" ? "" : ` ${DIM}(${open})${RESET}`
      return `${DIM}\`\`\`${open}${RESET}${langSuffix}`
    }
    const header = matchHeader(line)
    if (header) return paintHeader(header.level, header.body)
    const bullet = matchBullet(line)
    if (bullet) return paintBullet(bullet, line.slice(bullet.length))
    return paintInlineCode(line)
  }

  /** Paint a complete (newline-terminated stripped) line according to FSM
   *  state. The caller appends the trailing `\n` so this function returns
   *  just the body. Empty lines are returned as-is (no escapes) so the
   *  byte cost of paragraph breaks is zero. */
  const paintLine = (line: string): string => {
    if (line === "") return line
    return inFence ? paintFenceBody(line) : paintTextLine(line)
  }

  const write = (delta: string): string => {
    if (delta === "") return ""
    buf += delta
    // Process every complete line (newline-terminated). A trailing partial
    // line stays in `buf` for the next delta.
    let out = ""
    let nl = buf.indexOf("\n")
    while (nl !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      out += `${paintLine(line)}\n`
      nl = buf.indexOf("\n")
    }
    return out
  }

  const flush = (): string => {
    let out = ""
    // Emit any trailing partial line. We paint it as if it were complete
    // — the next turn restarts with a fresh painter so there is no risk of
    // a header-prefix carry-over breaking the next line.
    if (buf !== "") {
      out += paintLine(buf)
      buf = ""
    }
    // Safety: a fence opened but never closed (the model truncated mid
    // block). Emit a RESET so the terminal does not stay dim.
    if (inFence) {
      out += RESET
      inFence = false
    }
    return out
  }

  return { write, flush }
}

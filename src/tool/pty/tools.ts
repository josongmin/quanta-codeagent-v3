/**
 * N6 — the 6 PTY/tmux attach tools (RFC §5.2). Thin, NO-THROW wrappers over an
 * injected {@link PtySessionPort}. Caller-wired + default-OFF: registered only
 * when the host wires the port behind `QUANTA_PTY_ATTACH`. `pty_list`/`pty_read`
 * are read-only; the four mutating ops are exec-risk (dangerous `pty_write`
 * content flows through the host's existing command HITL).
 */

import { z } from "zod"
import { errMessage, sliceTailWholeChars, sliceWholeChars } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import {
  PTY_MAX_DIM,
  PTY_MAX_WRITE_BYTES,
  PTY_MIN_DIM,
  type PtyResult,
  type PtySessionPort,
} from "./port"

/** Hard cap on a single `pty_read` model-facing payload (a huge scrolled pane
 *  must not explode the transcript). head+tail truncation keeps the most-recent
 *  output (where a prompt / result lives) plus the start for context. */
const PTY_MAX_READ_OUTPUT = 32 * 1024

/**
 * ESCAPE NEUTRALIZATION (H14). `capture-pane -p` returns the pane's RENDERED
 * cells, but a hostile session — one a human/CI started outside quanta, or whose
 * running program emits attacker-controlled bytes — can plant raw ANSI/CSI/OSC
 * escape sequences in that text. If we splice them VERBATIM into the transcript
 * they become a forge channel the same way an un-escaped `<system-reminder>`
 * does in browser/source-tag output:
 *   - a raw ESC (U+001B) + CSI/OSC is interpreted by ANY ANSI-aware downstream
 *     surface (a terminal renderer, a log sink), letting the pane CLEAR the
 *     screen, set the terminal TITLE (`ESC]0;…BEL`), or repaint over earlier
 *     transcript lines to forge a turn/tool boundary;
 *   - C0/C1 controls (`\b`, `\r`, DEL, the 8-bit CSI introducer U+009B) let the
 *     pane visually overwrite preceding text to spoof output it never produced.
 *
 * We DEFANG rather than drop: every dangerous control is rewritten to its
 * VISIBLE caret form (ESC ⇒ `^[`, BEL ⇒ `^G`, …) so the model still SEES the
 * literal sequence (auditable — "the pane tried to set a title") but no raw
 * control byte survives to be re-interpreted as an active escape. Legible pane
 * structure (`\n` line breaks, `\t` columns) is PRESERVED — those are not forge
 * vectors and dropping them would mangle every multi-line capture. Bidi /
 * zero-width forge characters (visual reordering, invisible token-splitters) are
 * stripped, mirroring the log-sanitize discipline in `@/shared/log-sanitize`.
 *
 * Pure + idempotent: a caret form (`^[`) contains no control byte, so a second
 * pass is a no-op. Runs BEFORE `capOutput` so the surrogate-safe truncation only
 * ever measures/cuts an already-neutralized string.
 */
// Bidi controls + zero-width + soft hyphen — stripped outright (no legible
// content, pure forge vectors: visual reordering, invisible token-splitters).
// NOTE: surrogates are handled SEPARATELY (`PTY_LONE_SURROGATE_RE`) so a VALID
// astral pair (emoji, CJK-ext) is NOT torn apart — a per-code-unit class would
// match both halves of a legitimate pair and corrupt it. `new RegExp(string)`
// keeps the control-range literals out of the source (no biome rule trip).
const PTY_BIDI_ZW_RE = new RegExp(
  "[\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
)
// Strip only UNPAIRED surrogates (a high not followed by a low, or a low not
// preceded by a high) — these corrupt UTF-8 at a terminal but carry no content.
// A well-formed PAIR is left intact. `capOutput`'s surrogate-safe slice handles
// pairs straddling a TRUNCATION cut; this handles lone halves already in source.
const PTY_LONE_SURROGATE_RE = new RegExp(
  "[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]",
  "g",
)
// Dangerous C0 (everything U+0000-U+001F EXCEPT TAB U+0009 / LF U+000A, the only
// two legible-structure controls) + DEL U+007F + C1 (U+0080-U+009F — includes the
// 8-bit CSI introducer U+009B and OSC introducer U+009D). ESC (U+001B) is matched
// here, so no raw CSI/OSC opener byte survives. CR U+000D is DELIBERATELY matched
// (defanged to `^M`): a bare/mid-line CR moves the cursor to column 0 and is an
// OVERWRITE-forge control (a pane can repaint a line to spoof output it never
// produced). CRLF endings render as `^M\n` — slightly noisier than a raw `\r` but
// the transcript already line-splits on LF, so no legible structure is lost.
const PTY_CONTROL_RE = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]",
  "g",
)
/** Rewrite one matched control char to its visible caret/hex notation: a C0
 *  char `X` ⇒ `^` + (X XOR 0x40) (so ESC U+001B ⇒ `^[`, BEL U+0007 ⇒ `^G`);
 *  DEL ⇒ `^?`; a C1 char ⇒ `\xHH` (no single-key caret form). */
const caretOf = (ch: string): string => {
  const c = ch.charCodeAt(0)
  if (c === 0x7f) return "^?"
  if (c <= 0x1f) return `^${String.fromCharCode(c ^ 0x40)}`
  return `\\x${c.toString(16).padStart(2, "0")}`
}
/** Defang a hostile pane capture for the transcript: visible-ize every control
 *  escape (no raw ESC/CSI/OSC byte survives) while preserving legible `\n`/`\t`,
 *  and strip bidi/zero-width forge characters. */
const neutralizeCapture = (s: string): string =>
  s
    .replace(PTY_BIDI_ZW_RE, "")
    .replace(PTY_LONE_SURROGATE_RE, "")
    .replace(PTY_CONTROL_RE, caretOf)

/**
 * head+tail truncate to {@link PTY_MAX_READ_OUTPUT}. Surrogate-safe: a JS string
 * is UTF-16, and a naive `slice` at an arbitrary index can cut a surrogate PAIR
 * (an astral char — emoji, CJK-ext, box-drawing in some fonts) in half, emitting
 * a LONE surrogate. That re-encodes to a U+FFFD replacement char (or a malformed
 * token) when the transcript is serialized to the model — a real corruption, not
 * cosmetic. Competitor precedent: Codex decodes child PTY bytes via Rust
 * `String::from_utf8_lossy`, which can never produce a lone surrogate (a Rust
 * `String` is well-formed UTF-8 by construction). We mirror that guarantee via
 * the shared `sliceWholeChars` / `sliceTailWholeChars` helpers, which snap both
 * cut points off a surrogate boundary so the model only ever sees a well-formed
 * string.
 */
const capOutput = (s: string): string => {
  if (s.length <= PTY_MAX_READ_OUTPUT) return s
  const keep = Math.floor(PTY_MAX_READ_OUTPUT / 2)
  const head = sliceWholeChars(s, keep)
  const tail = sliceTailWholeChars(s, keep)
  const dropped = s.length - head.length - tail.length
  return `${head}\n… [${dropped} chars truncated] …\n${tail}`
}

const handleSchema = z.string().min(1).describe("Opaque session handle (tmux:<name> or pty:<seq>)")

const listSchema = z.object({}).describe("Enumerate attachable PTY / tmux session handles")
const attachSchema = z.object({ handle: handleSchema })
const writeSchema = z.object({
  handle: handleSchema,
  data: z.string().describe("Bytes to feed to the session's stdin"),
  appendNewline: z.boolean().optional().describe("Append exactly one newline (submit a line)"),
})
const readSchema = z.object({
  handle: handleSchema,
  sinceSeq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Return output chunks with seq > this (default 0 = from start)"),
})
const resizeSchema = z.object({
  handle: handleSchema,
  cols: z.number().int().min(PTY_MIN_DIM).max(PTY_MAX_DIM),
  rows: z.number().int().min(PTY_MIN_DIM).max(PTY_MAX_DIM),
})
const killSchema = z.object({ handle: handleSchema })

export type PtyAttachInput = z.infer<typeof attachSchema>
export type PtyWriteInput = z.infer<typeof writeSchema>
export type PtyReadInput = z.infer<typeof readSchema>
export type PtyResizeInput = z.infer<typeof resizeSchema>

const fail = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Map a typed `PtyResult` failure to a `ToolResult` failure (rejected/error). */
const failFromPty = (r: Extract<PtyResult<unknown>, { ok: false }>): ToolResult => {
  const mode = r.code === "cap-exceeded" || r.code === "foreign-denied" ? "rejected" : "error"
  return fail(`pty: ${r.code}: ${r.message}`, {
    mode,
    ...(mode === "rejected" ? { reason: r.code } : { modelVisibleError: r.code }),
  } as ToolResult["failure"])
}

const one = (result: ToolResult): AsyncIterable<ToolEvent> => ({
  async *[Symbol.asyncIterator]() {
    yield { type: "result", result }
  },
})

/** NO-THROW boundary (contract §2): run an async producer and map ANY thrown
 *  rejection to a single typed `error` ToolResult, so the port-backed iterators
 *  can never reject the dispatch loop even if a misbehaving backend throws
 *  instead of returning a typed `PtyResult`. */
const fromPort = (produce: () => Promise<ToolResult>): AsyncIterable<ToolEvent> => ({
  async *[Symbol.asyncIterator]() {
    let result: ToolResult
    try {
      result = await produce()
    } catch (e) {
      const msg = errMessage(e)
      result = fail(`pty: backend-error: ${msg}`, { mode: "error", modelVisibleError: msg })
    }
    yield { type: "result", result }
  },
})

/** Parse + abort gate shared by every tool. */
const guard = <S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  ctx: ToolContext,
): { ok: true; data: z.infer<S> } | { ok: false; result: ToolResult } => {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, result: fail(`invalid input: ${parsed.error.message}`) }
  if (ctx.signal.aborted) return { ok: false, result: fail("aborted before start") }
  return { ok: true, data: parsed.data }
}

export const ptyTools = (port: PtySessionPort): Tool[] => {
  const ptyList: Tool<Record<string, never>> = {
    name: "pty_list",
    description:
      "List attachable PTY / named-tmux session handles (handle, kind, cwd, title, owned).",
    inputSchema: listSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute(input, ctx) {
      const g = guard(listSchema, input, ctx)
      if (!g.ok) return one(g.result)
      return fromPort(async () => {
        const infos = await port.list()
        // H14: a session NAME / cwd / title is attacker-controllable (a human/CI
        // names a session, or a process sets its title via `ESC]2;…BEL`). These
        // strings render straight into the transcript, so defang any embedded
        // escape the SAME way `pty_read` defangs pane output — a session named
        // `quanta-\x1b[32mGREEN` must not carry a live escape into the model view.
        const lines =
          infos.length === 0
            ? "(no attachable sessions)"
            : infos
                .map((i) => {
                  const handle = neutralizeCapture(i.handle)
                  const title = i.title ? ` ${neutralizeCapture(i.title)}` : ""
                  const cwd = i.cwd ? ` (${neutralizeCapture(i.cwd)})` : ""
                  return `  ${handle} [${i.kind}${i.owned ? ",owned" : ""}]${title}${cwd}`
                })
                .join("\n")
        return { ok: true, output: `PTY sessions:\n${lines}` }
      })
    },
  }

  const ptyAttach: Tool<PtyAttachInput> = {
    name: "pty_attach",
    description:
      "Attach to a PTY/tmux session by handle (idempotent). Returns the output cursor to read from.",
    inputSchema: attachSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute(input, ctx) {
      const g = guard(attachSchema, input, ctx)
      if (!g.ok) return one(g.result)
      return fromPort(async () => {
        const r = await port.attach(g.data.handle)
        return r.ok
          ? { ok: true, output: `attached ${r.value.handle} (cursor=${r.value.cursor})` }
          : failFromPty(r)
      })
    },
  }

  const ptyWrite: Tool<PtyWriteInput> = {
    name: "pty_write",
    description:
      "Write bytes to an attached session's stdin (live). `appendNewline` submits a line. 64 KiB cap.",
    inputSchema: writeSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    // SECURITY (R5 privilege-boundary): `pty_write` feeds bytes straight into a
    // LIVE shell's stdin — it is a shell-input channel equivalent to `bash`'s
    // `command`. Surfacing `data` here lets the dispatch seam populate
    // `ToolAction.shellCommand`, so the policy's HARD_DENY corpus (rm -rf /,
    // curl|sh, fork-bombs, …) screens the typed bytes through the SAME denylist
    // as `bash` — including in bypass mode, where HARD_DENY still wins. Without
    // this, an attached terminal was a denylist-evading exec channel. The
    // submit newline (`appendNewline`) is irrelevant to the verdict: the payload
    // is what runs.
    extractShellCommand: (input: PtyWriteInput): string => input.data,
    execute(input, ctx) {
      const g = guard(writeSchema, input, ctx)
      if (!g.ok) return one(g.result)
      if (Buffer.byteLength(g.data.data, "utf8") > PTY_MAX_WRITE_BYTES) {
        return one(
          fail(`input exceeds ${PTY_MAX_WRITE_BYTES}-byte write cap`, {
            mode: "rejected",
            reason: "too_large",
          }),
        )
      }
      return fromPort(async () => {
        const r = await port.write(
          g.data.handle,
          g.data.data,
          g.data.appendNewline !== undefined ? { appendNewline: g.data.appendNewline } : {},
        )
        return r.ok ? { ok: true, output: "ok" } : failFromPty(r)
      })
    },
  }

  const ptyRead: Tool<PtyReadInput> = {
    name: "pty_read",
    description:
      "Read new output from an attached session since a cursor (resumable). Returns chunks + the next cursor.",
    inputSchema: readSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute(input, ctx) {
      const g = guard(readSchema, input, ctx)
      if (!g.ok) return one(g.result)
      return fromPort(async () => {
        const r = await port.read(g.data.handle, g.data.sinceSeq ?? 0)
        if (!r.ok) return failFromPty(r)
        // H14: a hostile pane can plant raw ANSI/CSI/OSC escapes in `capture-pane`
        // output. Defang them to visible caret forms BEFORE the surrogate-safe cap
        // so no raw control byte reaches the model-facing transcript (forge guard).
        const body = capOutput(neutralizeCapture(r.value.chunks.map((c) => c.data).join("")))
        return { ok: true, output: `${body}\n[nextSeq=${r.value.nextSeq}]` }
      })
    },
  }

  const ptyResize: Tool<PtyResizeInput> = {
    name: "pty_resize",
    description: "Resize an attached session to (cols, rows). Each bounded 1..1000.",
    inputSchema: resizeSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute(input, ctx) {
      const g = guard(resizeSchema, input, ctx)
      if (!g.ok) return one(g.result)
      return fromPort(async () => {
        const r = await port.resize(g.data.handle, g.data.cols, g.data.rows)
        return r.ok
          ? { ok: true, output: `resized to ${g.data.cols}x${g.data.rows}` }
          : failFromPty(r)
      })
    },
  }

  const ptyKill: Tool<PtyAttachInput> = {
    name: "pty_kill",
    description: "Terminate an attached session (owned PTY or allow-listed tmux only).",
    inputSchema: killSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute(input, ctx) {
      const g = guard(killSchema, input, ctx)
      if (!g.ok) return one(g.result)
      return fromPort(async () => {
        const r = await port.kill(g.data.handle)
        return r.ok ? { ok: true, output: `killed ${g.data.handle}` } : failFromPty(r)
      })
    },
  }

  return [ptyList, ptyAttach, ptyWrite, ptyRead, ptyResize, ptyKill]
}

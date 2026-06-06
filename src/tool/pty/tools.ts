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
        const lines =
          infos.length === 0
            ? "(no attachable sessions)"
            : infos
                .map(
                  (i) =>
                    `  ${i.handle} [${i.kind}${i.owned ? ",owned" : ""}]${i.title ? ` ${i.title}` : ""}${i.cwd ? ` (${i.cwd})` : ""}`,
                )
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
        const body = capOutput(r.value.chunks.map((c) => c.data).join(""))
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

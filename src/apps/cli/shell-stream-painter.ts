import type { ShellExecEvent, ShellExecObserver } from "@/tool"

/**
 * CLI streaming painter for ADR-0081 `ShellExecEvent`s — paints incremental
 * stdout/stderr from long-running shell commands to a writer (typically
 * `process.stderr` so the chunks don't collide with the agent's
 * `process.stdout` final output).
 *
 * Design choices:
 *  - ANSI dim prefix (`\x1b[2m`) frames the `[shell] $ <command>` and
 *    `[shell] exit code=N` boundary lines so the operator can visually
 *    distinguish streamed shell output from the agent's own text deltas
 *    (which are written un-decorated to stdout by the REPL).
 *  - Decodes `Uint8Array` chunks via a stateful `TextDecoder({stream: true})`
 *    so a UTF-8 multibyte sequence split across two chunks reassembles
 *    correctly (the legacy buffered path uses the same default decoder).
 *  - Output preserves embedded newlines exactly — we do NOT add line wrapping
 *    or auto-newlines mid-chunk; what the child wrote is what the operator
 *    sees.
 *  - `start`/`exit`/`aborted` emit single decorated lines with the
 *    command/exit-code so the operator gets boundary visibility for
 *    multi-command turns.
 *
 * Default-OFF posture: this builder allocates one decoder + one closure per
 * agent run; the AgentConfig consumer decides whether to attach it. With no
 * attach, `runShell` skips event allocation entirely (ADR-0081 invariant).
 *
 * Color suppression: when `NO_COLOR` is set (or stderr is not a TTY), ANSI
 * codes are omitted so the output is plain. Respected per https://no-color.org/.
 */
export interface ShellStreamPainterOptions {
  /** Where to write — default `process.stderr.write.bind(process.stderr)`. */
  readonly write?: (s: string) => void
  /** When true, ANSI escapes are emitted; otherwise plain text. Auto-detected
   *  via stderr-TTY + `NO_COLOR` env when not explicitly set. */
  readonly color?: boolean
  /** Optional label injected into the `[shell]` boundary lines, e.g. the
   *  scenario id during a smoke run. Absent ⇒ no label. */
  readonly label?: string
}

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const RED = "\x1b[31m"

const detectColor = (): boolean => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false
  // Only paint when stderr is a TTY — pipes get plain text.
  return Boolean((process.stderr as { isTTY?: boolean }).isTTY)
}

/**
 * Everything one painter instance carries. Bundled so the paint arms can live
 * at MODULE level: in the original they sat inside the returned arrow inside
 * the factory arrow, and that two-deep nesting surcharge — not the arm count —
 * was most of the painter's cognitive-complexity score.
 */
interface PainterCtx {
  readonly write: (s: string) => void
  readonly dim: (s: string) => string
  readonly redDim: (s: string) => string
  readonly labelTag: string
  /** Stateful, one per painter instance: a UTF-8 multibyte sequence split
   *  across chunks only reassembles if the SAME decoder sees both halves. */
  readonly decStdout: TextDecoder
  readonly decStderr: TextDecoder
}

/**
 * Final flush of both decoders. ONE unit because it is the shared tail of the
 * two TERMINAL arms (`exit` and `detached`): an empty `decode()` with
 * `stream: false` emits any trailing partial, and the decoders are not reused
 * afterwards. Spelling it out twice was a duplicated branch tail.
 */
const flushDecoderTails = (c: PainterCtx): void => {
  const tailOut = c.decStdout.decode()
  const tailErr = c.decStderr.decode()
  if (tailOut.length > 0) c.write(tailOut)
  if (tailErr.length > 0) c.write(c.redDim(tailErr))
}

/**
 * The `detached` arm. WS-H / UUX-6-05 — an INTENTIONAL background handoff is
 * NOT an abort: paint it honestly. Terminal-event parity with `exit`: flush any
 * pending partial multibyte tails first (the decoders end here — the registry
 * owns the post-detach stream). Its own unit because it is the only arm with a
 * sub-branch of its own.
 */
const paintDetached = (
  c: PainterCtx,
  event: Extract<ShellExecEvent, { kind: "detached" }>,
): void => {
  flushDecoderTails(c)
  if (event.reason === "consent_timeout") {
    // UUX-6-20 (D-5) — the 60s default stays but is ANNOUNCED explicitly.
    const waited =
      event.consentWaitMs !== undefined ? ` in ${Math.round(event.consentWaitMs / 1000)}s` : ""
    c.write(c.dim(`${c.labelTag}[shell] no answer${waited} — defaulted to background\n`))
    c.write(c.dim(`${c.labelTag}[shell] moved to background (consent timeout)\n`))
    return
  }
  c.write(c.dim(`${c.labelTag}[shell] moved to background\n`))
}

/** Paint ONE event. Exhaustive over {@link ShellExecEvent} — a new variant
 *  becomes a compile error at the `never` assignment per ADR-0081. */
const paintShellEvent = (c: PainterCtx, event: ShellExecEvent): void => {
  switch (event.kind) {
    case "start":
      c.write(c.dim(`${c.labelTag}[shell] $ ${event.command}\n`))
      return
    case "stdout":
      c.write(c.decStdout.decode(event.chunk, { stream: true }))
      return
    case "stderr":
      c.write(c.redDim(c.decStderr.decode(event.chunk, { stream: true })))
      return
    case "exit": {
      flushDecoderTails(c)
      const sig = event.signal !== null ? ` signal=${event.signal}` : ""
      c.write(c.dim(`${c.labelTag}[shell] exit code=${event.code ?? "null"}${sig}\n`))
      return
    }
    case "aborted":
      c.write(c.dim(`${c.labelTag}[shell] aborted (${event.reason})\n`))
      return
    case "detached":
      paintDetached(c, event)
      return
    default: {
      // Exhaustive switch — a new ShellExecEvent variant becomes a compile
      // error at the `never` assignment per ADR-0081. We do NOT `return` the
      // value (biome `useExhaustiveDependencies` style: a void function must
      // not return a value).
      const _exhaustive: never = event
      void _exhaustive
    }
  }
}

/** Build the painter observer. The shared `TextDecoder` per observer
 *  preserves split-multibyte semantics across chunks; one decoder per painter
 *  instance (stateful). Returns a closure satisfying {@link ShellExecObserver}. */
export const buildShellStreamPainter = (
  opts: ShellStreamPainterOptions = {},
): ShellExecObserver => {
  const write = opts.write ?? ((s: string) => process.stderr.write(s))
  const color = opts.color ?? detectColor()
  const ctx: PainterCtx = {
    write,
    dim: (s: string): string => (color ? `${DIM}${s}${RESET}` : s),
    redDim: (s: string): string => (color ? `${RED}${DIM}${s}${RESET}` : s),
    labelTag: opts.label !== undefined ? `[${opts.label}] ` : "",
    // `stream: true` so a UTF-8 multibyte sequence split across chunks decodes
    // correctly on subsequent calls. One decoder per painter instance.
    decStdout: new TextDecoder("utf-8"),
    decStderr: new TextDecoder("utf-8"),
  }
  return (event: ShellExecEvent): void => paintShellEvent(ctx, event)
}

/**
 * #8 last-mile (jun-6) — the CONCURRENT in-turn keystroke SOURCE.
 *
 * The mid-turn-capture SEAM (`MidTurnCaptureHandle.captureLine`,
 * `mid-turn-capture-wire.ts`) and the next-turn DRAIN (the `externalPromptQueue`
 * the turn-boundary race already consumes) both exist and are sealed. The one
 * residual: while a turn is in flight the CLI runs NO stdin reader, so a user
 * "typing while running" (the Codex queued-follow-up pattern) has nowhere to
 * land. This module is that missing SOURCE.
 *
 * `startInTurnLineReader` attaches a `data` accumulator to an INJECTED stdin
 * (closed-port DI — this slice never touches `process.stdin`; the session loop
 * binds the real stream, tests bind a fake) for the lifetime of ONE turn. Every
 * completed line (terminated by CR or LF) is delivered to `onLine`, which the
 * session loop wires to `captureLine(line, currentTurnIndex)`. The returned
 * handle's `dispose()` detaches the listener and restores the prior raw-mode +
 * paused/flowing state EXACTLY — it is called in the turn's `finally` so the
 * reader can never leak into the next turn or into the turn-boundary reader.
 *
 * Lifecycle invariants (the load-bearing ones — a regression here breaks the
 * REPL input loop):
 *   - EXACTLY ONE reader alive per turn: start before `await runOneTurn`, dispose
 *     in `finally`. The turn-boundary reader is active only BETWEEN turns; this
 *     one only DURING a turn — they never overlap.
 *   - RAW-MODE save/restore: on a TTY we record the prior raw flag, set raw, and
 *     restore the prior flag on `dispose()` (every exit path — normal, throw,
 *     abort, SIGINT — because the loop's `finally` always runs it). On a non-TTY
 *     (piped / test) raw-mode is never touched.
 *   - CTRL-C PASSTHROUGH: byte 0x03 is NOT a captured line and is NOT consumed —
 *     the reader leaves the surface's existing SIGINT/abort wiring untouched
 *     (Node still raises SIGINT from the TTY; on a non-TTY there is no SIGINT to
 *     swallow). A pending partial line is dropped on 0x03 (the user cancelled).
 *   - NO CONTENTION with streaming output: the reader is a pure line accumulator;
 *     it writes NOTHING to stdout (no echo, no redraw), so it can never interleave
 *     control chars into the turn's token stream. `onLine` is no-throw-guarded so
 *     a faulting capture sink can never bubble into the in-flight turn.
 *
 * DEFAULT-OFF: the session loop only calls `startInTurnLineReader` when the
 * mid-turn-capture handle is present (knob ON). Knob unset ⇒ no reader is started
 * ⇒ stdin stays detached during the turn, byte-identical to today.
 */

/** Narrow stdin shape the in-turn reader uses. Mirrors `raw-line-reader`'s
 *  `ReaderStdin` so the SAME fake drives both readers' tests. Production passes
 *  `process.stdin`; tests pass a fake that emits `data` chunks directly. NOT a
 *  public contract — purely the closed port for DI. */
export interface InTurnReaderStdin {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown
  resume(): unknown
  pause(): unknown
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  readonly isPaused?: () => boolean
  setRawMode?(mode: boolean): unknown
}

export interface InTurnLineReaderDeps {
  /** Injected stdin source (closed-port DI). The session loop binds
   *  `process.stdin`; tests bind a fake `data`-emitter. */
  readonly stdin: InTurnReaderStdin
  /** Called with each COMPLETED line typed during the turn (CR/LF stripped).
   *  The session loop wires this to `captureLine(line, currentTurnIndex)`. The
   *  reader guards it so a throw can never break the in-flight turn. MAY be
   *  async; the reader does not await it (fire-and-forget, ordered by arrival). */
  readonly onLine: (line: string) => void | Promise<void>
  /** Optional max bytes held in the partial-line accumulator before the partial
   *  is dropped (a paste / runaway producer with no newline must not grow the
   *  buffer unbounded mid-turn). Defaults to 64 KiB. A dropped partial is
   *  silently discarded — only COMPLETED lines reach `onLine`. */
  readonly maxLineBytes?: number
}

/** A live in-turn reader. `dispose()` is idempotent and restores the terminal
 *  to EXACTLY its pre-start state (listener detached, raw-mode + paused flag
 *  restored). The session loop calls it in the turn's `finally`. */
export interface InTurnLineReaderHandle {
  dispose(): void
}

const CR = 0x0d
const LF = 0x0a
const CTRL_C = 0x03
const DEFAULT_MAX_LINE_BYTES = 64 * 1024

/**
 * Start a concurrent line reader on the injected stdin for the lifetime of ONE
 * turn. Returns a handle whose `dispose()` detaches the listener and restores
 * the prior raw-mode + paused state. See the module header for the lifecycle /
 * raw-mode / ctrl-c / no-contention invariants.
 */
export const startInTurnLineReader = (deps: InTurnLineReaderDeps): InTurnLineReaderHandle => {
  const { stdin, onLine } = deps
  const maxLineBytes =
    deps.maxLineBytes !== undefined && deps.maxLineBytes > 0
      ? deps.maxLineBytes
      : DEFAULT_MAX_LINE_BYTES

  const isTty = stdin.isTTY === true
  // Save the prior raw flag so dispose restores EXACTLY what we found. On a
  // non-TTY the flag is meaningless and `setRawMode` is absent — never touched.
  const priorRaw = isTty ? (stdin.isRaw ?? false) : false
  // Save the prior flowing/paused state so dispose restores it. Between turns the
  // stream is `pause()`d by the turn-boundary reader's cleanup; during the turn we
  // resume it to receive keystrokes, then restore the prior state on dispose so the
  // next turn-boundary reader sees the stream exactly as it left it.
  const priorPaused = stdin.isPaused?.() ?? true

  let disposed = false

  // Deliver one completed line to the capture sink. No-throw + non-awaiting: a
  // faulting / rejecting sink must never break the in-flight turn that produced
  // the keystroke (the sacred invariant).
  const emitLine = (line: string): void => {
    try {
      const r = onLine(line)
      if (r !== undefined && typeof (r as Promise<void>).catch === "function") {
        void (r as Promise<void>).catch(() => undefined)
      }
    } catch {
      /* capture sink threw — swallow; the in-flight turn is sacred */
    }
  }

  // Partial-line accumulator. Buffers a STRING (utf8-decoded per chunk); a CR/LF
  // terminates a line, a CTRL-C drops the partial (interrupt), and a line that
  // grows past `maxLineBytes` is marked `overflowed` so its REST (to the next
  // terminator) is discarded — a runaway / newline-less paste must never be
  // emitted as a truncated line nor grow the buffer unbounded.
  const acc = {
    partial: "",
    bytes: 0,
    overflowed: false,
    reset(): void {
      this.partial = ""
      this.bytes = 0
      this.overflowed = false
    },
    /** Handle a CR/LF: emit the accumulated line (unless overflowed / empty),
     *  then reset. CRLF yields one real line + one empty line; the empty one is
     *  skipped so a Windows terminator does not enqueue a blank capture. */
    terminate(): void {
      const { partial, overflowed } = this
      this.reset()
      if (overflowed || partial.length === 0) return
      emitLine(partial)
    },
    /** Handle an ordinary char: accumulate, bounding the partial. Once a line
     *  has overflowed, swallow its remaining chars until the next terminator. */
    push(ch: string): void {
      if (this.overflowed) return
      this.partial += ch
      this.bytes += 1
      if (this.bytes > maxLineBytes) {
        this.partial = ""
        this.bytes = 0
        this.overflowed = true
      }
    },
  }

  const onData = (chunk: Buffer | string): void => {
    if (disposed) return
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    // Walk the chunk char-by-char so a CTRL-C byte (0x03) is intercepted as an
    // interrupt and CR/LF terminate the current line. We never consume the SIGINT
    // signal — on a TTY Node raises SIGINT from the kernel line discipline; raw
    // mode only changes WHO sees the 0x03, not whether the surface's abort wiring
    // (installTurnCancel / outerAbort) runs. Everything else accumulates.
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      if (code === CTRL_C) acc.reset()
      else if (code === CR || code === LF) acc.terminate()
      else acc.push(text[i] ?? "")
    }
  }

  // Enter raw mode (TTY only) so keystrokes arrive byte-wise WITHOUT the kernel
  // line discipline buffering a whole line until Enter — that is what makes the
  // reader "concurrent" (each key is seen as it is typed). On a non-TTY the
  // stream is already line-buffered; we just attach the accumulator.
  if (isTty) stdin.setRawMode?.(true)
  stdin.on("data", onData)
  stdin.resume()

  return {
    dispose: (): void => {
      if (disposed) return
      disposed = true
      stdin.removeListener("data", onData)
      // Restore raw-mode FIRST (TTY only) so the terminal is back to its prior
      // discipline before we restore the flow state — every exit path (normal /
      // throw / abort / SIGINT) reaches here via the loop's finally.
      if (isTty) stdin.setRawMode?.(priorRaw)
      // Restore the prior flowing/paused state: if the stream was paused before
      // we resumed it (the between-turns default), pause it again so the next
      // turn-boundary reader starts from the same state it always has.
      if (priorPaused) stdin.pause()
    },
  }
}

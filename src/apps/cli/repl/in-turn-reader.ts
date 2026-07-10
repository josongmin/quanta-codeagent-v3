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

import { StringDecoder } from "node:string_decoder"

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
  /** §11.5 ticket-08b — OPTIONAL per-keystroke hook with the CURRENT partial-line
   *  buffer (after each chunk: every char / backspace / terminator). The session
   *  loop wires this (TTY only) to redraw the bottom input lane via
   *  {@link renderInputLane}; after a terminator/CTRL-C it fires with `""` so the
   *  lane clears. Absent ⇒ no render (byte-identical: the reader writes nothing). */
  readonly onPartial?: (buffer: string) => void
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
const BACKSPACE = 0x08 // ^H
const TAB = 0x09 // text, not a chord — preserved in captured lines
const ESC = 0x1b
const DELETE = 0x7f // DEL (most terminals send this for Backspace)
const DEFAULT_MAX_LINE_BYTES = 64 * 1024

/** WS-B (jul-10, UUX-3-04) — escape-sequence swallow state. While a turn
 *  streams, the Esc-Esc cancel FSM and this reader BOTH see every byte; the
 *  FSM consumes the chord semantically but the raw bytes used to accumulate
 *  into the captured line (`"fix it\x1b\x1b"` follow-ups, `\x1b[A` arrow-key
 *  garbage). A captured line is TEXT the operator typed — the reader owns
 *  that contract, so escape SEQUENCES are swallowed whole, across chunk
 *  boundaries: CSI (`\x1b[` params… final byte 0x40–0x7e), SS3 (`\x1bO` + one
 *  byte), and lone-Esc/Alt-chords (`\x1b` + one byte). */
type EscSwallowState = "none" | "esc" | "csi" | "ss3" | "str" | "str-esc"

/**
 * The escape-filtering partial-line accumulator (god-fn split, audit W4-R2).
 * Owns the WS-B contract in one place: CR/LF terminate, ^C drops the partial,
 * BS/DEL edit (surrogate-aware), escape SEQUENCES (CSI/SS3/OSC/DCS/PM/APC,
 * lone-Esc/Alt-chords) are swallowed whole across chunk boundaries, other C0
 * chords drop (TAB excepted), and an over-cap partial overflows silently.
 * Module-scope factory so `startInTurnLineReader` stays under the fn-line cap.
 */
const createEscapeFilteringAccumulator = (
  maxLineBytes: number,
  emitLine: (line: string) => void,
): { feed: (text: string) => void; partial: () => string } => {
  // Buffers a STRING (utf8-decoded per chunk); a CR/LF
  // terminates a line, a CTRL-C drops the partial (interrupt), and a line that
  // grows past `maxLineBytes` is marked `overflowed` so its REST (to the next
  // terminator) is discarded — a runaway / newline-less paste must never be
  // emitted as a truncated line nor grow the buffer unbounded.
  const acc = {
    partial: "",
    bytes: 0,
    overflowed: false,
    esc: "none" as EscSwallowState,
    reset(): void {
      this.partial = ""
      this.bytes = 0
      this.overflowed = false
      this.esc = "none"
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
    /** §08b — Backspace/DEL edits the buffer (was previously accumulated as a
     *  raw control char, corrupting the captured line). No-op on an empty or
     *  overflowed partial. */
    backspace(): void {
      if (this.overflowed || this.partial.length === 0) return
      // Audit R1 #1 — surrogate-aware: a Backspace must delete a whole code point,
      // not a lone UTF-16 unit (else an emoji/astral char leaves a broken half-
      // surrogate in the captured line). Drop 2 units when the tail is a low
      // surrogate preceded by a high surrogate.
      const last = this.partial.charCodeAt(this.partial.length - 1)
      const prev = this.partial.length >= 2 ? this.partial.charCodeAt(this.partial.length - 2) : 0
      const isPair = last >= 0xdc00 && last <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff
      const drop = isPair ? 2 : 1
      this.partial = this.partial.slice(0, -drop)
      this.bytes = Math.max(0, this.bytes - drop)
    },
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

  const feed = (text: string): void => {
    // Walk the chunk char-by-char so a CTRL-C byte (0x03) is intercepted as an
    // interrupt and CR/LF terminate the current line. We never consume the SIGINT
    // signal — on a TTY Node raises SIGINT from the kernel line discipline; raw
    // mode only changes WHO sees the 0x03, not whether the surface's abort wiring
    // (installTurnCancel / outerAbort) runs. Everything else accumulates.
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      // WS-B (UUX-3-04) — terminators/interrupt WIN over an in-flight escape
      // swallow (never eat a newline), everything else inside a sequence is
      // consumed until its final byte. State persists across chunks.
      if (code === CTRL_C) {
        acc.reset()
        continue
      }
      if (code === CR || code === LF) {
        acc.esc = "none"
        acc.terminate()
        continue
      }
      if (acc.esc === "str") {
        // OSC/DCS/PM/APC string payload — swallowed until BEL (OSC) or ST
        // (\x1b\\). Audit W3-B1: pasted terminal output carrying OSC-8
        // hyperlinks / title writes must never leak payload as text.
        if (code === 0x07) acc.esc = "none"
        else if (code === ESC) acc.esc = "str-esc"
        continue
      }
      if (acc.esc === "str-esc") {
        acc.esc = text[i] === "\\" ? "none" : code === ESC ? "str-esc" : "str"
        continue
      }
      if (acc.esc === "csi") {
        if (code >= 0x40 && code <= 0x7e) acc.esc = "none" // final byte ends CSI
        continue
      }
      if (acc.esc === "ss3") {
        acc.esc = "none" // SS3 carries exactly one byte after \x1bO
        continue
      }
      if (acc.esc === "esc") {
        // \x1b\x1b — the Esc-Esc chord is COMPLETE (cancel FSM pairs them);
        // the next byte is ordinary text again.
        if (code === ESC) {
          acc.esc = "none"
          continue
        }
        const introducer = text[i]
        acc.esc =
          introducer === "["
            ? "csi"
            : introducer === "O"
              ? "ss3"
              : introducer === "]" || introducer === "P" || introducer === "^" || introducer === "_"
                ? "str"
                : "none"
        continue // the byte after Esc is part of the chord (Alt+x etc.), never text
      }
      if (code === ESC) {
        acc.esc = "esc"
        continue
      }
      if (code === BACKSPACE || code === DELETE) {
        acc.backspace()
        continue
      }
      // Remaining C0 bytes are chords (^A/^E/^K…), not text — TAB excepted.
      if (code < 0x20 && code !== TAB) continue
      acc.push(text[i] ?? "")
    }
  }

  return { feed, partial: () => acc.partial }
}

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
  const utf8 = new StringDecoder("utf8")
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

  const acc = createEscapeFilteringAccumulator(maxLineBytes, emitLine)

  const onData = (chunk: Buffer | string): void => {
    if (disposed) return
    // Audit W3-B2 — a multibyte char split across chunk boundaries must decode
    // whole; per-chunk toString() emitted U+FFFD halves.
    const text = typeof chunk === "string" ? chunk : utf8.write(chunk)
    // The escape-filtering walk lives in the module-scope accumulator (WS-B
    // contract; see createEscapeFilteringAccumulator). We never consume the
    // SIGINT signal — raw mode only changes WHO sees the 0x03.
    acc.feed(text)
    // §08b — surface the live buffer for the bottom input-lane redraw (or `""`
    // after a terminator/CTRL-C ⇒ clear the lane). No-throw: a faulting render
    // sink must never break the in-flight turn. Audit R1 #3 — skip empty chunks
    // (0 bytes processed ⇒ nothing changed ⇒ no spurious lane redraw/flicker).
    if (deps.onPartial !== undefined && text.length > 0) {
      try {
        deps.onPartial(acc.partial())
      } catch {
        /* render sink threw — swallow; the in-flight turn is sacred */
      }
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

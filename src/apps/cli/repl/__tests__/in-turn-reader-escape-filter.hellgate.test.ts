/**
 * ★ HELLGATE — WS-B (jul-10 uiux structural, UUX-3-04): a captured mid-turn
 *   line contains TEXT the operator typed — never control chords.
 *
 * Pinned bug: while a turn streams, BOTH the Esc-Esc cancel FSM (keypress
 * listener) and the in-turn reader (raw `data` accumulator) receive every
 * byte. The FSM consumed Esc-Esc as a cancel, but the SAME two `\x1b` bytes
 * were accumulated into the reader's partial-line buffer — so the queued
 * follow-up became `"fix it\x1b\x1b"`, and an arrow-key press mid-turn leaked
 * `\x1b[A` garbage into the captured text.
 *
 * Contract under test (the reader OWNS "what is a captured line"):
 *   - `\x1b` swallows its WHOLE escape sequence (CSI `\x1b[…final`, SS3
 *     `\x1bO+1`, lone Esc), even when the sequence is SPLIT across chunks.
 *   - C0 control bytes that are chords (not text) are dropped; TAB is text.
 *   - Existing semantics (CR/LF terminate, ^C drops partial, BS edits) hold.
 */
import { describe, expect, test } from "bun:test"
import { type InTurnReaderStdin, startInTurnLineReader } from "@/apps/cli/repl/in-turn-reader"

const makeFake = (): InTurnReaderStdin & {
  emit: (s: string) => void
  emitBuf: (b: Buffer) => void
} => {
  const listeners: Array<(chunk: Buffer | string) => void> = []
  return {
    isTTY: false,
    on: (_e, l) => listeners.push(l),
    removeListener: (_e, l) => {
      const i = listeners.indexOf(l)
      if (i !== -1) listeners.splice(i, 1)
    },
    resume: () => undefined,
    pause: () => undefined,
    emit: (s: string) => {
      for (const l of [...listeners]) l(s)
    },
    emitBuf: (b: Buffer) => {
      for (const l of [...listeners]) l(b)
    },
  }
}

const capture = (chunks: string[]): string[] => {
  const lines: string[] = []
  const stdin = makeFake()
  const handle = startInTurnLineReader({ stdin, onLine: (l) => void lines.push(l) })
  for (const c of chunks) stdin.emit(c)
  handle.dispose()
  return lines
}

describe("HELLGATE WS-B — escape/chord bytes never enter a captured line", () => {
  test("Esc-Esc cancel chord typed mid-line does not corrupt the follow-up", () => {
    expect(capture(["fix it\x1b\x1b\n"])).toEqual(["fix it"])
  })

  test("lone Esc + Enter delivers NO line (nothing typed)", () => {
    expect(capture(["\x1b\n"])).toEqual([])
  })

  test("arrow-key CSI sequence is swallowed whole", () => {
    expect(capture(["\x1b[Aabc\n"])).toEqual(["abc"])
    expect(capture(["abc\x1b[3~def\n"])).toEqual(["abcdef"]) // Del key CSI with param
  })

  test("SS3 function-key sequence (\\x1bOP) is swallowed whole", () => {
    expect(capture(["\x1bOPhello\n"])).toEqual(["hello"])
  })

  test("escape sequence SPLIT across chunks is still swallowed", () => {
    expect(capture(["ab\x1b", "[A", "cd\n"])).toEqual(["abcd"])
    expect(capture(["x\x1b", "\x1by\n"])).toEqual(["xy"]) // two lone Escs across chunks
  })

  test("C0 chord bytes (^A/^E/^K…) are dropped; TAB is kept as text", () => {
    expect(capture(["\x01hello\x0b\n"])).toEqual(["hello"])
    expect(capture(["a\tb\n"])).toEqual(["a\tb"])
  })

  // Audit W3-B1 — OSC/DCS/PM/APC are string-payload sequences terminated by
  // ST (\x1b\\) or BEL (OSC): pasted terminal output carrying OSC-8 hyperlinks
  // or title writes must not leak payload into the captured line.
  test("OSC payload (BEL-terminated) is swallowed whole", () => {
    expect(capture(["\x1b]0;my title\x07hello\n"])).toEqual(["hello"])
  })

  test("OSC payload (ST-terminated) is swallowed whole", () => {
    expect(capture(["\x1b]11;rgb:1e1e/2a2a/3b3b\x1b\\hi\n"])).toEqual(["hi"])
  })

  test("DCS payload is swallowed whole (ST-terminated)", () => {
    expect(capture(["\x1bP1$r0m\x1b\\ok\n"])).toEqual(["ok"])
  })

  test("OSC split across chunks is still swallowed", () => {
    expect(capture(["a\x1b]8;;https://x", ".dev\x07b\n"])).toEqual(["ab"])
  })

  // Audit W3-B2 — multibyte text split across chunk boundaries must decode
  // whole (StringDecoder), never as U+FFFD halves.
  test("multibyte char split across chunks survives intact", () => {
    const bytes = Buffer.from("한글ok\n", "utf8")
    const lines: string[] = []
    const stdin = makeFake()
    const handle = startInTurnLineReader({ stdin, onLine: (l) => void lines.push(l) })
    stdin.emitBuf(bytes.subarray(0, 2)) // mid-char split
    stdin.emitBuf(bytes.subarray(2))
    handle.dispose()
    expect(lines).toEqual(["한글ok"])
  })

  test("paired control: plain text, backspace edit and ^C drop still behave", () => {
    expect(capture(["hello\n"])).toEqual(["hello"])
    expect(capture(["heX\x7fllo\n"])).toEqual(["hello".replace("X", "")])
    expect(capture(["dropme\x03kept\n"])).toEqual(["kept"])
  })
})

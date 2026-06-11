/**
 * HELLGATE — #10 (jun-11) bracketed-paste mode.
 *
 * The bug: a multi-line clipboard paste arrives with its line breaks as `\r`
 * keypresses (`name:"return"`), which the reader treats as Enter and SUBMITS at
 * the FIRST newline — the rest of the paste is lost. The fix enables DECSET 2004
 * (`?2004h`) so the terminal wraps a paste in `ESC[200~ … ESC[201~`; Bun's
 * `node:readline` surfaces those as `paste-start`/`paste-end` keypresses, between
 * which EVERY keystroke (including the embedded `\r`/`\n`) is accumulated into one
 * buffer that submits only on a GENUINE Enter outside the paste.
 *
 * Invariants under adversarial drive (paired ON vs OFF = causal delta):
 *   - ON: a bracketed multi-line paste does NOT submit; the full text (newlines
 *     preserved) lands in `buf` and submits on the next real Enter.
 *   - OFF (`bracketedPaste` absent): the SAME `\r` early-submits at the first
 *     newline — the legacy behavior, byte-identical to today's build.
 *   - CRLF (`\r\n`) collapses to a single `\n`.
 *   - The multi-line echo collapses to `[Pasted Content N chars]` (a raw `\n` in
 *     the single-row composer band would corrupt the redraw).
 *   - DECSET `?2004h` is emitted on entry over a TTY and `?2004l` on exit; the
 *     OFF build emits NEITHER (byte-identical).
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { pasteBurstPlaceholder, type ReadLineTestIO, readLine } from "../raw-line-reader"

interface KeyEvent {
  name?: string
  ctrl?: boolean
  sequence?: string
}

const ESC = "\x1b["

/** Fake stdin whose keypress shapes mirror the probe-verified events Bun's
 *  `node:readline` emits for the DECSET 2004 markers and inner chars. `isTTY`
 *  is configurable so the DECSET-emit test can exercise the TTY guard. */
class FakeStdin extends EventEmitter {
  isTTY: boolean
  isRaw = false
  constructor(isTTY = false) {
    super()
    this.isTTY = isTTY
  }
  setRawMode(mode: boolean): void {
    this.isRaw = mode
  }
  resume(): void {}
  pause(): void {}
  key(str: string | undefined, key: KeyEvent = {}): void {
    this.emit("keypress", str, key)
  }
  pasteStart(): void {
    this.key(undefined, { name: "paste-start", sequence: `${ESC}200~` })
  }
  pasteEnd(): void {
    this.key(undefined, { name: "paste-end", sequence: `${ESC}201~` })
  }
  /** A printable char inside (or outside) a paste. */
  type(ch: string): void {
    this.key(ch, { name: ch, sequence: ch })
  }
  /** A line break delivered as CR (`name:"return"`) — what a terminal sends for
   *  a pasted newline AND for a genuine Enter. */
  retn(): void {
    this.key("\r", { name: "return" })
  }
  /** A line break delivered as LF (`name:"enter"`) — the trailing half of CRLF. */
  enter(): void {
    this.key("\n", { name: "enter" })
  }
  /** Move the cursor to the line start (Home). */
  home(): void {
    this.key(undefined, { name: "home" })
  }
  /** Drive a full bracketed paste of `text`, translating `\n` to a CR keypress. */
  bracketedPaste(text: string): void {
    this.pasteStart()
    for (const ch of text) {
      if (ch === "\n") this.retn()
      else this.type(ch)
    }
    this.pasteEnd()
  }
}

class FakeStdout {
  chunks: string[] = []
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
  get bytes(): string {
    return this.chunks.join("")
  }
}

const makeIO = (isTTY = false): { io: ReadLineTestIO; stdin: FakeStdin; stdout: FakeStdout } => {
  const stdin = new FakeStdin(isTTY)
  const stdout = new FakeStdout()
  return {
    io: {
      stdin: stdin as unknown as ReadLineTestIO["stdin"],
      stdout,
      skipKeypressSetup: true,
    },
    stdin,
    stdout,
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("#10 bracketed-paste — multi-line paste no longer early-submits", () => {
  test("ON: a bracketed paste with an embedded newline holds the FULL text, submits on real Enter", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    stdin.bracketedPaste("line1\nline2") // \n delivered as a CR keypress
    await flush()
    // The paste did NOT submit at the embedded newline — the promise is still
    // pending. A GENUINE Enter outside the paste submits the accumulated buffer.
    stdin.retn()
    const result = await p
    expect(result).toBe("line1\nline2")
  })

  test("OFF (paired control): the SAME embedded newline early-submits at the first line (legacy)", async () => {
    const { io, stdin } = makeIO()
    // No `bracketedPaste` ⇒ the markers are inert and the inner CR is Enter.
    const p = readLine({ prompt: "› " }, io)
    stdin.bracketedPaste("line1\nline2")
    const result = await p
    // Legacy behavior: submits at the first `\r`, dropping the rest. This is the
    // delta the fix removes — ON returns the whole text, OFF returns just "line1".
    expect(result).toBe("line1")
  })

  test("ON: CRLF (\\r\\n) inside a paste collapses to a single \\n", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    stdin.pasteStart()
    stdin.type("a")
    stdin.retn() // \r
    stdin.enter() // \n  → trailing half of CRLF, dropped
    stdin.type("b")
    stdin.pasteEnd()
    await flush()
    stdin.retn() // genuine Enter
    expect(await p).toBe("a\nb")
  })

  test("ON: a single genuine Enter (no paste-start) still submits immediately", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    stdin.type("h")
    stdin.type("i")
    await flush()
    stdin.retn() // genuine Enter, OUTSIDE any paste
    expect(await p).toBe("hi")
  })

  test("ON: a paste appended to already-typed text splices at the cursor (anchor)", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    stdin.type("x")
    stdin.type("y")
    await flush()
    stdin.bracketedPaste("AB\nCD")
    await flush()
    stdin.retn()
    expect(await p).toBe("xyAB\nCD")
  })

  test("ON: a paste splices at the CURSOR, not the buffer end (anchor is honored)", async () => {
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    stdin.type("X")
    stdin.type("Y")
    stdin.home() // cursor → 0 (NOT at the end)
    await flush()
    stdin.bracketedPaste("AB") // must land at index 0 → "ABXY", never "XYAB"
    await flush()
    stdin.retn()
    expect(await p).toBe("ABXY")
  })
})

describe("#10 bracketed-paste — multi-line echo collapses to a placeholder", () => {
  test("ON: a multi-line paste echoes `[Pasted Content N chars]`, never a raw newline in the band", async () => {
    const { io, stdin, stdout } = makeIO()
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    stdin.bracketedPaste("alpha\nbeta\ngamma") // 16 code points incl. 2 \n
    await flush()
    stdin.retn()
    const result = await p
    // Submission carries the FULL multi-line text…
    expect(result).toBe("alpha\nbeta\ngamma")
    // …but the rendered echo collapsed to the placeholder (count = code points).
    expect(stdout.bytes).toContain(pasteBurstPlaceholder([..."alpha\nbeta\ngamma"].length))
  })

  test("ON: a short single-line paste inserts RAW (no placeholder)", async () => {
    const { io, stdin, stdout } = makeIO()
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    stdin.bracketedPaste("hello") // single line, short
    await flush()
    stdin.retn()
    expect(await p).toBe("hello")
    expect(stdout.bytes).not.toContain("Pasted Content")
    expect(stdout.bytes).toContain("hello")
  })
})

describe("#10 bracketed-paste — DECSET 2004 enable/disable (TTY only)", () => {
  test("ON over a TTY: `?2004h` on entry, `?2004l` on exit", async () => {
    const { io, stdin, stdout } = makeIO(true) // isTTY = true
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    // Enable must have been written before any keypress.
    expect(stdout.bytes).toContain(`${ESC}?2004h`)
    stdin.type("q")
    stdin.retn()
    await p
    // Disable written on cleanup so the host terminal isn't left latched.
    expect(stdout.bytes).toContain(`${ESC}?2004l`)
  })

  test("OFF over a TTY (paired control): NEITHER DECSET sequence is emitted (byte-identical)", async () => {
    const { io, stdin, stdout } = makeIO(true)
    const p = readLine({ prompt: "› " }, io)
    stdin.type("q")
    stdin.retn()
    await p
    expect(stdout.bytes).not.toContain(`${ESC}?2004h`)
    expect(stdout.bytes).not.toContain(`${ESC}?2004l`)
  })

  test("ON over a non-TTY: no DECSET bytes (guarded on isTTY)", async () => {
    const { io, stdin, stdout } = makeIO(false)
    const p = readLine({ prompt: "› ", bracketedPaste: true }, io)
    stdin.type("q")
    stdin.retn()
    await p
    expect(stdout.bytes).not.toContain("?2004")
  })
})

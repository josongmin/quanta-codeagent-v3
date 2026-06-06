/**
 * #8 last-mile (jun-6) — in-turn keystroke SOURCE hellgate.
 *
 * Seals `startInTurnLineReader` (`@/apps/cli/repl/in-turn-reader`) — the
 * concurrent reader that feeds the mid-turn-capture seam while a turn runs.
 * Driven by a FAKE stdin (no real TTY): a `data`-emitter with a settable raw
 * flag + pause/resume tracking, mirroring the surface's `process.stdin`.
 *
 *   A. one completed line ⇒ onLine(line).
 *   B. multiple lines ⇒ all captured IN ORDER.
 *   C. dispose ⇒ listener detached (no leak), no further lines captured.
 *   D. TTY: raw-mode is entered on start, RESTORED to the prior flag on dispose.
 *   E. CTRL-C (0x03) ⇒ NOT a captured line; a partial before it is dropped; the
 *      'data' listener is NOT removed by the reader (abort is the surface's job).
 *   F. non-TTY (piped/test): raw-mode is NEVER touched.
 *   G. pause/resume: the reader resumes the stream on start and restores the
 *      prior paused state on dispose (no flow leak into the boundary reader).
 *   H. a throwing onLine sink does NOT escape (the in-flight turn is sacred).
 *   I. CRLF terminator ⇒ ONE line, not a spurious trailing blank.
 *   J. oversize newline-less partial is dropped (no unbounded growth); a later
 *      completed line still lands.
 */

import { describe, expect, test } from "bun:test"
import { type InTurnReaderStdin, startInTurnLineReader } from "@/apps/cli/repl/in-turn-reader"

interface FakeStdin extends InTurnReaderStdin {
  emit(chunk: string): void
  listenerCount(): number
  rawCalls: boolean[]
  resumeCalls: number
  pauseCalls: number
  paused: boolean
}

const makeFakeStdin = (opts: {
  isTTY: boolean
  initialRaw?: boolean
  initialPaused?: boolean
}): FakeStdin => {
  const listeners: Array<(chunk: Buffer | string) => void> = []
  const rawCalls: boolean[] = []
  let isRaw = opts.initialRaw ?? false
  let paused = opts.initialPaused ?? true
  const fake: FakeStdin = {
    isTTY: opts.isTTY,
    get isRaw() {
      return isRaw
    },
    rawCalls,
    resumeCalls: 0,
    pauseCalls: 0,
    get paused() {
      return paused
    },
    isPaused: () => paused,
    setRawMode: (mode: boolean) => {
      isRaw = mode
      rawCalls.push(mode)
      return fake
    },
    on: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      listeners.push(listener)
      return fake
    },
    removeListener: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      const idx = listeners.indexOf(listener)
      if (idx >= 0) listeners.splice(idx, 1)
      return fake
    },
    resume: () => {
      paused = false
      fake.resumeCalls += 1
      return fake
    },
    pause: () => {
      paused = true
      fake.pauseCalls += 1
      return fake
    },
    emit: (chunk: string) => {
      for (const l of [...listeners]) l(chunk)
    },
    listenerCount: () => listeners.length,
  }
  return fake
}

describe("startInTurnLineReader — #8 concurrent in-turn SOURCE", () => {
  test("A. one completed line ⇒ onLine called with that line", () => {
    const stdin = makeFakeStdin({ isTTY: false })
    const lines: string[] = []
    const reader = startInTurnLineReader({ stdin, onLine: (l) => void lines.push(l) })
    stdin.emit("clean up tmp files\n")
    reader.dispose()
    expect(lines).toEqual(["clean up tmp files"])
  })

  test("B. multiple lines during one turn ⇒ all captured in order", () => {
    const stdin = makeFakeStdin({ isTTY: false })
    const lines: string[] = []
    const reader = startInTurnLineReader({ stdin, onLine: (l) => void lines.push(l) })
    stdin.emit("first\n")
    stdin.emit("second\nthird\n")
    reader.dispose()
    expect(lines).toEqual(["first", "second", "third"])
  })

  test("C. dispose ⇒ listener detached (no leak); later data is NOT captured", () => {
    const stdin = makeFakeStdin({ isTTY: false })
    const lines: string[] = []
    const reader = startInTurnLineReader({ stdin, onLine: (l) => void lines.push(l) })
    expect(stdin.listenerCount()).toBe(1)
    stdin.emit("kept\n")
    reader.dispose()
    expect(stdin.listenerCount()).toBe(0)
    stdin.emit("dropped\n")
    expect(lines).toEqual(["kept"])
  })

  test("C2. dispose is idempotent", () => {
    const stdin = makeFakeStdin({ isTTY: false })
    const reader = startInTurnLineReader({ stdin, onLine: () => undefined })
    reader.dispose()
    reader.dispose()
    expect(stdin.listenerCount()).toBe(0)
  })

  test("D. TTY ⇒ raw-mode entered on start, restored to prior flag on dispose", () => {
    const stdin = makeFakeStdin({ isTTY: true, initialRaw: false })
    const reader = startInTurnLineReader({ stdin, onLine: () => undefined })
    // Entered raw mode on start.
    expect(stdin.rawCalls).toEqual([true])
    expect(stdin.isRaw).toBe(true)
    reader.dispose()
    // Restored to the PRIOR flag (false) on dispose.
    expect(stdin.rawCalls).toEqual([true, false])
    expect(stdin.isRaw).toBe(false)
  })

  test("D2. TTY already in raw mode ⇒ dispose restores raw=true (no clobber)", () => {
    const stdin = makeFakeStdin({ isTTY: true, initialRaw: true })
    const reader = startInTurnLineReader({ stdin, onLine: () => undefined })
    reader.dispose()
    // Last restore is the prior flag = true.
    expect(stdin.rawCalls.at(-1)).toBe(true)
    expect(stdin.isRaw).toBe(true)
  })

  test("E. Ctrl-C (0x03) ⇒ NOT a captured line; partial dropped; abort path untouched", () => {
    const stdin = makeFakeStdin({ isTTY: true, initialRaw: false })
    const lines: string[] = []
    const reader = startInTurnLineReader({ stdin, onLine: (l) => void lines.push(l) })
    // A half-typed line, then Ctrl-C: the partial is dropped, nothing captured,
    // and the reader does NOT detach its listener (the surface owns abort).
    stdin.emit("half typed")
    stdin.emit("\x03")
    expect(lines).toEqual([])
    expect(stdin.listenerCount()).toBe(1) // reader still attached; abort is the surface's job
    // A fresh line after the interrupt still works (reader survives 0x03).
    stdin.emit("after ctrl-c\n")
    expect(lines).toEqual(["after ctrl-c"])
    reader.dispose()
  })

  test("F. non-TTY ⇒ raw-mode is NEVER touched", () => {
    const stdin = makeFakeStdin({ isTTY: false, initialRaw: false })
    const reader = startInTurnLineReader({ stdin, onLine: () => undefined })
    stdin.emit("x\n")
    reader.dispose()
    expect(stdin.rawCalls).toEqual([])
  })

  test("G. pause/resume ⇒ resumed on start, prior paused state restored on dispose", () => {
    const stdin = makeFakeStdin({ isTTY: false, initialPaused: true })
    const reader = startInTurnLineReader({ stdin, onLine: () => undefined })
    // Resumed so keystrokes flow during the turn.
    expect(stdin.resumeCalls).toBe(1)
    expect(stdin.paused).toBe(false)
    reader.dispose()
    // Prior state was paused ⇒ re-paused on dispose (no flow leak into the
    // turn-boundary reader).
    expect(stdin.pauseCalls).toBe(1)
    expect(stdin.paused).toBe(true)
  })

  test("G2. stream NOT paused before start ⇒ dispose does not pause it", () => {
    const stdin = makeFakeStdin({ isTTY: false, initialPaused: false })
    const reader = startInTurnLineReader({ stdin, onLine: () => undefined })
    reader.dispose()
    expect(stdin.pauseCalls).toBe(0)
  })

  test("H. a throwing onLine sink does NOT escape (in-flight turn is sacred)", () => {
    const stdin = makeFakeStdin({ isTTY: false })
    const reader = startInTurnLineReader({
      stdin,
      onLine: () => {
        throw new Error("capture sink boom")
      },
    })
    // Must not throw out of the emit (which models the turn's stdin chunk).
    expect(() => stdin.emit("boom\n")).not.toThrow()
    reader.dispose()
  })

  test("I. CRLF terminator ⇒ exactly ONE line (no trailing blank)", () => {
    const stdin = makeFakeStdin({ isTTY: false })
    const lines: string[] = []
    const reader = startInTurnLineReader({ stdin, onLine: (l) => void lines.push(l) })
    stdin.emit("windows line\r\n")
    reader.dispose()
    expect(lines).toEqual(["windows line"])
  })

  test("J. oversize newline-less partial dropped; a later completed line still lands", () => {
    const stdin = makeFakeStdin({ isTTY: false })
    const lines: string[] = []
    const reader = startInTurnLineReader({
      stdin,
      onLine: (l) => void lines.push(l),
      maxLineBytes: 8,
    })
    // 16 chars then a newline ⇒ ONE oversize line, dropped whole. The next line
    // (under the cap) still lands — overflow does not poison the reader.
    stdin.emit("0123456789ABCDEF\n")
    stdin.emit("ok\n")
    reader.dispose()
    expect(lines).toEqual(["ok"])
  })
})

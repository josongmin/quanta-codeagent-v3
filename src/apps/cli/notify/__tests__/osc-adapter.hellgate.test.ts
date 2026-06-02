/** RFC-09 (A) hellgate — OSC/BEL adapter: slow-turn gate, channel split, idle
 *  latch, title restore, title-injection guard. Pure (injected buffer writer,
 *  zero real terminal I/O). */

import { describe, expect, test } from "bun:test"
import { createOscNotificationPort, sanitizeTitle } from "../osc-adapter"

const BEL = "\x07"
const ESC = "\x1b"
const osc = (title: string): string => `${ESC}]0;${title}${BEL}`

const makeSink = (): { out: string[]; write: (s: string) => void } => {
  const out: string[] = []
  return { out, write: (s) => out.push(s) }
}

describe("RFC-09 A — osc-adapter slow-turn gate", () => {
  test("fast turn (< threshold) emits NOTHING", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "bell", slowTurnThresholdMs: 10_000 })
    port.onTurnComplete({ durationMs: 500, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([])
  })

  test("slow turn (>= threshold) emits exactly the done OSC title", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 10_000,
    })
    port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([osc("✓ proj — done")])
  })

  test("failed slow turn uses the ✗ glyph", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 1000,
    })
    port.onTurnComplete({ durationMs: 2000, ok: false, cwdBasename: "proj" })
    expect(out).toEqual([osc("✗ proj — done")])
  })

  test("exactly-at-threshold counts as slow (>=)", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 10_000,
    })
    port.onTurnComplete({ durationMs: 10_000, ok: true, cwdBasename: "x" })
    expect(out.length).toBe(1)
  })

  test("non-finite / negative duration fails closed (no emit)", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "bell", slowTurnThresholdMs: 10_000 })
    port.onTurnComplete({ durationMs: Number.NaN, ok: true, cwdBasename: "x" })
    port.onTurnComplete({ durationMs: -5, ok: true, cwdBasename: "x" })
    expect(out).toEqual([])
  })
})

describe("RFC-09 A — channel split (bell vs title_only)", () => {
  test('channel "bell" appends a separate BEL after the title', () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "bell", slowTurnThresholdMs: 0 })
    port.onTurnComplete({ durationMs: 1, ok: true, cwdBasename: "p" })
    expect(out).toEqual([osc("✓ p — done"), BEL])
  })

  test('channel "title_only" emits NO separate BEL (only the OSC terminator)', () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "title_only", slowTurnThresholdMs: 0 })
    port.onTurnComplete({ durationMs: 1, ok: true, cwdBasename: "p" })
    expect(out).toEqual([osc("✓ p — done")])
  })

  test('channel "off" is a pure no-op for every event', () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "off" })
    port.onTurnComplete({ durationMs: 999_999, ok: true, cwdBasename: "p" })
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    port.markActive()
    port.dispose()
    expect(out).toEqual([])
  })
})

describe("RFC-09 A — idle latch", () => {
  test("3 consecutive idle entries emit ONE title", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "title_only" })
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    expect(out).toEqual([osc("… p — waiting")])
  })

  test("markActive resets the latch ⇒ next idle re-fires", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "title_only" })
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    port.markActive()
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    expect(out).toEqual([osc("… p — waiting"), osc("… p — waiting")])
  })

  test('idle with channel "bell" also rings the bell once', () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "bell" })
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    expect(out).toEqual([osc("… p — waiting"), BEL])
  })
})

describe("RFC-09 A — title restore on dispose (idempotent)", () => {
  test("dispose restores the neutral cwd title after a turn", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "title_only", slowTurnThresholdMs: 0 })
    port.onTurnComplete({ durationMs: 1, ok: true, cwdBasename: "proj" })
    port.dispose()
    expect(out[out.length - 1]).toBe(osc("proj"))
  })

  test("dispose is idempotent — second call emits nothing", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "title_only" })
    port.onTurnComplete({ durationMs: 0, ok: true, cwdBasename: "proj" }) // no emit (gate)
    port.dispose()
    const afterFirst = out.length
    port.dispose()
    expect(out.length).toBe(afterFirst)
  })
})

describe("RFC-09 A — title-injection guard", () => {
  test("control chars (BEL/ESC) in cwdBasename are stripped", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "title_only", slowTurnThresholdMs: 0 })
    port.onTurnComplete({ durationMs: 1, ok: true, cwdBasename: `a${BEL}evil${ESC}]0;x` })
    const emitted = out[0] ?? ""
    // Exactly ONE BEL (the OSC terminator), NO embedded ESC beyond the leader.
    expect(emitted.split(BEL).length - 1).toBe(1)
    expect(emitted.split(ESC).length - 1).toBe(1)
    expect(emitted).toBe(osc("✓ aevil]0;x — done"))
  })

  test("sanitizeTitle keeps multi-byte glyphs, drops C0 + DEL", () => {
    expect(sanitizeTitle(`x${BEL}y`)).toBe("xy")
    expect(sanitizeTitle("a\x7fb")).toBe("ab")
    expect(sanitizeTitle("✓ proj — done")).toBe("✓ proj — done")
  })

  test("sanitizeTitle drops C1 controls (NEL 0x85) + line/para separators", () => {
    // C1 0x80-0x9f — NEL () can act as an 8-bit OSC intro / line break.
    expect(sanitizeTitle("abc")).toBe("abc")
    // U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR.
    expect(sanitizeTitle("a b c")).toBe("abc")
    // a glyph just past the C1 band (U+00A0 NBSP) is preserved.
    expect(sanitizeTitle("a b")).toBe("a b")
  })
})

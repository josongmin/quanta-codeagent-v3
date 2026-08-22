/**
 * HELLGATE — jun-6 paste-burst placeholder (Codex parity).
 *
 * Invariants under adversarial drive:
 *   - A single multi-char keypress ≥ `minChars` echoes `[Pasted Content N
 *     chars]` while the FULL pasted text is what SUBMITS.
 *   - A paste BELOW the threshold echoes inline (no placeholder).
 *   - Knob OFF (`pasteBurst` undefined) ⇒ the echoed stdout for a paste is
 *     BYTE-IDENTICAL to today's inline-echo build.
 *   - Submission ALWAYS carries the full text (placeholder is display-only).
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  pasteBurstPlaceholder,
  projectPasteDisplay,
  type ReadLineTestIO,
  readLine,
} from "../raw-line-reader"

interface KeyEvent {
  name?: string
  ctrl?: boolean
  sequence?: string
}

class FakeStdin extends EventEmitter {
  readonly isTTY = false
  resume(): void {}
  pause(): void {}
  key(str: string | undefined, key: KeyEvent = {}): void {
    this.emit("keypress", str, key)
  }
  /** A single keypress carrying a multi-char string = a bracketed paste. */
  paste(text: string): void {
    this.key(text, { sequence: text })
  }
  type(ch: string): void {
    this.key(ch, { name: ch, sequence: ch })
  }
  enter(): void {
    this.key("\r", { name: "return" })
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

const makeIO = (): { io: ReadLineTestIO; stdin: FakeStdin; stdout: FakeStdout } => {
  const stdin = new FakeStdin()
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

describe("paste-burst — pure projection", () => {
  test("placeholder wording matches Codex", () => {
    expect(pasteBurstPlaceholder(1234)).toBe("[Pasted Content 1234 chars]")
  })

  test("no segments ⇒ buf unchanged (byte-identical)", () => {
    expect(projectPasteDisplay("hello world", [])).toBe("hello world")
  })

  test("collapses a recorded segment to its placeholder", () => {
    const blob = "X".repeat(500)
    const buf = `prefix ${blob} suffix`
    const out = projectPasteDisplay(buf, [{ text: blob, placeholder: pasteBurstPlaceholder(500) }])
    expect(out).toBe("prefix [Pasted Content 500 chars] suffix")
  })

  test("an edited-away segment is skipped (no crash, raw chars stay)", () => {
    const out = projectPasteDisplay("abc", [{ text: "ZZZ", placeholder: "[x]" }])
    expect(out).toBe("abc")
  })
})

describe("paste-burst — submission carries FULL text", () => {
  const BIG = "A".repeat(120)

  test("≥minChars paste: placeholder echoed, full text submitted", async () => {
    const { io, stdin, stdout } = makeIO()
    const p = readLine({ prompt: "› ", pasteBurst: { minChars: 50 } }, io)
    stdin.paste(BIG)
    await flush()
    stdin.enter()
    const result = await p
    // Submission is the FULL pasted blob.
    expect(result).toBe(BIG)
    // The placeholder appeared in the echo; the raw 120-A blob never did.
    expect(stdout.bytes).toContain("[Pasted Content 120 chars]")
    expect(stdout.bytes).not.toContain(BIG)
  })

  test("paste BELOW threshold echoes inline (no placeholder)", async () => {
    const small = "A".repeat(10)
    const { io, stdin, stdout } = makeIO()
    const p = readLine({ prompt: "› ", pasteBurst: { minChars: 50 } }, io)
    stdin.paste(small)
    await flush()
    stdin.enter()
    const result = await p
    expect(result).toBe(small)
    expect(stdout.bytes).not.toContain("Pasted Content")
    expect(stdout.bytes).toContain(small)
  })
})

describe("paste-burst — no-spoof / verbatim submission (round-1 jun-6 audit)", () => {
  test("a paste whose CONTENT is a fake [Pasted Content N chars] submits verbatim", async () => {
    const fake = `[Pasted Content 9 chars] padding ${"Z".repeat(80)}`
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", pasteBurst: { minChars: 50 } }, io)
    stdin.paste(fake)
    await flush()
    stdin.enter()
    // The submitted line is EXACT bytes — the literal is data, never a real marker.
    expect(await p).toBe(fake)
  })

  test("a paste with ANSI + control chars submits the FULL bytes verbatim", async () => {
    const ansi = `[31mRED[0m${"P".repeat(80)}`
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", pasteBurst: { minChars: 50 } }, io)
    stdin.paste(ansi)
    await flush()
    stdin.enter()
    const result = await p
    expect(result).toBe(ansi)
    expect(result.length).toBe(ansi.length) // nothing dropped / escaped
  })

  test("emoji paste counts CODE POINTS in the placeholder yet submits verbatim", async () => {
    const blob = "😀".repeat(60) // 60 code points, 120 UTF-16 units
    const { io, stdin, stdout } = makeIO()
    const p = readLine({ prompt: "› ", pasteBurst: { minChars: 50 } }, io)
    stdin.paste(blob)
    await flush()
    stdin.enter()
    expect(await p).toBe(blob)
    expect(stdout.bytes).toContain(pasteBurstPlaceholder(60))
  })

  test("projectPasteDisplay leaves a non-segment fake placeholder untouched (pure display)", () => {
    expect(projectPasteDisplay("[Pasted Content 5 chars]", [])).toBe("[Pasted Content 5 chars]")
  })
})

// ── ROUND-2 (multi-chunk / accumulation lens) ───────────────────────────────
// A real paste can arrive as MULTIPLE keypress events (chunked by the terminal
// / readline). The buffer is the SOURCE OF TRUTH — it must accumulate every
// chunk's bytes with NO loss or duplication regardless of how the paste splits,
// and submission carries the exact concatenation.
describe("paste-burst — multi-chunk accumulation (buffer is source of truth)", () => {
  test("a paste split across TWO ≥minChars keypresses ⇒ both segments recorded, FULL bytes submit", async () => {
    const a = "A".repeat(80)
    const b = "B".repeat(80)
    const { io, stdin, stdout } = makeIO()
    const p = readLine({ prompt: "› ", pasteBurst: { minChars: 50 } }, io)
    // Two separate paste keypresses (the terminal chunked one big paste).
    stdin.paste(a)
    await flush()
    stdin.paste(b)
    await flush()
    stdin.enter()
    // Submission = exact concatenation, nothing lost / duplicated.
    expect(await p).toBe(a + b)
    // Each chunk collapsed to its own placeholder in the echo; neither raw blob shows.
    expect(stdout.bytes).toContain(pasteBurstPlaceholder(80))
    expect(stdout.bytes).not.toContain(a)
    expect(stdout.bytes).not.toContain(b)
  })

  test("big paste chunk + typed chars + another big chunk ⇒ exact interleaved buffer submits", async () => {
    const a = "A".repeat(60)
    const b = "B".repeat(60)
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", pasteBurst: { minChars: 50 } }, io)
    stdin.paste(a)
    await flush()
    stdin.type("x")
    stdin.type("y")
    await flush()
    stdin.paste(b)
    await flush()
    stdin.enter()
    // Cursor advanced to the end after each insert, so the order is a, x, y, b.
    expect(await p).toBe(`${a}xy${b}`)
  })

  test("two IDENTICAL big paste chunks ⇒ both bytes present (display dedup must not eat the buffer)", async () => {
    const blob = "Z".repeat(70)
    const { io, stdin } = makeIO()
    const p = readLine({ prompt: "› ", pasteBurst: { minChars: 50 } }, io)
    stdin.paste(blob)
    await flush()
    stdin.paste(blob)
    await flush()
    stdin.enter()
    // The buffer holds BOTH copies — projectPasteDisplay's first-occurrence
    // collapse is display-only and must NEVER shorten the submitted bytes.
    expect(await p).toBe(blob + blob)
    expect((await p).length).toBe(140)
  })
})

describe("paste-burst — knob OFF byte-identity", () => {
  const BIG = "B".repeat(200)

  test("OFF vs ON-below-threshold produce identical paste echo", async () => {
    // OFF build: pasteBurst absent.
    const off = makeIO()
    const pOff = readLine({ prompt: "› " }, off.io)
    off.stdin.paste(BIG)
    await flush()
    off.stdin.enter()
    const rOff = await pOff

    // The OFF build echoes the raw blob (no placeholder anywhere).
    expect(rOff).toBe(BIG)
    expect(off.stdout.bytes).toContain(BIG)
    expect(off.stdout.bytes).not.toContain("Pasted Content")
  })

  test("ON but paste under threshold is byte-identical to OFF", async () => {
    const text = "C".repeat(30)
    const off = makeIO()
    const on = makeIO()
    const pOff = readLine({ prompt: "› " }, off.io)
    const pOn = readLine({ prompt: "› ", pasteBurst: { minChars: 100 } }, on.io)
    off.stdin.paste(text)
    on.stdin.paste(text)
    await flush()
    off.stdin.enter()
    on.stdin.enter()
    expect(await pOff).toBe(await pOn)
    // The captured stdout streams are byte-identical (no placeholder branch hit).
    expect(on.stdout.bytes).toBe(off.stdout.bytes)
  })
})

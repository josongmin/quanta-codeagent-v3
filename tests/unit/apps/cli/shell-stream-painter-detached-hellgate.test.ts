/**
 * ★ HELLGATE — WS-H / UUX-6-05 + UUX-6-20 (painter side): honest rendering of
 * the `detached` shell terminal event.
 *
 * At HEAD the painter has no `detached` arm, so an intentional background
 * detach painted "[shell] aborted (timeout)" — a lie (the command is alive in
 * the registry). The fix paints:
 *   - reason consent / auto      ⇒ "[shell] moved to background"
 *   - reason consent_timeout     ⇒ the D-5 ANNOUNCEMENT line
 *                                  "no answer in Ns — defaulted to background"
 *                                  + "[shell] moved to background (consent timeout)"
 * PAIRED CONTROL: a REAL timeout-kill (`aborted`/`timeout`) still paints
 * "[shell] aborted (timeout)" byte-identically.
 */

import { describe, expect, test } from "bun:test"
import { buildShellStreamPainter } from "../../../../src/apps/cli/shell-stream-painter"

const paint = (): { out: string[]; observer: ReturnType<typeof buildShellStreamPainter> } => {
  const out: string[] = []
  const observer = buildShellStreamPainter({ write: (s) => out.push(s), color: false })
  return { out, observer }
}

describe("painter — detached event (RED at HEAD: no arm, silence)", () => {
  test("reason 'consent' ⇒ '[shell] moved to background' (no 'aborted' lie)", () => {
    const { out, observer } = paint()
    observer({ kind: "detached", reason: "consent", detachedAt: 1 })
    const text = out.join("")
    expect(text).toContain("[shell] moved to background")
    expect(text).not.toContain("aborted")
  })

  test("reason 'auto' ⇒ '[shell] moved to background'", () => {
    const { out, observer } = paint()
    observer({ kind: "detached", reason: "auto", detachedAt: 1 })
    expect(out.join("")).toContain("[shell] moved to background")
    expect(out.join("")).not.toContain("aborted")
  })

  test("UUX-6-20 — reason 'consent_timeout' ANNOUNCES the default: 'no answer in 60s — defaulted to background'", () => {
    const { out, observer } = paint()
    observer({ kind: "detached", reason: "consent_timeout", detachedAt: 1, consentWaitMs: 60_000 })
    const text = out.join("")
    expect(text).toContain("no answer in 60s — defaulted to background")
    expect(text).toContain("[shell] moved to background (consent timeout)")
    expect(text).not.toContain("aborted")
  })

  test("consent_timeout WITHOUT consentWaitMs still announces (no '0s' fabrication)", () => {
    const { out, observer } = paint()
    observer({ kind: "detached", reason: "consent_timeout", detachedAt: 1 })
    const text = out.join("")
    expect(text).toContain("no answer — defaulted to background")
    expect(text).not.toContain("0s")
  })

  test("detached FLUSHES pending partial-line output first (terminal-event parity with exit)", () => {
    const { out, observer } = paint()
    // A truncated multibyte char leaves a byte PENDING in the streaming
    // decoder. Without the terminal flush that byte is silently swallowed
    // ("caf"); WITH the flush the decoder emits its U+FFFD replacement — the
    // replacement char is the PROOF the tail was drained (exit-event parity).
    const bytes = new TextEncoder().encode("café") // é = 2 bytes (0xC3 0xA9)
    observer({ kind: "stdout", chunk: bytes.subarray(0, 4), offset: 0 }) // "caf" + é's FIRST byte only
    observer({ kind: "detached", reason: "auto", detachedAt: 1 })
    expect(out.join("")).toContain("caf�") // pending byte flushed, not swallowed
  })
})

describe("painter — PAIRED CONTROL: real kills unchanged", () => {
  test("aborted(timeout) still paints EXACTLY '[shell] aborted (timeout)\\n'", () => {
    const { out, observer } = paint()
    observer({ kind: "aborted", reason: "timeout", abortedAt: 1 })
    expect(out).toEqual(["[shell] aborted (timeout)\n"]) // byte-identical control
  })

  test("aborted(user_abort) still paints EXACTLY '[shell] aborted (user_abort)\\n'", () => {
    const { out, observer } = paint()
    observer({ kind: "aborted", reason: "user_abort", abortedAt: 1 })
    expect(out).toEqual(["[shell] aborted (user_abort)\n"])
  })
})

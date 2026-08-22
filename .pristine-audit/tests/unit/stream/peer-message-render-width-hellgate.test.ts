/**
 * DISPLAY HELLGATE (jul-26 audit finding): `renderPeerMessage` bounded the peer
 * body to PEER_BODY_MAX_LINES (line COUNT) but NOT line WIDTH. A single-line body
 * (no `\n`) — from any producer, or a future bump to the ~8 KB producer cap —
 * rendered in full and wrap-flooded the terminal. Every other renderer in
 * stdout.ts clamps width via `oneLine(…,160)`; this one was the lone exception.
 *
 * FIX: each shown line is wrapped in `oneLine` so width is bounded independently
 * of the upstream producer cap. RED-first: drop the `oneLine` wrap ⇒ the long
 * single-line body renders verbatim and this test's width assertion fails.
 */
import { describe, expect, test } from "bun:test"
import { StdoutStream } from "../../../src/stream/adapters/stdout"
import type { AgentEvent } from "../../../src/stream/types"

const peer = (body: string): Extract<AgentEvent, { type: "peer_message" }> => ({
  type: "peer_message",
  from: "root/1",
  to: "root",
  kind: "request",
  body,
  sentAt: 1,
  provenance: { source: "peer" },
})

// strip ANSI so the width assertion measures VISIBLE glyphs, not escape bytes.
// ESC built via RegExp string source (not a literal control char) to keep the
// source lint-clean while still matching the `[…m` SGR sequences.
// biome-ignore lint/complexity/useRegexLiterals: a literal would embed a raw ESC control char (noControlCharactersInRegex)
const ANSI_SGR = new RegExp("\\u001b\\[[0-9;]*m", "g")
const visibleLines = (chunks: string[]): string[] =>
  chunks.join("").replace(ANSI_SGR, "").split("\n")

describe("renderPeerMessage — per-line WIDTH is bounded (not just line count)", () => {
  test("a 5000-char single-line body renders clamped, not verbatim", () => {
    const out: string[] = []
    new StdoutStream({ write: (c) => out.push(c) }).emit(peer("Z".repeat(5000)))
    const bodyLine = visibleLines(out).find((l) => l.includes("Z")) ?? ""
    // clamp is oneLine's 160 + the "  " indent + the "…" marker → comfortably < 200.
    expect(bodyLine.length).toBeLessThan(200)
    expect(bodyLine).toContain("…")
  })

  test("a short body is preserved intact (no over-clamp)", () => {
    const out: string[] = []
    new StdoutStream({ write: (c) => out.push(c) }).emit(peer("hello peer"))
    expect(visibleLines(out).some((l) => l.includes("hello peer"))).toBe(true)
  })
})

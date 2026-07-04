/**
 * Ingest + reduce hellgate — tool output → cards → bounded digest.
 * Pins: vendored-frame drop, file:line location, raw-fallback reveal handle,
 * empty ledger ⇒ "", contradiction banner, most-recent bounding.
 */
import { describe, expect, test } from "bun:test"
import { ingestRawObservation, ingestTestFrames, type ParsedTestFrame } from "./ingest"
import { createEvidenceLedger } from "./ledger"
import { renderEvidenceDigest } from "./reducer"

const frame = (over: Partial<ParsedTestFrame> = {}): ParsedTestFrame => ({
  file: "src/fib.py",
  line: 3,
  tier: "user",
  text: "AssertionError: fib(10) expected 55 got 34",
  ...over,
})

describe("ingestTestFrames", () => {
  test("drops vendored frames, keeps user/test as parsed cards at file:line", () => {
    const cards = ingestTestFrames(
      [frame(), frame({ tier: "vendored", file: "site-packages/x.py" }), frame({ tier: "test", file: "test_fib.py", line: 9 })],
      4,
    )
    expect(cards.length).toBe(2)
    expect(cards[0]).toMatchObject({
      turn: 4,
      source: "test_output",
      confidence: "parsed",
      location: { file: "src/fib.py", lineStart: 3 },
    })
    expect(cards[1]?.location).toEqual({ file: "test_fib.py", lineStart: 9 })
  })

  test("claim is trimmed + bounded; missing line omits lineStart", () => {
    // no `line` key at all (exactOptional): location must omit lineStart
    const [c] = ingestTestFrames([{ file: "src/fib.py", tier: "user", text: "  x  " }], 1)
    expect(c?.claim).toBe("x")
    expect(c?.location).toEqual({ file: "src/fib.py" }) // no lineStart key
  })
})

describe("ingestRawObservation", () => {
  test("raw card carries a reveal handle, confidence=raw", () => {
    const c = ingestRawObservation("build_log", "compile failed (see raw)", 2, "raw-7")
    expect(c).toMatchObject({ source: "build_log", confidence: "raw", revealHandle: "raw-7", turn: 2 })
  })
})

describe("renderEvidenceDigest — end to end through the ledger", () => {
  test("empty ledger ⇒ empty string (byte-identical to no-evidence)", () => {
    expect(renderEvidenceDigest(createEvidenceLedger().snapshot())).toBe("")
  })

  test("ingested frames render as a bounded digest with file:line", () => {
    const l = createEvidenceLedger()
    for (const c of ingestTestFrames([frame()], 1)) l.add(c)
    const out = renderEvidenceDigest(l.snapshot())
    expect(out).toContain("Evidence ledger: 1 card(s).")
    expect(out).toContain("(test_output/parsed)")
    expect(out).toContain("[src/fib.py:3]")
  })

  test("contradiction leads with a banner", () => {
    const l = createEvidenceLedger()
    const base = l.add(ingestTestFrames([frame()], 1)[0]!)
    l.add({ turn: 2, source: "grep", claim: "code returns 34 unconditionally", confidence: "parsed", contradicts: [base.id] })
    const out = renderEvidenceDigest(l.snapshot())
    expect(out).toContain("1 CONTRADICTION(s) — resolve these first")
    expect(out).toContain("⚠contradicts")
  })

  test("bounds to most-recent maxCards and says so", () => {
    const l = createEvidenceLedger()
    for (let i = 0; i < 20; i++) l.add({ turn: i, source: "grep", claim: `hit ${i}`, confidence: "parsed" })
    const out = renderEvidenceDigest(l.snapshot(), 5)
    expect(out).toContain("showing most recent 5")
    expect(out).toContain("hit 19") // newest kept
    expect(out).not.toContain("hit 0") // oldest dropped
  })
})

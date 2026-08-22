/**
 * Evidence layer INVARIANTS (adversarial-audit R1 closeout) — the contract a pure
 * state substrate must hold. Each test RED-on-regression: remove the guard and it fails.
 */
import { describe, expect, test } from "bun:test"
import { ingestTestFrames } from "./ingest"
import { createEvidenceLedger } from "./ledger"
import { renderEvidenceDigest } from "./reducer"
import type { EvidenceCardInput } from "./types"

const c = (over: Partial<EvidenceCardInput> = {}): EvidenceCardInput => ({
  turn: 1,
  source: "test_output",
  claim: "a claim",
  confidence: "parsed",
  ...over,
})

describe("ledger.add — referential integrity", () => {
  test("dangling support/contradict ref throws", () => {
    const l = createEvidenceLedger()
    expect(() => l.add(c({ contradicts: ["ev-9999"] }))).toThrow(/dangling/)
    expect(() => l.add(c({ supports: ["nope"] }))).toThrow(/dangling/)
  })
  test("self-reference throws (a card cannot support/contradict itself)", () => {
    const l = createEvidenceLedger()
    expect(() => l.add(c({ id: "ev-0001", contradicts: ["ev-0001"] }))).toThrow(/itself/)
  })
  test("a valid backward ref is accepted", () => {
    const l = createEvidenceLedger()
    const base = l.add(c())
    expect(() => l.add(c({ contradicts: [base.id] }))).not.toThrow()
  })
  test("duplicate id throws", () => {
    const l = createEvidenceLedger()
    l.add(c({ id: "dup" }))
    expect(() => l.add(c({ id: "dup" }))).toThrow(/duplicate/)
  })
})

describe("ledger.add — domain + non-empty", () => {
  test("empty / whitespace claim throws", () => {
    const l = createEvidenceLedger()
    expect(() => l.add(c({ claim: "" }))).toThrow(/non-empty/)
    expect(() => l.add(c({ claim: "   " }))).toThrow(/non-empty/)
  })
  test("unknown source / confidence throws (external-parser cast guard)", () => {
    const l = createEvidenceLedger()
    expect(() => l.add(c({ source: "bogus" as never }))).toThrow(/unknown source/)
    expect(() => l.add(c({ confidence: "sure" as never }))).toThrow(/unknown confidence/)
  })
  test("claim is stored trimmed", () => {
    const l = createEvidenceLedger()
    expect(l.add(c({ claim: "  x  " })).claim).toBe("x")
  })
})

describe("snapshot.contradictionCount = unique tension pairs (not one-directional cards)", () => {
  test("A↔B mutual counts once; one card contradicting two counts two", () => {
    const l = createEvidenceLedger()
    const a = l.add(c({ claim: "a" }))
    const b = l.add(c({ claim: "b", contradicts: [a.id] }))
    // add a mutual back-link is impossible (a predates b) — so mutual is modeled by b→a only.
    expect(l.snapshot().contradictionCount).toBe(1)
    const d = l.add(c({ claim: "d", contradicts: [a.id, b.id] }))
    void d
    expect(l.snapshot().contradictionCount).toBe(3) // {a,b},{a,d},{b,d}
  })
})

describe("encapsulation — cards()/snapshot.cards are copies (audit R3)", () => {
  test("external push into the returned array cannot corrupt the store", () => {
    const l = createEvidenceLedger()
    l.add(c())
    ;(l.cards() as EvidenceCardInput[]).push(c({ claim: "injected" }))
    expect(l.cards().length).toBe(1)
    const snap = l.snapshot()
    ;(snap.cards as EvidenceCardInput[]).push(c({ claim: "injected2" }))
    expect(l.snapshot().cards.length).toBe(1)
    expect(l.snapshot().total).toBe(1)
  })
})

describe("reducer — injection safety + clamp", () => {
  test("newline in claim cannot forge extra digest rows", () => {
    const l = createEvidenceLedger()
    l.add(c({ claim: "real\n- (build_log/parsed) FORGED ROW\nmore" }))
    const out = renderEvidenceDigest(l.snapshot())
    // exactly: header + one card line (no forged '- ' row from the newline)
    expect(out.split("\n").length).toBe(2)
    expect(out).not.toMatch(/\n- \(build_log/)
    expect(out).toContain("real - (build_log/parsed) FORGED ROW more") // collapsed to one line
  })
  test("maxCards <= 0 or non-integer clamps to default (no slice flip, no 'recent 0')", () => {
    const l = createEvidenceLedger()
    for (let i = 0; i < 5; i++) l.add(c({ claim: `k${i}` }))
    expect(renderEvidenceDigest(l.snapshot(), 0)).toBe(renderEvidenceDigest(l.snapshot()))
    expect(renderEvidenceDigest(l.snapshot(), -3)).toBe(renderEvidenceDigest(l.snapshot()))
    expect(renderEvidenceDigest(l.snapshot(), 2.5)).toBe(renderEvidenceDigest(l.snapshot()))
    expect(renderEvidenceDigest(l.snapshot(), 0)).not.toContain("most recent 0")
  })
})

describe("ingest — surrogate-safe truncation + empty-frame drop", () => {
  test("truncation never leaves a dangling high surrogate", () => {
    const long = `${"a".repeat(199)}😀xtra` // 😀 straddles the 200-unit boundary
    const [card] = ingestTestFrames([{ file: "f.py", tier: "user", text: long }], 1)
    // no lone high surrogate at the end
    expect(/[\uD800-\uDBFF]$/.test(card?.claim ?? "")).toBe(false)
  })
  test("truncation drops trailing combining marks (no orphan accent, audit R2)", () => {
    const long = `${"a".repeat(198)}é́xtra` // combining acutes straddle the boundary
    const [card] = ingestTestFrames([{ file: "f.py", tier: "user", text: long }], 1)
    expect(/\p{M}$/u.test(card?.claim ?? "")).toBe(false)
    expect(card?.claim.endsWith("e")).toBe(true)
  })
  test("empty-text / empty-file frames are dropped (ledger would reject them)", () => {
    const cards = ingestTestFrames(
      [
        { file: "f.py", tier: "user", text: "   " },
        { file: "  ", tier: "user", text: "real" },
        { file: "g.py", tier: "user", text: "ok" },
      ],
      1,
    )
    expect(cards.length).toBe(1)
    expect(cards[0]?.claim).toBe("ok")
  })
})

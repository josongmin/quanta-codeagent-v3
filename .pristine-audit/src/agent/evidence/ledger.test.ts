/**
 * EvidenceLedger — deterministic accumulation + query hellgate.
 *
 * Pins: (1) deterministic zero-padded ids (no clock/random), (2) insertion order,
 * (3) id assigned only when absent, (4) bySource/contradictions queries, (5) snapshot
 * counts, (6) optional keys omitted when absent (byte-identical card shape).
 */
import { describe, expect, test } from "bun:test"
import { createEvidenceLedger } from "./ledger"
import type { EvidenceCardInput } from "./types"

const card = (over: Partial<EvidenceCardInput> = {}): EvidenceCardInput => ({
  turn: 1,
  source: "test_output",
  claim: "test_fib failed: expected 55 got 34",
  confidence: "parsed",
  ...over,
})

describe("createEvidenceLedger — deterministic ids + accumulation", () => {
  test("assigns zero-padded sequential ids (deterministic, lexical=insertion order)", () => {
    const l = createEvidenceLedger()
    const a = l.add(card())
    const b = l.add(card({ claim: "second" }))
    expect(a.id).toBe("ev-0001")
    expect(b.id).toBe("ev-0002")
    expect(a.id < b.id).toBe(true) // lexical order matches insertion
  })

  test("two fresh ledgers with the same sequence produce identical ids (no clock/random)", () => {
    const idsOf = () => {
      const l = createEvidenceLedger()
      return [l.add(card()).id, l.add(card({ claim: "x" })).id, l.add(card({ claim: "y" })).id]
    }
    expect(idsOf()).toEqual(idsOf())
  })

  test("respects a caller-supplied id, still advances the sequence for the next mint", () => {
    const l = createEvidenceLedger()
    const pinned = l.add(card({ id: "custom-1" }))
    const next = l.add(card())
    expect(pinned.id).toBe("custom-1")
    expect(next.id).toBe("ev-0002") // seq advanced past the pinned card
  })

  test("cards() returns insertion order; add returns the stored card (fresh readback)", () => {
    const l = createEvidenceLedger()
    l.add(card({ claim: "first" }))
    l.add(card({ claim: "second" }))
    const all = l.cards()
    expect(all.map((c) => c.claim)).toEqual(["first", "second"])
    // the returned card is the one in the store
    expect(l.cards()[0]).toBe(all[0])
  })
})

describe("EvidenceLedger — queries", () => {
  test("bySource filters to the requested source only (paired control)", () => {
    const l = createEvidenceLedger()
    l.add(card({ source: "test_output", claim: "t" }))
    l.add(card({ source: "grep", claim: "g" }))
    l.add(card({ source: "test_output", claim: "t2" }))
    expect(l.bySource("test_output").map((c) => c.claim)).toEqual(["t", "t2"])
    expect(l.bySource("grep").map((c) => c.claim)).toEqual(["g"])
    expect(l.bySource("build_log")).toEqual([]) // absent source ⇒ empty, not error
  })

  test("contradictions returns only cards with a non-empty contradicts link", () => {
    const l = createEvidenceLedger()
    const base = l.add(card({ claim: "fib(10)=55 per docstring" }))
    l.add(card({ claim: "code returns 34", contradicts: [base.id] }))
    l.add(card({ claim: "unrelated" }))
    const c = l.contradictions()
    expect(c.length).toBe(1)
    expect(c[0]?.contradicts).toEqual(["ev-0001"])
  })
})

describe("EvidenceLedger — snapshot + card shape", () => {
  test("snapshot counts total / bySource / contradictions", () => {
    const l = createEvidenceLedger()
    const a = l.add(card({ source: "test_output" }))
    l.add(card({ source: "grep" }))
    l.add(card({ source: "grep", contradicts: [a.id] }))
    const s = l.snapshot()
    expect(s.total).toBe(3)
    expect(s.bySource).toEqual({ test_output: 1, grep: 2 })
    expect(s.contradictionCount).toBe(1)
    expect(s.cards.length).toBe(3)
  })

  test("optional keys (location, revealHandle) omitted when absent; present when given", () => {
    const l = createEvidenceLedger()
    const bare = l.add(card())
    expect("location" in bare).toBe(false)
    expect("revealHandle" in bare).toBe(false)
    const rich = l.add(card({ location: { file: "fib.py", lineStart: 3 }, revealHandle: "raw-42" }))
    expect(rich.location).toEqual({ file: "fib.py", lineStart: 3 })
    expect(rich.revealHandle).toBe("raw-42")
  })

  test("defaults: supports/contradicts default to [] (never undefined)", () => {
    const l = createEvidenceLedger()
    const c = l.add(card())
    expect(c.supports).toEqual([])
    expect(c.contradicts).toEqual([])
  })
})

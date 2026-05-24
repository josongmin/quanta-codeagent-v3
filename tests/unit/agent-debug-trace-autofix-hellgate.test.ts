/**
 * Hellgate — BugFixProposalQueue (ADR-0186).
 *
 * 13 cases pinning the capture-and-list contract for the debug-trace bug-fix
 * proposal queue. The queue is a PURE in-memory primitive that does NOT
 * modify source — auto-apply is a separate (Phase 2) slice. These tests
 * lock down the conservative posture.
 */

import { describe, expect, test } from "bun:test"
import {
  BugFixProposalError,
  type BugFixProposalQueue,
  defaultBugFixProposalQueue,
} from "@/agent/debug-trace-autofix"

// ----- helpers -----

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}

let idCounter = 0
const stableIdGen = (): string => {
  idCounter += 1
  return `bf-${idCounter.toString(16).padStart(4, "0")}`
}

const fresh = (maxEntries = 50): BugFixProposalQueue => {
  tickValue = 1_000
  idCounter = 0
  return defaultBugFixProposalQueue({
    maxEntries,
    now: tick,
    idGen: stableIdGen,
  })
}

const sampleProposal = (overrides?: { errorSummary?: string; file?: string; line?: number }) => ({
  errorSummary: overrides?.errorSummary ?? "TypeError: undefined is not an object",
  file: overrides?.file ?? "src/foo.ts",
  line: overrides?.line ?? 42,
  hypothesisRanked: [
    {
      cause: "missing null check on `bar`",
      fix: "add `if (!bar) return null` before line 42",
      confidence: "high" as const,
    },
    {
      cause: "stale cache returning undefined",
      fix: "invalidate cache before access",
      confidence: "medium" as const,
    },
  ],
  verifyRail: "bun test tests/unit/foo.test.ts",
})

// ===================================================================
// A. capture (4)
// ===================================================================

describe("BugFixProposalQueue — A. capture", () => {
  test("HELL-1: happy capture returns id matching /^bf-[0-9a-f]+$/; list has 1 entry", () => {
    const q = defaultBugFixProposalQueue() // real id gen
    const id = q.capture(sampleProposal())
    expect(id).toMatch(/^bf-[0-9a-f]+$/)
    const all = q.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe(id)
    expect(all[0]?.errorSummary).toBe("TypeError: undefined is not an object")
    expect(all[0]?.file).toBe("src/foo.ts")
    expect(all[0]?.line).toBe(42)
  })

  test("HELL-2: capturedAt uses the INJECTED clock", () => {
    const q = fresh()
    q.capture(sampleProposal())
    q.capture(sampleProposal({ file: "src/bar.ts" }))
    const all = q.list()
    // tickValue starts at 1_000, incremented on each tick call.
    // Newest first → bar.ts captured second (capturedAt 1_002), foo.ts first (1_001).
    expect(all[0]?.file).toBe("src/bar.ts")
    expect(all[0]?.capturedAt).toBe(1_002)
    expect(all[1]?.file).toBe("src/foo.ts")
    expect(all[1]?.capturedAt).toBe(1_001)
  })

  test("HELL-3: hypothesisRanked PRESERVES caller order (no rerank)", () => {
    const q = fresh()
    q.capture({
      errorSummary: "oops",
      file: "src/x.ts",
      line: 1,
      hypothesisRanked: [
        { cause: "first", fix: "fix-A", confidence: "low" },
        { cause: "second", fix: "fix-B", confidence: "high" },
        { cause: "third", fix: "fix-C", confidence: "medium" },
      ],
    })
    const got = q.list()[0]?.hypothesisRanked
    expect(got?.map((h) => h.cause)).toEqual(["first", "second", "third"])
    // confidence "high" did NOT bubble to position 0 — queue is order-preserving.
    expect(got?.[0]?.confidence).toBe("low")
  })

  test("HELL-4: missing required fields throw typed BugFixProposalError", () => {
    const q = fresh()
    const missingSummary = () =>
      q.capture({
        errorSummary: "",
        file: "src/x.ts",
        line: 1,
        hypothesisRanked: [],
      })
    expect(missingSummary).toThrow(BugFixProposalError)
    expect(missingSummary).toThrow(/errorSummary/)

    const missingFile = () =>
      q.capture({
        errorSummary: "x",
        file: "",
        line: 1,
        hypothesisRanked: [],
      })
    expect(missingFile).toThrow(BugFixProposalError)
    expect(missingFile).toThrow(/file/)

    const badLine = () =>
      q.capture({
        errorSummary: "x",
        file: "src/x.ts",
        line: 0,
        hypothesisRanked: [],
      })
    expect(badLine).toThrow(BugFixProposalError)
    expect(badLine).toThrow(/line/)

    const negativeLine = () =>
      q.capture({
        errorSummary: "x",
        file: "src/x.ts",
        line: -3,
        hypothesisRanked: [],
      })
    expect(negativeLine).toThrow(BugFixProposalError)

    const fractionalLine = () =>
      q.capture({
        errorSummary: "x",
        file: "src/x.ts",
        line: 1.5,
        hypothesisRanked: [],
      })
    expect(fractionalLine).toThrow(BugFixProposalError)
  })
})

// ===================================================================
// B. list (3)
// ===================================================================

describe("BugFixProposalQueue — B. list", () => {
  test("HELL-5: multiple captures → list returns NEWEST first", () => {
    const q = fresh()
    q.capture(sampleProposal({ file: "src/a.ts" }))
    q.capture(sampleProposal({ file: "src/b.ts" }))
    q.capture(sampleProposal({ file: "src/c.ts" }))
    const files = q.list().map((p) => p.file)
    expect(files).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"])
  })

  test("HELL-6: empty queue → list returns empty array (no throw)", () => {
    const q = fresh()
    expect(q.list()).toEqual([])
    expect(q.list()).toHaveLength(0)
  })

  test("HELL-7: list returns FROZEN array (mutation rejected in strict mode)", () => {
    const q = fresh()
    q.capture(sampleProposal())
    const all = q.list()
    expect(Object.isFrozen(all)).toBe(true)
    // Mutating frozen array throws in strict mode (test files run strict).
    // Cast through unknown to bypass readonly-array protection — we are
    // deliberately attempting the mutation to assert the runtime guard.
    const mutable = all as unknown as { pop: () => unknown; push: (x: unknown) => number }
    expect(() => mutable.pop()).toThrow()
    expect(() => mutable.push({})).toThrow()
  })
})

// ===================================================================
// C. resolve (3)
// ===================================================================

describe("BugFixProposalQueue — C. resolve", () => {
  test("HELL-8: resolve known id → true; subsequent list omits it", () => {
    const q = fresh()
    const id = q.capture(sampleProposal())
    expect(q.list()).toHaveLength(1)
    expect(q.resolve(id)).toBe(true)
    expect(q.list()).toHaveLength(0)
  })

  test("HELL-9: resolve unknown id → false; no throw", () => {
    const q = fresh()
    q.capture(sampleProposal())
    expect(q.resolve("bf-nonexistent")).toBe(false)
    expect(q.list()).toHaveLength(1) // unchanged
  })

  test("HELL-10: resolve same id twice → second returns false (idempotent)", () => {
    const q = fresh()
    const id = q.capture(sampleProposal())
    expect(q.resolve(id)).toBe(true)
    expect(q.resolve(id)).toBe(false)
    expect(q.resolve(id)).toBe(false) // still false on Nth call
  })
})

// ===================================================================
// D. LRU (2)
// ===================================================================

describe("BugFixProposalQueue — D. LRU", () => {
  test("HELL-11: maxEntries=3 + 4 captures → oldest dropped; resolving doesn't 'unblock' LRU", () => {
    const q = fresh(3)
    const id1 = q.capture(sampleProposal({ file: "src/1.ts" }))
    q.capture(sampleProposal({ file: "src/2.ts" }))
    q.capture(sampleProposal({ file: "src/3.ts" }))
    // Cap is 3; 4th eviction drops id1 (oldest).
    q.capture(sampleProposal({ file: "src/4.ts" }))

    const files = q.list().map((p) => p.file)
    expect(files).toEqual(["src/4.ts", "src/3.ts", "src/2.ts"])
    // The dropped id is GONE — resolve returns false (it was evicted, not
    // resolved). The contract: caller can't distinguish "evicted" from
    // "never existed" via resolve(). That's by design — keep the surface small.
    expect(q.resolve(id1)).toBe(false)
  })

  test("HELL-12: custom idGen produces ids matching the injected pattern", () => {
    const q = fresh() // uses stableIdGen → bf-0001, bf-0002…
    const id1 = q.capture(sampleProposal())
    const id2 = q.capture(sampleProposal({ file: "src/x.ts" }))
    expect(id1).toBe("bf-0001")
    expect(id2).toBe("bf-0002")
  })
})

// ===================================================================
// E. Determinism (1)
// ===================================================================

describe("BugFixProposalQueue — E. determinism", () => {
  test("HELL-13: same captures + same clock + same idGen → byte-identical list() output", () => {
    const captureRun = (): unknown => {
      const q = fresh()
      q.capture(sampleProposal({ file: "src/a.ts" }))
      q.capture(sampleProposal({ file: "src/b.ts" }))
      // Serialize via JSON.stringify after stripping the frozen wrapper —
      // structural equality is the byte-identity claim.
      return JSON.parse(JSON.stringify(q.list()))
    }
    const run1 = captureRun()
    const run2 = captureRun()
    expect(run1).toEqual(run2)
  })
})

// ===================================================================
// F. clear (additional safety — not numbered, but exercises the surface)
// ===================================================================

describe("BugFixProposalQueue — F. clear", () => {
  test("clear drops every entry; list returns empty afterwards", () => {
    const q = fresh()
    q.capture(sampleProposal())
    q.capture(sampleProposal({ file: "src/x.ts" }))
    expect(q.list()).toHaveLength(2)
    q.clear()
    expect(q.list()).toHaveLength(0)
  })
})

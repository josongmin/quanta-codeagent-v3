/**
 * BugFixProposalQueue — rank / capture / no-mutate invariant sibling hellgate
 * (ADR-0186).
 *
 * Sibling to `agent-debug-trace-autofix-hellgate.test.ts` (which covers basic
 * capture / list / resolve / LRU / determinism). THIS file pins the DEEPER
 * invariants the original test does NOT touch:
 *
 *   - hypothesisRanked is a DEFENSIVE COPY (caller mutation post-capture
 *     does NOT corrupt the stored proposal)
 *   - the stored entry itself is FROZEN
 *   - confidence label is opaque ("any" string structurally accepted —
 *     queue does NOT enforce the union at runtime)
 *   - randomBytes-default idGen returns DISTINCT ids per call (no collision
 *     for back-to-back captures at default RNG)
 *   - exactOptionalPropertyTypes — verifyRail OMITTED when caller omits
 *   - resolve does NOT mutate the snapshot a caller already has
 *   - drain (== resolve all) twice returns empty second pass
 *   - LRU eviction order on insertion-Map semantics
 *
 * 14 distinct cases.
 */

import { describe, expect, test } from "bun:test"
import {
  type BugFixProposal,
  type BugFixProposalQueue,
  defaultBugFixProposalQueue,
} from "@/agent/debug-trace-autofix"

// ── helpers ──────────────────────────────────────────────────

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
  return defaultBugFixProposalQueue({ maxEntries, now: tick, idGen: stableIdGen })
}
const proposal = (over?: Partial<Omit<BugFixProposal, "id" | "capturedAt">>) => ({
  errorSummary: over?.errorSummary ?? "TypeError",
  file: over?.file ?? "src/x.ts",
  line: over?.line ?? 1,
  hypothesisRanked: over?.hypothesisRanked ?? [
    { cause: "c1", fix: "f1", confidence: "high" as const },
  ],
  ...(over?.verifyRail !== undefined ? { verifyRail: over.verifyRail } : {}),
})

// ============================================================
// A. hypothesisRanked defensive-copy / freeze invariants (4)
// ============================================================

describe("BugFixProposalQueue rank — A. defensive copy / freeze", () => {
  test("RANK-1: caller mutating the SOURCE array AFTER capture does NOT change the stored entry", () => {
    // Source: "Freeze the hypothesisRanked array so caller mutations after
    // capture don't corrupt the stored proposal." (debug-trace-autofix.ts L168-L170)
    const q = fresh()
    const ranks: Array<{ cause: string; fix: string; confidence: "high" | "medium" | "low" }> = [
      { cause: "first", fix: "fix-A", confidence: "high" },
      { cause: "second", fix: "fix-B", confidence: "medium" },
    ]
    q.capture(proposal({ hypothesisRanked: ranks }))
    // Caller corrupts THEIR ORIGINAL ranks array.
    ranks.push({ cause: "INJECTED", fix: "fix-EVIL", confidence: "low" })
    ranks[0] = { cause: "MUTATED", fix: "no-fix", confidence: "low" }
    const stored = q.list()[0]?.hypothesisRanked
    expect(stored).toHaveLength(2)
    expect(stored?.[0]?.cause).toBe("first")
    expect(stored?.[1]?.cause).toBe("second")
  })

  test("RANK-2: the STORED hypothesisRanked array is FROZEN (push/pop reject)", () => {
    const q = fresh()
    q.capture(proposal())
    const stored = q.list()[0]?.hypothesisRanked
    expect(stored).toBeDefined()
    expect(Object.isFrozen(stored)).toBe(true)
    // Cast through unknown to attempt mutation in strict mode.
    const mut = stored as unknown as { push: (x: unknown) => number; pop: () => unknown }
    expect(() => mut.push({})).toThrow()
    expect(() => mut.pop()).toThrow()
  })

  test("RANK-3: the STORED proposal object itself is FROZEN (top-level keys not writable)", () => {
    // Source: `store.set(id, Object.freeze(proposal))` (L173). Confirms the
    // entire envelope (not just hypothesisRanked) is sealed.
    const q = fresh()
    q.capture(proposal())
    const stored = q.list()[0]
    expect(stored).toBeDefined()
    if (stored === undefined) return
    expect(Object.isFrozen(stored)).toBe(true)
    const mut = stored as unknown as { file: string; line: number }
    // Assignment in strict mode (test runs strict) throws.
    expect(() => {
      mut.file = "hacked"
    }).toThrow()
    expect(() => {
      mut.line = 99
    }).toThrow()
  })

  test("RANK-4: rank order preserved across MULTIPLE captures (each entry's ranks independent)", () => {
    const q = fresh()
    q.capture(
      proposal({
        file: "src/a.ts",
        hypothesisRanked: [
          { cause: "A1", fix: "f1", confidence: "low" as const },
          { cause: "A2", fix: "f2", confidence: "high" as const },
        ],
      }),
    )
    q.capture(
      proposal({
        file: "src/b.ts",
        hypothesisRanked: [{ cause: "B1", fix: "f3", confidence: "medium" as const }],
      }),
    )
    const all = q.list() // newest first
    expect(all[0]?.file).toBe("src/b.ts")
    expect(all[0]?.hypothesisRanked.map((h) => h.cause)).toEqual(["B1"])
    expect(all[1]?.file).toBe("src/a.ts")
    expect(all[1]?.hypothesisRanked.map((h) => h.cause)).toEqual(["A1", "A2"])
  })
})

// ============================================================
// B. randomBytes default + opaque confidence + exactOptional (4)
// ============================================================

describe("BugFixProposalQueue rank — B. id / confidence / exactOptional", () => {
  test("RANK-5: default idGen (randomBytes) returns DISTINCT ids across 50 captures", () => {
    const q = defaultBugFixProposalQueue() // real id gen
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      ids.add(q.capture(proposal({ line: i + 1 })))
    }
    // 4 bytes = 8 hex chars = 4 billion space — no collisions expected for n=50.
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^bf-[0-9a-f]{8}$/)
  })

  test("RANK-6: confidence label is OPAQUE — queue does NOT validate the union at runtime", () => {
    // The TS type says `"high" | "medium" | "low"` but `validateInput` only
    // checks hypothesisRanked is an array. A caller that bypasses TS (e.g.
    // JSON-driven, plugin boundary) can pass any string — stored verbatim.
    const q = fresh()
    q.capture(
      proposal({
        hypothesisRanked: [
          // biome-ignore lint/suspicious/noExplicitAny: deliberate type bypass for runtime invariant probe
          { cause: "weird", fix: "x", confidence: "WHATEVER" as any },
        ],
      }),
    )
    const ranks = q.list()[0]?.hypothesisRanked
    // Stored as-is — no normalization, no rejection.
    expect(ranks?.[0]?.confidence).toBe("WHATEVER" as unknown as "high")
  })

  test("RANK-7: verifyRail OMITTED in input → KEY ABSENT in stored entry (exactOptionalPropertyTypes)", () => {
    const q = fresh()
    q.capture(proposal()) // no verifyRail
    const stored = q.list()[0]
    expect(stored).toBeDefined()
    if (stored === undefined) return
    // Source (L171-L173): `...(p.verifyRail !== undefined ? { verifyRail: p.verifyRail } : {})`
    expect("verifyRail" in stored).toBe(false)
    // With verifyRail present, key IS there.
    q.capture(proposal({ file: "src/y.ts", verifyRail: "bun test foo" }))
    const withRail = q.list()[0] // newest first → with-rail
    expect(withRail).toBeDefined()
    if (withRail === undefined) return
    expect("verifyRail" in withRail).toBe(true)
    expect(withRail.verifyRail).toBe("bun test foo")
  })

  test("RANK-8: hypothesisRanked === [] (empty array) is accepted (no validation on min-length)", () => {
    // The validateInput accepts an empty array — only that it IS an array.
    // Captures empty-hypothesis case: caller has the error but no fix ideas.
    const q = fresh()
    const id = q.capture(proposal({ hypothesisRanked: [] }))
    const stored = q.list().find((p) => p.id === id)
    expect(stored).toBeDefined()
    expect(stored?.hypothesisRanked).toEqual([])
  })
})

// ============================================================
// C. resolve no-mutate / drain-twice / list snapshot (3)
// ============================================================

describe("BugFixProposalQueue rank — C. resolve invariants / snapshot", () => {
  test("RANK-9: resolve does NOT mutate a list() snapshot the caller is still holding", () => {
    // list() returns a frozen array but the caller's REFERENCE survives a
    // subsequent resolve. The held snapshot must not have its length changed.
    const q = fresh()
    const id = q.capture(proposal())
    const held = q.list()
    expect(held).toHaveLength(1)
    expect(q.resolve(id)).toBe(true)
    // Held snapshot is independent.
    expect(held).toHaveLength(1)
    expect(held[0]?.id).toBe(id)
    // Fresh list is empty.
    expect(q.list()).toHaveLength(0)
  })

  test("RANK-10: list() called twice without intervening capture → SAME content (structurally), but distinct frozen wrappers", () => {
    const q = fresh()
    q.capture(proposal({ file: "src/a.ts" }))
    q.capture(proposal({ file: "src/b.ts" }))
    const a = q.list()
    const b = q.list()
    expect(a).not.toBe(b) // new frozen wrapper each call
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test("RANK-11: resolve all then list → empty; resolve same ids again → all false (drain-twice analog)", () => {
    const q = fresh()
    const ids = [
      q.capture(proposal({ file: "src/a.ts" })),
      q.capture(proposal({ file: "src/b.ts" })),
      q.capture(proposal({ file: "src/c.ts" })),
    ]
    for (const id of ids) expect(q.resolve(id)).toBe(true)
    expect(q.list()).toHaveLength(0)
    for (const id of ids) expect(q.resolve(id)).toBe(false)
  })
})

// ============================================================
// D. capturedAt + LRU edge (3)
// ============================================================

describe("BugFixProposalQueue rank — D. capturedAt / LRU edge", () => {
  test("RANK-12: capturedAt copied EXACTLY from clock(); two captures at same tick yield same capturedAt", () => {
    // Pin clock to a constant — both entries have identical capturedAt.
    const q = defaultBugFixProposalQueue({ now: () => 42, idGen: stableIdGen })
    idCounter = 0
    q.capture(proposal({ file: "src/a.ts" }))
    q.capture(proposal({ file: "src/b.ts" }))
    const all = q.list()
    expect(all).toHaveLength(2)
    expect(all[0]?.capturedAt).toBe(42)
    expect(all[1]?.capturedAt).toBe(42)
    // Newest-first ordering preserved by Map insertion order, NOT by capturedAt.
    expect(all[0]?.file).toBe("src/b.ts")
    expect(all[1]?.file).toBe("src/a.ts")
  })

  test("RANK-13: maxEntries=1 with 5 captures → only the NEWEST survives", () => {
    const q = fresh(1)
    q.capture(proposal({ file: "src/1.ts" }))
    q.capture(proposal({ file: "src/2.ts" }))
    q.capture(proposal({ file: "src/3.ts" }))
    q.capture(proposal({ file: "src/4.ts" }))
    q.capture(proposal({ file: "src/5.ts" }))
    const all = q.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.file).toBe("src/5.ts")
  })

  test("RANK-14: maxEntries=0 clamps to 1 (configurable lower bound)", () => {
    // Source (L141): `Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES)`.
    const q = defaultBugFixProposalQueue({ maxEntries: 0, now: tick, idGen: stableIdGen })
    idCounter = 0
    q.capture(proposal({ file: "src/a.ts" }))
    q.capture(proposal({ file: "src/b.ts" }))
    expect(q.list()).toHaveLength(1)
    expect(q.list()[0]?.file).toBe("src/b.ts")
  })
})

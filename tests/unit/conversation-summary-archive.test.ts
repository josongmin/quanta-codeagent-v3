/**
 * ConversationSummaryArchive unit tests (ADR-0069).
 *
 * Pure module — no clock, no IO. Tests pin the slice contract:
 *   - `createArchive` returns an empty archive (no hidden fields).
 *   - `appendSummary` mutates in place (no clone) AND returns the same ref.
 *   - `archivedTokens` sums verbatim tokens (no clamping / heuristic).
 *   - field passthrough is verbatim (no normalization of fromTurnId / summary).
 *
 * The slice contract is enforced here because the loop's `maybeCompact` reads
 * the LAST entry's `toTurnId` to derive the NEXT entry's `fromTurnId`
 * (sliding-window contiguity). If `appendSummary` ever cloned or reordered,
 * that derivation would silently break.
 */
import { describe, expect, test } from "bun:test"
import { appendSummary, archivedTokens, createArchive } from "@/agent"
import { MAX_ARCHIVED_SUMMARIES } from "@/agent/conversation-summary-archive"

const sample = (over: Partial<Parameters<typeof appendSummary>[1]>) => ({
  fromTurnId: "t0",
  toTurnId: "t1",
  summary: "short",
  ts: 1_000,
  tokens: 4,
  ...over,
})

describe("ConversationSummaryArchive", () => {
  test("createArchive: empty summaries[]", () => {
    const a = createArchive()
    expect(a.summaries).toEqual([])
    expect(Object.keys(a)).toEqual(["summaries"])
  })

  test("appendSummary: mutates in place, returns same archive reference", () => {
    const a = createArchive()
    const ret = appendSummary(a, sample({}))
    expect(ret).toBe(a)
    expect(a.summaries.length).toBe(1)
  })

  test("appendSummary: fields stored verbatim (no normalization)", () => {
    const a = createArchive()
    const entry = sample({
      fromTurnId: "t0",
      toTurnId: "t9",
      summary: "  preserves\nwhitespace  ",
      ts: 999_999_999,
      tokens: 1234,
    })
    appendSummary(a, entry)
    expect(a.summaries[0]).toEqual(entry)
  })

  test("appendSummary: ordering preserved (oldest first)", () => {
    const a = createArchive()
    appendSummary(a, sample({ toTurnId: "t1", summary: "first" }))
    appendSummary(a, sample({ fromTurnId: "t1", toTurnId: "t3", summary: "second" }))
    appendSummary(a, sample({ fromTurnId: "t3", toTurnId: "t5", summary: "third" }))
    expect(a.summaries.map((e) => e.summary)).toEqual(["first", "second", "third"])
    // Sliding-window contiguity guard: each fromTurnId == previous toTurnId.
    expect(a.summaries[1]?.fromTurnId).toBe(a.summaries[0]?.toTurnId)
    expect(a.summaries[2]?.fromTurnId).toBe(a.summaries[1]?.toTurnId)
  })

  test("archivedTokens: sums verbatim, empty → 0", () => {
    const a = createArchive()
    expect(archivedTokens(a)).toBe(0)
    appendSummary(a, sample({ tokens: 7 }))
    appendSummary(a, sample({ tokens: 11 }))
    appendSummary(a, sample({ tokens: 3 }))
    expect(archivedTokens(a)).toBe(21)
  })

  test("soft cap (ADR-0075): no eviction at or below MAX_ARCHIVED_SUMMARIES", () => {
    const a = createArchive()
    for (let i = 0; i < MAX_ARCHIVED_SUMMARIES; i++) {
      appendSummary(a, sample({ summary: `s${i}`, tokens: 1 }))
    }
    // Exactly at the cap: nothing dropped, oldest still present.
    expect(a.summaries.length).toBe(MAX_ARCHIVED_SUMMARIES)
    expect(a.summaries[0]?.summary).toBe("s0")
    expect(a.summaries.at(-1)?.summary).toBe(`s${MAX_ARCHIVED_SUMMARIES - 1}`)
    expect(archivedTokens(a)).toBe(MAX_ARCHIVED_SUMMARIES)
  })

  test("soft cap (ADR-0075): evicts oldest FIFO, retains most-recent, accounting stays consistent", () => {
    const a = createArchive()
    const overshoot = 10
    const total = MAX_ARCHIVED_SUMMARIES + overshoot
    for (let i = 0; i < total; i++) {
      // tokens=i so we can verify archivedTokens reflects exactly the retained window.
      appendSummary(a, sample({ summary: `s${i}`, tokens: i }))
    }
    // Holds exactly the cap, never more.
    expect(a.summaries.length).toBe(MAX_ARCHIVED_SUMMARIES)
    // Oldest `overshoot` entries (s0..s9) were evicted (FIFO from the front).
    expect(a.summaries[0]?.summary).toBe(`s${overshoot}`)
    // Most-recent entry — the only one the loop's `.at(-1)` consumer needs — is retained.
    expect(a.summaries.at(-1)?.summary).toBe(`s${total - 1}`)
    // No evicted summary survives.
    expect(a.summaries.some((e) => e.summary === "s0")).toBe(false)
    // Ordering preserved + sliding-window contiguity intact across the window.
    for (let j = 1; j < a.summaries.length; j++) {
      expect(a.summaries[j]?.summary).toBe(`s${overshoot + j}`)
    }
    // Accounting consistent: archivedTokens sums ONLY the retained window
    // (tokens i for i in [overshoot, total)), not the evicted prefix.
    let expected = 0
    for (let i = overshoot; i < total; i++) expected += i
    expect(archivedTokens(a)).toBe(expected)
  })
})

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
})

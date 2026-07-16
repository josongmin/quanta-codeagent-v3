/**
 * DOF-40 fail-closed hardening — the PURE microcompact core must REFUSE
 * out-of-bounds tuning (typed, visible) instead of silently mis-evicting.
 *
 * RED (pre-fix) behaviour the guard replaces (`microcompaction-evict-hellgate`
 * covers the happy path; this file covers the harmful boundary):
 *   - keepRecent <= 0  ⇒ `Math.max(0, keepRecent)` protected NOTHING ⇒ ALL
 *     tool_results evicted incl. the live working set, `changed:true`, no signal.
 *   - keepRecent negative ⇒ silently coerced to 0 ⇒ same.
 *   - keepRecent non-integer ⇒ bogus slice arithmetic.
 *   - tokensSavedFloor = NaN ⇒ `tokensSavedEstimate <= NaN` is ALWAYS false ⇒ the
 *     floor gate is defeated ⇒ commits regardless (unbounded).
 *
 * Fail-closed contract: each of the above now THROWS a typed
 * `MicrocompactTuningError` naming the offending param, so a bad boundary is a
 * VISIBLE refusal, never a silent wrong eviction. A VALID boundary is unchanged.
 */

import { describe, expect, test } from "bun:test"
import {
  MicrocompactTuningError,
  microcompactToolResults,
  validateMicrocompactTuning,
} from "@/agent/tool-result-evict"
import type { Message } from "@/llm"

/** N (tool_use, tool_result) pairs, each result a big dump so the floor is easily
 *  cleared when eviction would fire. */
const bloated = (n: number): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `u${i}`, name: "Read", input: {} }],
    })
    out.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `u${i}`, content: "X".repeat(60_000) }],
    })
  }
  return out
}

const clearedCount = (msgs: readonly Message[]): number =>
  msgs
    .flatMap((m) => m.content)
    .filter(
      (b) => b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]"),
    ).length

describe("DOF-40 microcompact tuning fail-closed (pure core)", () => {
  test("keepRecent=0 REFUSES (typed) — does NOT silently evict the working set", () => {
    const msgs = bloated(4)
    let thrown: unknown
    try {
      microcompactToolResults({ messages: msgs, keepRecent: 0, tokensSavedFloor: 100 })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MicrocompactTuningError)
    expect((thrown as MicrocompactTuningError).param).toBe("keepRecent")
    expect((thrown as MicrocompactTuningError).value).toBe(0)
    // The offending value is IN the message (attributable, not a bare "invalid").
    expect((thrown as Error).message).toContain("keepRecent=0")
    // And nothing was evicted (the throw happened before any scan/clear) — the
    // input array is untouched.
    expect(clearedCount(msgs)).toBe(0)
  })

  test("keepRecent negative REFUSES — no silent Math.max(0,·) coercion to evict-all", () => {
    expect(() =>
      microcompactToolResults({ messages: bloated(4), keepRecent: -5, tokensSavedFloor: 100 }),
    ).toThrow(MicrocompactTuningError)
  })

  test("keepRecent non-integer REFUSES — no bogus slice arithmetic", () => {
    expect(() =>
      microcompactToolResults({ messages: bloated(4), keepRecent: 2.5, tokensSavedFloor: 100 }),
    ).toThrow(MicrocompactTuningError)
  })

  test("tokensSavedFloor=NaN REFUSES — defeats the floor gate (<=NaN always false)", () => {
    let thrown: unknown
    try {
      microcompactToolResults({ messages: bloated(4), keepRecent: 3, tokensSavedFloor: Number.NaN })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MicrocompactTuningError)
    expect((thrown as MicrocompactTuningError).param).toBe("tokensSavedFloor")
  })

  test("tokensSavedFloor negative REFUSES", () => {
    expect(() =>
      microcompactToolResults({ messages: bloated(4), keepRecent: 3, tokensSavedFloor: -1 }),
    ).toThrow(MicrocompactTuningError)
  })

  test("tokensSavedFloor non-integer REFUSES", () => {
    expect(() =>
      microcompactToolResults({ messages: bloated(4), keepRecent: 3, tokensSavedFloor: 3.5 }),
    ).toThrow(MicrocompactTuningError)
  })

  test("VALID tuning is unchanged — real BOUNDED eviction (keeps the working set)", () => {
    const msgs = bloated(5)
    // floor low so the ~13 tokens×3 dumps clear it; keepRecent=2 protects the last 2.
    const r = microcompactToolResults({ messages: msgs, keepRecent: 2, tokensSavedFloor: 100 })
    expect(r.changed).toBe(true)
    // BOUNDED: exactly the older 3 evicted, the last 2 kept (NOT all 5).
    expect(r.toolsCleared).toBe(3)
    expect(clearedCount(r.messages)).toBe(3)
    // The last two tool_results survive verbatim (working set retained).
    const results = r.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result")
    expect(results.at(-1)?.type === "tool_result" && results.at(-1)).toBeTruthy()
    const lastTwoCleared = results
      .slice(-2)
      .filter((b) => b.content.startsWith("[Old tool result content cleared]")).length
    expect(lastTwoCleared).toBe(0)
  })

  test("keepRecent=1 is the minimum VALID boundary (at least one retained)", () => {
    expect(() => validateMicrocompactTuning(1, 0)).not.toThrow()
  })

  test("validateMicrocompactTuning red-on-injection sentinel: guard rejects 0", () => {
    // If the guard were reverted (removed), keepRecent=0 would NOT throw here.
    // Pinning the throw makes a silent-revert go red.
    expect(() => validateMicrocompactTuning(0, 0)).toThrow(MicrocompactTuningError)
  })
})

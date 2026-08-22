/**
 * Hellgate — microcompaction × delta-token counter consistency
 * (RFC jun-6-microcompaction §6.2, the §3.4 key risk pinned).
 *
 * The just-landed delta-token counter memoizes `estimateTokens(snapshot())` and
 * re-anchors ONLY on append/replace/clear/tokenReseed. The eviction wire MUST
 * install the shrunk transcript via `wm.replace(...)` so the counter reseeds and
 * `tokenTotal() === estimateTokens(snapshot())` stays byte-identical.
 *
 * This battery proves:
 *   - install-via-replace ⇒ no drift (the CORRECT path the wire uses)
 *   - an adversarial in-place edit of `wm.messages[i].content` WITHOUT
 *     replace/reseed DRIFTS — documenting WHY the wire must use replace (a guard
 *     against a future "optimize into in-place mutation" regression)
 *   - tokenReseed() after an in-place edit self-heals the drift
 */

import { describe, expect, test } from "bun:test"
import { decorateWithDeltaCounter, estimateTokens } from "@/agent"
import { microcompactToolResults } from "@/agent/tool-result-evict"
import type { Message, ToolResultBlock } from "@/llm"
import { createWorkingMemory } from "@/memory"

const bigBody = (id: string): string => `${id}:${"x".repeat(40_000)}`

const transcript = (n: number): Message[] => {
  const out: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]
  for (let i = 0; i < n; i++) {
    out.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `u${i}`, name: "Read", input: { path: `u${i}` } }],
    })
    out.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `u${i}`, content: bigBody(`u${i}`) }],
    })
  }
  return out
}

describe("microcompaction × delta-token counter", () => {
  test("install via wm.replace ⇒ tokenTotal() === estimateTokens(snapshot()) after eviction", () => {
    const wm = decorateWithDeltaCounter(createWorkingMemory<Message>(transcript(6)))
    // Pre-condition: counter is consistent before eviction.
    expect(wm.tokenTotal()).toBe(estimateTokens([...wm.snapshot()]))

    const r = microcompactToolResults({
      messages: wm.snapshot(),
      keepRecent: 3,
      tokensSavedFloor: 0,
    })
    expect(r.changed).toBe(true)

    // The wire's contract: install via replace (NOT in-place mutation).
    wm.replace([...r.messages])

    // The counter reseeded — byte-identical to a full re-scan of the SHRUNK set.
    expect(wm.tokenTotal()).toBe(estimateTokens([...wm.snapshot()]))
    // And it actually dropped (the eviction freed tokens).
    expect(wm.tokenTotal()).toBeLessThan(estimateTokens(transcript(6)))
  })

  test("ADVERSARIAL: in-place content edit WITHOUT replace/reseed DRIFTS the counter", () => {
    const wm = decorateWithDeltaCounter(createWorkingMemory<Message>(transcript(6)))
    const consistentBefore = wm.tokenTotal() === estimateTokens([...wm.snapshot()])
    expect(consistentBefore).toBe(true)

    // Simulate the BANNED optimization: mutate a tool_result body in place on the
    // live backing buffer, bypassing replace/append/clear/tokenReseed.
    const buf = wm.messages
    for (const m of buf) {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          ;(b as ToolResultBlock).content = "[shrunk in place]"
        }
      }
    }

    // The counter did NOT observe the shrink ⇒ it now OVER-reports and DRIFTS
    // from a fresh re-scan. THIS is exactly why the wire must use wm.replace.
    expect(wm.tokenTotal()).not.toBe(estimateTokens([...wm.snapshot()]))
    expect(wm.tokenTotal()).toBeGreaterThan(estimateTokens([...wm.snapshot()]))
  })

  test("tokenReseed() after an in-place edit self-heals the drift", () => {
    const wm = decorateWithDeltaCounter(createWorkingMemory<Message>(transcript(6)))
    for (const m of wm.messages) {
      for (const b of m.content) {
        if (b.type === "tool_result") (b as ToolResultBlock).content = "[shrunk]"
      }
    }
    expect(wm.tokenTotal()).not.toBe(estimateTokens([...wm.snapshot()]))
    wm.tokenReseed()
    expect(wm.tokenTotal()).toBe(estimateTokens([...wm.snapshot()]))
  })
})

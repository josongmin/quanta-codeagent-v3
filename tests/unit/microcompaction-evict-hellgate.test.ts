/**
 * Hellgate — tier-1 tool-result eviction (RFC jun-6-microcompaction §6.1).
 *
 * The pure pre-pass `microcompactToolResults` clears the BODIES of OLD
 * tool_result blocks (keeping the last N intact) — ZERO LLM cost, ZERO loss of
 * assistant reasoning. This battery pins:
 *   - keeps the last N tool_results byte-identical
 *   - clears older bodies to the placeholder, preserving tool_use_id/is_error,
 *     dropping contentBlocks
 *   - the tokensSaved-floor gate (pass-through == SAME array ref, no spill IO)
 *   - idempotency (second pass no-ops, no double-spill)
 *   - ORPHAN-SAFETY (the headline win): every tool_use keeps its result block
 *   - the original is retrievable from spill, byte-for-byte
 *   - NO-THROW spill failure ⇒ bare-placeholder clear
 *   - image-heavy result counted via the image char estimate
 */

import { describe, expect, test } from "bun:test"
import { estimateTokens } from "@/agent"
import {
  createEvictionSpillPort,
  EVICTED_PLACEHOLDER,
  type EvictionSpillPort,
  microcompactToolResults,
} from "@/agent/tool-result-evict"
import type { Message, ToolResultBlock } from "@/llm"

/** Build a turn pair: assistant tool_use(id) → user tool_result(id, body). */
const toolPair = (id: string, body: string): Message[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { path: id } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: body }] },
]

const bigBody = (id: string): string => `${id}:${"x".repeat(40_000)}`

/** A transcript with `n` tool pairs, each body ~40k chars. */
const transcript = (n: number): Message[] => {
  const out: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]
  for (let i = 0; i < n; i++) out.push(...toolPair(`u${i}`, bigBody(`u${i}`)))
  return out
}

const toolResults = (msgs: readonly Message[]): ToolResultBlock[] => {
  const out: ToolResultBlock[] = []
  for (const m of msgs) for (const b of m.content) if (b.type === "tool_result") out.push(b)
  return out
}

describe("microcompaction tool-result eviction — pure pre-pass", () => {
  test("keeps the last N tool_results intact, clears older to placeholder", () => {
    const messages = transcript(6)
    const r = microcompactToolResults({ messages, keepRecent: 3, tokensSavedFloor: 0 })
    expect(r.changed).toBe(true)
    expect(r.toolsCleared).toBe(3)
    const before = toolResults(messages)
    const after = toolResults(r.messages)
    expect(after.length).toBe(before.length)
    // The 3 oldest are cleared; the 3 newest are byte-identical references.
    for (let i = 0; i < 3; i++) {
      expect(after[i]?.content.startsWith(EVICTED_PLACEHOLDER)).toBe(true)
    }
    for (let i = 3; i < 6; i++) {
      expect(after[i]).toBe(before[i] as ToolResultBlock)
      expect(after[i]?.content).toBe(bigBody(`u${i}`))
    }
  })

  test("cleared block preserves tool_use_id + is_error, drops contentBlocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "uX",
            content: "x".repeat(50_000),
            is_error: true,
            contentBlocks: [{ type: "image", data: "z".repeat(100), mediaType: "image/png" }],
          },
        ],
      },
      ...toolPair("a", "small"),
      ...toolPair("b", "small"),
      ...toolPair("c", "small"),
    ]
    const r = microcompactToolResults({ messages, keepRecent: 3, tokensSavedFloor: 0 })
    expect(r.changed).toBe(true)
    const cleared = toolResults(r.messages)[0] as ToolResultBlock
    expect(cleared.tool_use_id).toBe("uX")
    expect(cleared.is_error).toBe(true)
    expect(cleared.contentBlocks).toBeUndefined()
    expect(cleared.content.startsWith(EVICTED_PLACEHOLDER)).toBe(true)
  })

  test("tokensSaved-floor gate: under floor ⇒ SAME array ref, no spill IO, changed:false", () => {
    let spilled = 0
    const spy: EvictionSpillPort = {
      persist: () => {
        spilled++
        return "ref"
      },
    }
    // Tiny bodies → saving below a high floor.
    const messages: Message[] = [
      ...toolPair("u0", "tiny0"),
      ...toolPair("u1", "tiny1"),
      ...toolPair("u2", "tiny2"),
      ...toolPair("u3", "tiny3"),
    ]
    const r = microcompactToolResults({
      messages,
      keepRecent: 1,
      tokensSavedFloor: 1_000_000,
      spill: spy,
    })
    expect(r.changed).toBe(false)
    expect(r.toolsCleared).toBe(0)
    expect(r.messages).toBe(messages) // exact same reference — no allocation
    expect(spilled).toBe(0) // gate fired BEFORE any spill IO
  })

  test("over floor ⇒ tokensSavedEstimate matches a fresh before-after delta", () => {
    const messages = transcript(6)
    const r = microcompactToolResults({ messages, keepRecent: 3, tokensSavedFloor: 0 })
    expect(r.changed).toBe(true)
    const actual = estimateTokens([...messages]) - estimateTokens([...r.messages])
    // The estimate is honest: within the chars/4 ceil rounding of the real delta.
    expect(Math.abs(r.tokensSavedEstimate - actual)).toBeLessThanOrEqual(1)
  })

  test("idempotent: second pass finds cleared blocks, skips them, no re-spill", () => {
    let spilled = 0
    const spy: EvictionSpillPort = {
      persist: (body) => {
        spilled++
        return `<persisted-output>${body.length}</persisted-output>`
      },
    }
    const messages = transcript(6)
    const first = microcompactToolResults({
      messages,
      keepRecent: 3,
      tokensSavedFloor: 0,
      spill: spy,
    })
    expect(first.changed).toBe(true)
    const spilledAfterFirst = spilled
    const second = microcompactToolResults({
      messages: first.messages,
      keepRecent: 3,
      tokensSavedFloor: 0,
      spill: spy,
    })
    expect(second.changed).toBe(false)
    expect(second.toolsCleared).toBe(0)
    expect(second.messages).toBe(first.messages) // no re-allocation
    expect(spilled).toBe(spilledAfterFirst) // no re-spill
  })

  test("ORPHAN-SAFE: every tool_use still has its paired tool_result (count + ids identical)", () => {
    const messages = transcript(8)
    const r = microcompactToolResults({ messages, keepRecent: 2, tokensSavedFloor: 0 })
    expect(r.changed).toBe(true)

    const collectUseIds = (msgs: readonly Message[]): string[] => {
      const ids: string[] = []
      for (const m of msgs) for (const b of m.content) if (b.type === "tool_use") ids.push(b.id)
      return ids
    }
    const collectResultIds = (msgs: readonly Message[]): string[] => {
      const ids: string[] = []
      for (const m of msgs)
        for (const b of m.content) if (b.type === "tool_result") ids.push(b.tool_use_id)
      return ids
    }
    // The pairing is structurally preserved: same count, same ids, before == after.
    expect(collectUseIds(r.messages)).toEqual(collectUseIds(messages))
    expect(collectResultIds(r.messages)).toEqual(collectResultIds(messages))
    // Every tool_use id has a matching tool_result id (no orphan) — the exact
    // invariant findBoundary's backward-walk exists to protect, here for FREE.
    const resultSet = new Set(collectResultIds(r.messages))
    for (const id of collectUseIds(r.messages)) expect(resultSet.has(id)).toBe(true)
  })

  test("original retrievable from spill, byte-for-byte; cleared body carries the ref", () => {
    const store = new Map<string, string>()
    const spy: EvictionSpillPort = {
      persist: (body, toolUseId) => {
        const path = `/spill/${toolUseId}.txt`
        store.set(path, body)
        return `<persisted-output path="${path}">…</persisted-output>`
      },
    }
    const messages = transcript(4)
    const r = microcompactToolResults({
      messages,
      keepRecent: 1,
      tokensSavedFloor: 0,
      spill: spy,
    })
    expect(r.changed).toBe(true)
    const cleared = toolResults(r.messages)[0] as ToolResultBlock
    expect(cleared.content.startsWith(EVICTED_PLACEHOLDER)).toBe(true)
    const m = cleared.content.match(/path="([^"]+)"/)
    expect(m).not.toBeNull()
    const path = m?.[1] as string
    // Read the persisted original back — byte-for-byte equal to the input body.
    expect(store.get(path)).toBe(bigBody("u0"))
  })

  test("NO-THROW spill failure ⇒ bare-placeholder clear, pre-pass still succeeds", () => {
    const boom: EvictionSpillPort = {
      persist: () => {
        throw new Error("disk full")
      },
    }
    const messages = transcript(4)
    const r = microcompactToolResults({
      messages,
      keepRecent: 1,
      tokensSavedFloor: 0,
      spill: boom,
    })
    expect(r.changed).toBe(true)
    const cleared = toolResults(r.messages)[0] as ToolResultBlock
    expect(cleared.content).toBe(EVICTED_PLACEHOLDER) // degraded to bare placeholder
  })

  test("image-heavy tool_result is counted via the image estimate (floor fires on it)", () => {
    // A tool_result whose `content` string is tiny but carries a heavy image part.
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "img",
            content: "see image", // tiny string
            contentBlocks: [{ type: "image", data: "z".repeat(10), mediaType: "image/png" }],
          },
        ],
      },
      ...toolPair("a", "small"),
    ]
    // String-only saving (9 - 33 < 0) would SKIP; the image estimate (6000 chars)
    // makes the real saving positive, so a floor of ~1000 tokens must still fire.
    const r = microcompactToolResults({ messages, keepRecent: 1, tokensSavedFloor: 100 })
    expect(r.changed).toBe(true)
    expect(r.toolsCleared).toBe(1)
    // ~6000 image chars / 4 ≈ 1500 tokens saved.
    expect(r.tokensSavedEstimate).toBeGreaterThan(1000)
  })

  test("default spill adapter persists the original via an injected writer", () => {
    const writes = new Map<string, string>()
    let n = 0
    const port = createEvictionSpillPort({
      spillDir: "/tmp/spill",
      write: (path, data) => writes.set(path, data),
      fileName: () => `f${n++}.txt`,
      spillFs: { readdir: () => [], mtimeMs: () => 0, remove: () => {} },
    })
    const messages = transcript(4)
    const r = microcompactToolResults({
      messages,
      keepRecent: 1,
      tokensSavedFloor: 0,
      spill: port,
    })
    expect(r.changed).toBe(true)
    // The oldest original was written to the spill dir, byte-for-byte.
    expect(writes.get("/tmp/spill/f0.txt")).toBe(bigBody("u0"))
    const cleared = toolResults(r.messages)[0] as ToolResultBlock
    expect(cleared.content).toContain("/tmp/spill/f0.txt")
  })

  test("C3 (jul-3) — default spill marker carries a best-effort retention caveat", () => {
    // The spill file is bounded by the shared `pruneSpillDir` retention, so a
    // later eviction can GC it before the model reads it. The default marker must
    // tell the model the Read is best-effort so a failed Read of a reclaimed path
    // is not treated as a hard error.
    const port = createEvictionSpillPort({
      spillDir: "/tmp/spill",
      write: () => {},
      fileName: () => "f0.txt",
      spillFs: { readdir: () => [], mtimeMs: () => 0, remove: () => {} },
    })
    const marker = port.persist(bigBody("u0"), "u0")
    expect(marker).toBeDefined()
    // TEETH: pre-C3 the marker had no best-effort caveat.
    expect(marker as string).toContain("best-effort")
    // The path + retrieval instruction are still present (non-regression).
    expect(marker as string).toContain("/tmp/spill/f0.txt")
    expect(marker as string).toContain("Read that file")
  })
})

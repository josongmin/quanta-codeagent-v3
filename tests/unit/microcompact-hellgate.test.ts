/**
 * ★ HELLGATE — ADR-0409 createMicroCompactor.
 *
 * Microcompact is the partial-drop alternative to full compaction. The
 * port's NO-THROW + preserve-system + preserve-recent-turns invariants
 * are the user-facing contract: even adversarial input (null entries,
 * negative ratios, out-of-range numbers) must return a structured result
 * — never throw, never return undefined, always carry provenance with
 * `reason:"microcompact"`.
 */

import { describe, expect, test } from "bun:test"
import { createMicroCompactor } from "@/agent/microcompact"

const fixedNow = () => 1_700_000_000_000
const mk = () => createMicroCompactor({ now: fixedNow })

const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const sysMsg = (text: string) => ({ role: "system", content: [{ type: "text", text }] })
const asstMsg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

describe("createMicroCompactor (ADR-0409) — hellgate", () => {
  test("dropRatio=0 ⇒ messages unchanged + provenance turnsDropped:0", () => {
    const messages = [userMsg("a"), asstMsg("b"), userMsg("c"), asstMsg("d")]
    const r = mk().compact({ messages, threadId: "T", dropRatio: 0 })
    expect(r.messages).toEqual(messages)
    expect(r.turnsDropped).toBe(0)
    expect(r.turnsKept).toBe(4)
    expect(r.provenance.reason).toBe("microcompact")
    expect(r.provenance.turnsDropped).toBe(0)
    expect(r.provenance.compactedAt).toBe(1_700_000_000_000)
  })

  test("dropRatio=1 with no system + preserveRecentTurns=2 ⇒ keeps only protected suffix", () => {
    // 5 user/asst pairs (10 total); preserveRecentTurns=2 ⇒ last 2 always kept.
    // dropRatio=1 ⇒ target = 10, but the droppable window is [0,8) so at most
    // 8 can drop; system-flag default true is irrelevant (no system msgs).
    const messages = [
      userMsg("u1"),
      asstMsg("a1"),
      userMsg("u2"),
      asstMsg("a2"),
      userMsg("u3"),
      asstMsg("a3"),
      userMsg("u4"),
      asstMsg("a4"),
      userMsg("u5"),
      asstMsg("a5"),
    ]
    const r = mk().compact({
      messages,
      threadId: "T",
      dropRatio: 1,
      preserveRecentTurns: 2,
    })
    // dropped = up to 8; turnsKept = 2 protected
    expect(r.turnsKept).toBe(2)
    expect(r.turnsDropped).toBe(8)
    expect(r.messages.length).toBe(2)
    // The last 2 messages survive (in order).
    expect(r.messages[0]).toEqual(messages[8] as { role: string; content: unknown })
    expect(r.messages[1]).toEqual(messages[9] as { role: string; content: unknown })
  })

  test("preserveSystem=true ⇒ system messages NEVER drop, even with dropRatio=1", () => {
    const messages = [
      sysMsg("you are an agent"),
      userMsg("u1"),
      asstMsg("a1"),
      userMsg("u2"),
      asstMsg("a2"),
      userMsg("u3"),
      asstMsg("a3"),
    ]
    const r = mk().compact({
      messages,
      threadId: "T",
      dropRatio: 1,
      preserveRecentTurns: 1,
      preserveSystem: true,
    })
    // System message remains; protected suffix (last 1) remains; everything
    // else in [1, 6) is droppable.
    expect(r.messages[0]).toEqual(messages[0] as { role: string; content: unknown })
    // The very last user message (`a3`) survives as the protected suffix.
    const lastKept = r.messages[r.messages.length - 1]
    expect(lastKept).toEqual(messages[6] as { role: string; content: unknown })
    // Provenance is consistent.
    expect(r.provenance.reason).toBe("microcompact")
    expect(r.turnsKept).toBe(r.messages.length)
  })

  test("preserveRecentTurns >= messages.length ⇒ no drops (protected covers all)", () => {
    const messages = [userMsg("a"), asstMsg("b")]
    const r = mk().compact({
      messages,
      threadId: "T",
      dropRatio: 0.5,
      preserveRecentTurns: 10,
    })
    expect(r.turnsDropped).toBe(0)
    expect(r.messages).toEqual(messages)
  })

  test("malformed input (non-array messages) ⇒ NO-THROW + provenance turnsDropped:0", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate adversarial input
    const bad: any = { messages: "not an array", threadId: "T" }
    const r = mk().compact(bad)
    expect(r.turnsDropped).toBe(0)
    expect(r.provenance.reason).toBe("microcompact")
    expect(r.provenance.turnsDropped).toBe(0)
  })

  test("malformed input (null entry inside array) ⇒ NO-THROW + unchanged", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate adversarial input
    const bad: any = { messages: [userMsg("a"), null, asstMsg("b")], threadId: "T" }
    const r = mk().compact(bad)
    expect(r.turnsDropped).toBe(0)
    expect(r.provenance.turnsDropped).toBe(0)
  })

  test("malformed input (missing role) ⇒ NO-THROW + provenance unchanged", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate adversarial input
    const bad: any = { messages: [{ content: "x" }], threadId: "T" }
    const r = mk().compact(bad)
    expect(r.turnsDropped).toBe(0)
    expect(r.messages.length).toBe(1)
  })

  test("dropRatio out-of-range (negative) ⇒ clamped to 0", () => {
    const messages = [userMsg("a"), asstMsg("b"), userMsg("c"), asstMsg("d")]
    const r = mk().compact({ messages, threadId: "T", dropRatio: -5 })
    expect(r.turnsDropped).toBe(0)
  })

  test("dropRatio out-of-range (above 1) ⇒ clamped to 1", () => {
    const messages = [
      userMsg("u1"),
      asstMsg("a1"),
      userMsg("u2"),
      asstMsg("a2"),
      userMsg("u3"),
      asstMsg("a3"),
    ]
    const r = mk().compact({
      messages,
      threadId: "T",
      dropRatio: 10,
      preserveRecentTurns: 2,
    })
    // Target = floor(6*1) = 6; droppable window = [0, 4); so 4 drop.
    expect(r.turnsDropped).toBe(4)
    expect(r.turnsKept).toBe(2)
  })

  test("dropRatio=NaN ⇒ clamped to 0 (NaN is conservative-end)", () => {
    const messages = [userMsg("a"), asstMsg("b"), userMsg("c"), asstMsg("d")]
    const r = mk().compact({ messages, threadId: "T", dropRatio: Number.NaN })
    expect(r.turnsDropped).toBe(0)
  })

  test("empty messages ⇒ NO-THROW + provenance turnsDropped:0/turnsKept:0", () => {
    const r = mk().compact({ messages: [], threadId: "T", dropRatio: 0.5 })
    expect(r.turnsDropped).toBe(0)
    expect(r.turnsKept).toBe(0)
    expect(r.messages.length).toBe(0)
  })

  test("tokenEstimate provided ⇒ used as tokensBefore in provenance", () => {
    const messages = [userMsg("a"), asstMsg("b"), userMsg("c"), asstMsg("d")]
    const r = mk().compact({
      messages,
      threadId: "T",
      tokenEstimate: 9_999,
      dropRatio: 0,
    })
    expect(r.provenance.tokensBefore).toBe(9_999)
  })

  test("default preserveRecentTurns is 6 (parity with compaction.ts DEFAULT_KEEP_TURNS)", () => {
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}`))
    const r = mk().compact({ messages, threadId: "T", dropRatio: 1 })
    // With default preserveRecentTurns=6, only 2 are droppable.
    expect(r.turnsDropped).toBe(2)
    expect(r.turnsKept).toBe(6)
  })

  test("provenance.compactedAt uses injected `now` (deterministic)", () => {
    const r = mk().compact({ messages: [userMsg("a")], threadId: "T", dropRatio: 0 })
    expect(r.provenance.compactedAt).toBe(1_700_000_000_000)
  })

  test("absent `now` ⇒ defaults to Date.now (still NO-THROW)", () => {
    const compactor = createMicroCompactor()
    const before = Date.now()
    const r = compactor.compact({
      messages: [userMsg("a")],
      threadId: "T",
      dropRatio: 0,
    })
    const after = Date.now()
    expect(r.provenance.compactedAt).toBeGreaterThanOrEqual(before)
    expect(r.provenance.compactedAt).toBeLessThanOrEqual(after)
  })

  test("preserveSystem=false ⇒ system messages CAN drop", () => {
    const messages = [
      sysMsg("you are an agent"),
      userMsg("u1"),
      asstMsg("a1"),
      userMsg("u2"),
      asstMsg("a2"),
    ]
    const r = mk().compact({
      messages,
      threadId: "T",
      dropRatio: 1,
      preserveSystem: false,
      preserveRecentTurns: 1,
    })
    // The system message at index 0 is now in the droppable window — it drops.
    expect(r.messages[0]?.role).not.toBe("system")
    expect(r.turnsKept).toBe(1)
  })
})

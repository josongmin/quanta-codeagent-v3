/**
 * HELLGATE — ADR-0323 `WorkingMemory` adapter for `HistorySanitizationPort`.
 *
 * Drives the adapter through its full failure-mode + happy-path matrix.
 * Codex parity surface (turn.rs:363-371) is the spec; the multi-message
 * `replaceLastNMessagesImages` extension is the quanta-specific arm.
 *
 * Coverage:
 *   - empty wm → empty result
 *   - 0 images in last turn → no mutation
 *   - 1 image block in last turn → 1 replaced
 *   - multiple image blocks in last turn → all replaced, positions preserved
 *   - tool_result.contentBlocks inner images → counted + replaced
 *   - earlier turn untouched when replaceLastTurnImages called
 *   - replaceLastNMessagesImages(2) walks tail of length 2
 *   - placeholder string passed through verbatim
 *   - all closed-enum SanitizationReason variants accepted
 *   - document block treated identically to image block
 *   - idempotent: second call after first replaces 0
 *   - thinking blocks preserved (signature/redacted untouched)
 *   - NO-THROW: malformed message survives, returns empty result
 *   - n <= 0 short-circuits
 *   - n > length scrubs the whole buffer
 */

import { describe, expect, test } from "bun:test"

import { createWorkingMemory, type WorkingMemory } from "../../working"
import { SANITIZATION_REASONS, type SanitizationReason } from "../types"
import { createWorkingMemoryHistorySanitization } from "../working-memory-adapter"

// Minimal structural shapes matching @/llm/types.ts. Local copies to keep the
// test slice-fence-clean (no @/llm import from a memory test — same posture
// the production code holds).
interface TextBlock {
  type: "text"
  text: string
}
interface ImageBlock {
  type: "image"
  data: string
  mediaType: string
}
interface DocumentBlock {
  type: "document"
  data: string
  mediaType: string
}
interface ThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
  redacted?: true
}
interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
}
interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string
  contentBlocks?: ReadonlyArray<TextBlock | ImageBlock | DocumentBlock>
  is_error?: boolean
}

type Block = TextBlock | ImageBlock | DocumentBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock

interface Msg {
  role: "user" | "assistant"
  content: Block[]
}

const PLACEHOLDER = "Invalid image"

const newWm = (msgs: Msg[]): WorkingMemory<Msg> => createWorkingMemory<Msg>(msgs)

const userText = (text: string): Msg => ({
  role: "user",
  content: [{ type: "text", text }],
})

const userImage = (...n: number[]): Msg => ({
  role: "user",
  content: n.map((i): ImageBlock => ({ type: "image", data: `img-${i}`, mediaType: "image/png" })),
})

describe("HELLGATE — history-sanitization working-memory adapter", () => {
  test("empty buffer → empty result", () => {
    const wm = newWm([])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 0, wasMutated: false })
    expect(wm.snapshot()).toEqual([])
  })

  test("0 images in last turn → no mutation", () => {
    const wm = newWm([userText("hi"), userText("bye")])
    const before = wm.snapshot()
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 0, wasMutated: false })
    // Buffer is identity-preserved (no replace call).
    expect(wm.snapshot()).toEqual(before)
  })

  test("1 image in last turn → 1 replaced, content rewritten", () => {
    const wm = newWm([userText("first"), userImage(1)])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 1, wasMutated: true })
    const snap = wm.snapshot()
    expect(snap.length).toBe(2)
    expect(snap[0]?.content).toEqual([{ type: "text", text: "first" }])
    expect(snap[1]?.content).toEqual([{ type: "text", text: PLACEHOLDER }])
  })

  test("multiple images in last turn → all replaced, count = N, positions preserved", () => {
    const wm = newWm([
      userText("first"),
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "a", mediaType: "image/png" },
          { type: "image", data: "b", mediaType: "image/jpeg" },
          { type: "text", text: "and" },
          { type: "image", data: "c", mediaType: "image/webp" },
        ],
      },
    ])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 3, wasMutated: true })
    const last = wm.snapshot()[1]
    expect(last?.content).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: PLACEHOLDER },
      { type: "text", text: PLACEHOLDER },
      { type: "text", text: "and" },
      { type: "text", text: PLACEHOLDER },
    ])
  })

  test("tool_result.contentBlocks inner images → counted + replaced, container cloned", () => {
    const trMsg: Msg = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "u1",
          content: "see image",
          contentBlocks: [
            { type: "text", text: "see image" },
            { type: "image", data: "i1", mediaType: "image/png" },
            { type: "image", data: "i2", mediaType: "image/jpeg" },
          ],
        },
      ],
    }
    const wm = newWm([trMsg])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 2, wasMutated: true })
    const snap = wm.snapshot()
    const tr = snap[0]?.content[0] as ToolResultBlock
    expect(tr.type).toBe("tool_result")
    expect(tr.tool_use_id).toBe("u1")
    expect(tr.content).toBe("see image")
    expect(tr.contentBlocks).toEqual([
      { type: "text", text: "see image" },
      { type: "text", text: PLACEHOLDER },
      { type: "text", text: PLACEHOLDER },
    ])
    // Original block object must not be aliased (snapshot caller from earlier
    // could still hold the pre-mutation reference; we must not have mutated
    // it in place).
    expect(snap[0]?.content[0]).not.toBe(trMsg.content[0])
  })

  test("earlier turn untouched when only last turn is scrubbed", () => {
    const wm = newWm([userImage(1, 2), userImage(3)])
    const before = wm.snapshot()
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 1, wasMutated: true })
    const after = wm.snapshot()
    // First message identity preserved (we did not clone an untouched msg).
    expect(after[0]).toBe(before[0])
    // Last message content fully scrubbed.
    expect(after[1]?.content).toEqual([{ type: "text", text: PLACEHOLDER }])
  })

  test("replaceLastNMessagesImages(2) walks the last two messages", () => {
    const wm = newWm([userText("oldest"), userImage(1), userImage(2, 3)])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastNMessagesImages(2, "invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 3, wasMutated: true })
    const snap = wm.snapshot()
    expect(snap[0]?.content).toEqual([{ type: "text", text: "oldest" }])
    expect(snap[1]?.content).toEqual([{ type: "text", text: PLACEHOLDER }])
    expect(snap[2]?.content).toEqual([
      { type: "text", text: PLACEHOLDER },
      { type: "text", text: PLACEHOLDER },
    ])
  })

  test("placeholder string passed verbatim (incl. unicode + empty)", () => {
    const wm = newWm([userImage(1)])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", "日本語 PLACEHOLDER 🚫")
    expect(r.wasMutated).toBe(true)
    expect(wm.snapshot()[0]?.content[0]).toEqual({
      type: "text",
      text: "日本語 PLACEHOLDER 🚫",
    })

    // Empty placeholder is still a valid text block — caller's responsibility.
    const wm2 = newWm([userImage(1)])
    const port2 = createWorkingMemoryHistorySanitization(wm2)
    const r2 = port2.replaceLastTurnImages("invalid_image", "")
    expect(r2.wasMutated).toBe(true)
    expect(wm2.snapshot()[0]?.content[0]).toEqual({ type: "text", text: "" })
  })

  test("all closed-enum SanitizationReason variants accepted (3 variants)", () => {
    expect(SANITIZATION_REASONS.length).toBe(3)
    for (const reason of SANITIZATION_REASONS) {
      const wm = newWm([userImage(1)])
      const port = createWorkingMemoryHistorySanitization(wm)
      const r = port.replaceLastTurnImages(reason satisfies SanitizationReason, PLACEHOLDER)
      expect(r).toEqual({ replacedCount: 1, wasMutated: true })
    }
  })

  test("document block treated identically to image block", () => {
    const wm = newWm([
      {
        role: "user",
        content: [
          { type: "document", data: "pdf1", mediaType: "application/pdf" },
          { type: "text", text: "see attached" },
          { type: "document", data: "pdf2", mediaType: "application/pdf" },
        ],
      },
    ])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("oversize", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 2, wasMutated: true })
    expect(wm.snapshot()[0]?.content).toEqual([
      { type: "text", text: PLACEHOLDER },
      { type: "text", text: "see attached" },
      { type: "text", text: PLACEHOLDER },
    ])
  })

  test("idempotent: second call after first replaces 0 (placeholder is plain text)", () => {
    const wm = newWm([userImage(1, 2)])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r1 = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r1).toEqual({ replacedCount: 2, wasMutated: true })
    const r2 = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r2).toEqual({ replacedCount: 0, wasMutated: false })
  })

  test("thinking + tool_use blocks preserved unchanged", () => {
    const thinking: ThinkingBlock = {
      type: "thinking",
      thinking: "private reasoning",
      signature: "sig-abc",
    }
    const toolUse: ToolUseBlock = {
      type: "tool_use",
      id: "tu1",
      name: "read_file",
      input: { path: "a.ts" },
    }
    const wm = newWm([
      {
        role: "assistant",
        content: [
          thinking,
          { type: "text", text: "I'll look at this image:" },
          { type: "image", data: "x", mediaType: "image/png" },
          toolUse,
        ],
      },
    ])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 1, wasMutated: true })
    const out = wm.snapshot()[0]?.content as Block[]
    // thinking block byte-identical (signature preserved)
    expect(out[0]).toEqual(thinking)
    expect(out[1]).toEqual({ type: "text", text: "I'll look at this image:" })
    expect(out[2]).toEqual({ type: "text", text: PLACEHOLDER })
    expect(out[3]).toEqual(toolUse)
  })

  test("NO-THROW: malformed message (non-array content) returns empty result", () => {
    // Build a buffer with a broken message shape; the port must not throw.
    const wm = newWm([
      { role: "user", content: "not-an-array" as unknown as Block[] },
      { role: "user", content: [{ type: "image", data: "x", mediaType: "image/png" }] },
    ])
    const port = createWorkingMemoryHistorySanitization(wm)
    // Last message has 1 image → scrub succeeds; the malformed earlier one is
    // skipped, never thrown on.
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 1, wasMutated: true })
    expect(wm.snapshot()[1]?.content).toEqual([{ type: "text", text: PLACEHOLDER }])

    // And the malformed-only buffer must return empty (still no throw).
    const wm2 = newWm([{ role: "user", content: null as unknown as Block[] }])
    const port2 = createWorkingMemoryHistorySanitization(wm2)
    const r2 = port2.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r2).toEqual({ replacedCount: 0, wasMutated: false })
  })

  test("replaceLastNMessagesImages: n <= 0 or NaN short-circuits", () => {
    const wm = newWm([userImage(1)])
    const port = createWorkingMemoryHistorySanitization(wm)
    expect(port.replaceLastNMessagesImages(0, "invalid_image", PLACEHOLDER)).toEqual({
      replacedCount: 0,
      wasMutated: false,
    })
    expect(port.replaceLastNMessagesImages(-1, "invalid_image", PLACEHOLDER)).toEqual({
      replacedCount: 0,
      wasMutated: false,
    })
    expect(port.replaceLastNMessagesImages(Number.NaN, "invalid_image", PLACEHOLDER)).toEqual({
      replacedCount: 0,
      wasMutated: false,
    })
    // Original buffer must still hold the image — short-circuit means no swap.
    expect(wm.snapshot()[0]?.content[0]).toEqual({
      type: "image",
      data: "img-1",
      mediaType: "image/png",
    })
  })

  test("replaceLastNMessagesImages: n > length scrubs the whole buffer", () => {
    const wm = newWm([userImage(1), userImage(2)])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastNMessagesImages(999, "invalid_image", PLACEHOLDER)
    expect(r).toEqual({ replacedCount: 2, wasMutated: true })
    const snap = wm.snapshot()
    expect(snap[0]?.content).toEqual([{ type: "text", text: PLACEHOLDER }])
    expect(snap[1]?.content).toEqual([{ type: "text", text: PLACEHOLDER }])
  })

  // ─── ADR-0337 snapshotMessages accessor ────────────────────────────────
  test("snapshotMessages: empty wm ⇒ []", () => {
    const wm = newWm([])
    const port = createWorkingMemoryHistorySanitization(wm)
    expect(port.snapshotMessages()).toEqual([])
  })

  test("snapshotMessages: multi-turn buffer returns exact tail", () => {
    const msgs: Msg[] = [userText("first"), userImage(1), userText("third")]
    const wm = newWm(msgs)
    const port = createWorkingMemoryHistorySanitization(wm)
    const snap = port.snapshotMessages()
    expect(snap.length).toBe(3)
    // Element identity preserved (snapshot is shallow copy).
    expect(snap[0]).toBe(msgs[0])
    expect(snap[1]).toBe(msgs[1])
    expect(snap[2]).toBe(msgs[2])
  })

  test("snapshotMessages: reflects the POST-sanitize buffer after replaceLastTurnImages", () => {
    const wm = newWm([userText("first"), userImage(1)])
    const port = createWorkingMemoryHistorySanitization(wm)
    const r = port.replaceLastTurnImages("invalid_image", PLACEHOLDER)
    expect(r.wasMutated).toBe(true)
    const snap = port.snapshotMessages()
    // The image-bearing message is now a text-placeholder message.
    expect(snap.length).toBe(2)
    expect((snap[1] as Msg).content).toEqual([{ type: "text", text: PLACEHOLDER }])
  })

  test("snapshotMessages: shallow-copy semantics — mutating the result does not poison the wm", () => {
    const msgs: Msg[] = [userText("a"), userText("b")]
    const wm = newWm(msgs)
    const port = createWorkingMemoryHistorySanitization(wm)
    const snap = port.snapshotMessages()
    // The returned array is readonly per the type. To prove the wm-internal
    // backing isn't aliased, cast and splice; subsequent snapshotMessages
    // must still return the original 2-element view.
    ;(snap as unknown as Msg[]).splice(0, snap.length)
    const refetch = port.snapshotMessages()
    expect(refetch.length).toBe(2)
  })

  test("snapshotMessages: NO-THROW — degenerate wm-like adapter throwing snapshot returns []", () => {
    // Construct a hostile WorkingMemory-shaped object that throws from snapshot().
    // This proves the `safeSnapshot` swallow shim in the adapter holds.
    const hostile = {
      messages: [] as Msg[],
      snapshot(): readonly Msg[] {
        throw new Error("simulated wm crash")
      },
      append(_m: Msg) {},
      replace(_m: Msg[]) {},
      get(_i: number): Msg | undefined {
        return undefined
      },
    } as unknown as WorkingMemory<Msg>
    const port = createWorkingMemoryHistorySanitization(hostile)
    expect(port.snapshotMessages()).toEqual([])
  })

  test("snapshotMessages: type widening — returned shape is structural SanitizationMessageLike", () => {
    // Compile-time check that the port's return type is widened structurally
    // (role: string, content: unknown). Runtime: assert role/content presence.
    const wm = newWm([userImage(1, 2)])
    const port = createWorkingMemoryHistorySanitization(wm)
    const snap = port.snapshotMessages()
    expect(snap.length).toBe(1)
    const first = snap[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    expect(typeof first.role).toBe("string")
    expect(first.content).toBeDefined()
  })
})

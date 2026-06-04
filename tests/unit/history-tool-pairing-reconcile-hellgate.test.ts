/**
 * HELLGATE — B4 (jun-04) resume-boundary `tool_use`↔`tool_result` reconciliation.
 *
 * `reconcileToolPairing` makes a transcript freshly loaded from disk
 * (resume/fork/rewind) model-valid for BOTH Anthropic and OpenAI before it is
 * re-sent: every `tool_use` (assistant, block `id`) MUST have a following
 * `tool_result` (block `tool_use_id`), and every `tool_result` MUST reference a
 * PRECEDING `tool_use`.
 *
 * Design under test:
 *   - orphan `tool_use` (no result after)        → SYNTHESIZE a stub result.
 *   - orphan `tool_result` (no preceding use)     → DROP the block (+ drop the
 *                                                    message if it emptied).
 *   - already-valid transcript                    → SAME array reference.
 *   - PURE / NO-THROW / order-preserving.
 *
 * Slice-fence: local structural block shapes (no `@/llm` import from a test in
 * the memory axis — same posture the production module holds).
 */

import { describe, expect, test } from "bun:test"

import { RECONCILE_PLACEHOLDER_TEXT, reconcileToolPairing } from "@/memory/history-sanitization"

// ---- structural shapes (mirror @/llm/types.ts, no import) ----
interface TextBlock {
  type: "text"
  text: string
}
interface ImageBlock {
  type: "image"
  data: string
  mediaType: string
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
  is_error?: boolean
}
type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock
interface Msg {
  readonly role: string
  readonly content: Block[] | string
}

// ---- builders ----
const text = (t: string): TextBlock => ({ type: "text", text: t })
const image = (d: string): ImageBlock => ({ type: "image", data: d, mediaType: "image/png" })
const use = (id: string, name = "shell"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input: { cmd: "ls" },
})
const result = (id: string, content = "ok"): ToolResultBlock => ({
  type: "tool_result",
  tool_use_id: id,
  content,
})
const asst = (...content: Block[]): Msg => ({ role: "assistant", content })
const user = (...content: Block[]): Msg => ({ role: "user", content })

// ---- model-validity oracle: independent re-implementation of the rule ----
/** Flatten tool blocks to an ordered `(kind,id)` stream. */
const flattenTool = (messages: readonly Msg[]): Array<{ kind: "use" | "result"; id: string }> => {
  const flat: Array<{ kind: "use" | "result"; id: string }> = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === "tool_use") flat.push({ kind: "use", id: b.id })
      else if (b.type === "tool_result") flat.push({ kind: "result", id: b.tool_use_id })
    }
  }
  return flat
}

/** Assert the OUTPUT is model-valid: every tool_use has a downstream result,
 *  every result has a preceding use, no empty-content message. Independent of
 *  the production scan so a bug in production cannot mask itself. */
const assertModelValid = (messages: readonly Msg[]): void => {
  for (const m of messages) {
    if (Array.isArray(m.content)) expect(m.content.length).toBeGreaterThan(0)
  }
  const flat = flattenTool(messages)
  const useIds = flat.filter((e) => e.kind === "use").map((e) => e.id)
  const resultIds = flat.filter((e) => e.kind === "result").map((e) => e.id)
  for (const id of useIds) expect(resultIds).toContain(id) // use → result
  for (const id of resultIds) expect(useIds).toContain(id) // result → use
  for (const id of new Set(useIds)) {
    // ordering: each use precedes its (first) result
    const useAt = flat.findIndex((e) => e.kind === "use" && e.id === id)
    const resAt = flat.findIndex((e) => e.kind === "result" && e.id === id)
    expect(useAt).toBeGreaterThanOrEqual(0)
    expect(resAt).toBeGreaterThan(useAt)
  }
}

describe("reconcileToolPairing — B4 resume-boundary tool-pair reconciliation", () => {
  // (a) tool_use with no matching tool_result → reconciled valid, no orphan use
  test("(a) orphan tool_use is satisfied by a synthesized stub result", () => {
    const input: Msg[] = [user(text("run ls")), asst(text("sure"), use("u1"))]
    const out = reconcileToolPairing(input) as Msg[]
    assertModelValid(out)
    // assistant text + use preserved, stub appended as a user message after it
    expect(out.length).toBe(3)
    const stub = out[2]
    expect(stub.role).toBe("user")
    const stubBlocks = stub.content as Block[]
    expect(stubBlocks.length).toBe(1)
    const sr = stubBlocks[0] as ToolResultBlock
    expect(sr.type).toBe("tool_result")
    expect(sr.tool_use_id).toBe("u1")
    expect(sr.is_error).toBe(true)
    expect(sr.content).toBe(RECONCILE_PLACEHOLDER_TEXT)
    // the orphan use's surrounding text is untouched (not dropped)
    expect((out[1].content as Block[])[0]).toEqual(text("sure"))
  })

  // (b) tool_result with no preceding tool_use → dropped
  test("(b) orphan tool_result (no preceding use) is dropped", () => {
    const input: Msg[] = [user(text("hi")), user(text("ctx"), result("ghost"))]
    const out = reconcileToolPairing(input) as Msg[]
    assertModelValid(out)
    // the ghost result is gone; the surrounding text survives
    const second = out[1].content as Block[]
    expect(second.some((b) => b.type === "tool_result")).toBe(false)
    expect(second).toContainEqual(text("ctx"))
  })

  test("(b2) message that is ONLY an orphan result is dropped entirely", () => {
    const input: Msg[] = [user(text("hi")), user(result("ghost"))]
    const out = reconcileToolPairing(input) as Msg[]
    assertModelValid(out)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(input[0]) // surviving message identity preserved
  })

  // (c) correctly-paired transcript → byte-identical (same reference)
  test("(c) valid transcript returns the SAME array + message references", () => {
    const input: Msg[] = [
      user(text("run ls")),
      asst(text("ok"), use("u1")),
      user(result("u1", "files...")),
      asst(text("done")),
    ]
    const out = reconcileToolPairing(input)
    expect(out).toBe(input) // same top-level reference — zero allocation
    for (let i = 0; i < input.length; i++) expect(out[i]).toBe(input[i])
    assertModelValid(out as Msg[])
  })

  // (d) interleaved / multiple pairs, some orphaned → only orphans fixed
  test("(d) interleaved pairs: valid ones preserved in order, only orphans fixed", () => {
    const input: Msg[] = [
      asst(use("a")), // valid pair below
      user(result("a")),
      asst(text("mid"), use("b")), // ORPHAN use (no result)
      user(text("note"), result("ghost")), // ORPHAN result (dropped) + text kept
      asst(use("c")), // valid pair below
      user(result("c")),
    ]
    const out = reconcileToolPairing(input) as Msg[]
    assertModelValid(out)
    // valid pairs a + c keep their real results
    const allBlocks = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    const resultsFor = (id: string) =>
      allBlocks.filter((b) => b.type === "tool_result" && (b as ToolResultBlock).tool_use_id === id)
    expect(resultsFor("a").length).toBe(1)
    expect((resultsFor("a")[0] as ToolResultBlock).content).toBe("ok") // real, not stub
    expect(resultsFor("c").length).toBe(1)
    expect((resultsFor("c")[0] as ToolResultBlock).content).toBe("ok")
    // orphan b got exactly one stub
    expect(resultsFor("b").length).toBe(1)
    expect((resultsFor("b")[0] as ToolResultBlock).is_error).toBe(true)
    // ghost result gone
    expect(resultsFor("ghost").length).toBe(0)
    // "note" text survived the orphan-result drop
    expect(allBlocks).toContainEqual(text("note"))
    // "mid" narration before orphan use survived
    expect(allBlocks).toContainEqual(text("mid"))
  })

  // (e) non-tool content untouched
  test("(e) text + image content is passed through untouched", () => {
    const input: Msg[] = [user(text("look"), image("BYTES")), asst(text("nice picture"))]
    const out = reconcileToolPairing(input)
    expect(out).toBe(input)
    for (let i = 0; i < input.length; i++) expect(out[i]).toBe(input[i])
  })

  test("(e2) string-content messages are passed through (no array to walk)", () => {
    const input: Msg[] = [{ role: "user", content: "plain string" }]
    const out = reconcileToolPairing(input)
    expect(out).toBe(input)
  })

  // (f) empty / edge inputs no-throw
  test("(f) empty / null / malformed inputs never throw, return safe value", () => {
    expect(reconcileToolPairing([])).toEqual([])
    // malformed blocks: missing ids, non-object blocks
    const malformed: Msg[] = [
      { role: "assistant", content: [{ type: "tool_use" } as unknown as ToolUseBlock] },
      { role: "user", content: [null as unknown as Block, 42 as unknown as Block] },
    ]
    expect(() => reconcileToolPairing(malformed)).not.toThrow()
    // tool_use with a non-string id is NOT treated as a real use (no stub spawned)
    const out = reconcileToolPairing(malformed) as Msg[]
    const stubs = out
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => !!b && typeof b === "object" && b.type === "tool_result")
    expect(stubs.length).toBe(0)
  })

  test("(f2) result that PRECEDES its use is treated as orphan-result + orphan-use", () => {
    // result for "x" appears before any use of "x"; then a use of "x" appears.
    const input: Msg[] = [
      user(result("x")), // orphan result (no preceding use) → dropped
      asst(use("x")), // orphan use (its only result was before it) → stub
    ]
    const out = reconcileToolPairing(input) as Msg[]
    assertModelValid(out)
    const blocks = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    const xResults = blocks.filter(
      (b) => b.type === "tool_result" && (b as ToolResultBlock).tool_use_id === "x",
    )
    expect(xResults.length).toBe(1)
    expect((xResults[0] as ToolResultBlock).is_error).toBe(true) // the stub, not the dropped pre-result
  })

  test("(f3) multiple orphan uses in ONE assistant message each get a stub", () => {
    const input: Msg[] = [asst(use("p"), use("q"))]
    const out = reconcileToolPairing(input) as Msg[]
    assertModelValid(out)
    expect(out.length).toBe(2)
    const stubBlocks = out[1].content as Block[]
    expect(stubBlocks.length).toBe(2)
    expect((stubBlocks[0] as ToolResultBlock).tool_use_id).toBe("p")
    expect((stubBlocks[1] as ToolResultBlock).tool_use_id).toBe("q")
  })

  test("(f4) partial pair in a multi-use message: one satisfied, one stubbed", () => {
    const input: Msg[] = [
      asst(use("p"), use("q")), // p gets a real result, q does not
      user(result("p")),
    ]
    const out = reconcileToolPairing(input) as Msg[]
    assertModelValid(out)
    const blocks = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    const pRes = blocks.filter(
      (b) => b.type === "tool_result" && (b as ToolResultBlock).tool_use_id === "p",
    )
    const qRes = blocks.filter(
      (b) => b.type === "tool_result" && (b as ToolResultBlock).tool_use_id === "q",
    )
    expect(pRes.length).toBe(1)
    expect((pRes[0] as ToolResultBlock).content).toBe("ok") // real
    expect(qRes.length).toBe(1)
    expect((qRes[0] as ToolResultBlock).is_error).toBe(true) // stub
  })
})

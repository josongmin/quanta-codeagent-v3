import { describe, expect, test } from "bun:test"
import { LlmPhase2Port } from "../../../src/memory/consolidate/phase2-llm"
import { Phase2ConsolidateError } from "../../../src/memory/consolidate/types"

const llmReply = [
  "<MEMORY_MD>",
  "# Memory",
  "</MEMORY_MD>",
  "<RAW_MEMORIES_MD>",
  "- raw",
  "</RAW_MEMORIES_MD>",
  "<MEMORY_SUMMARY_MD>",
  "summary",
  "</MEMORY_SUMMARY_MD>",
].join("\n")

describe("LlmPhase2Port", () => {
  test("threads caller signal through to the summarizer", async () => {
    const ac = new AbortController()
    let observed: AbortSignal | undefined
    const port = new LlmPhase2Port(async (args) => {
      observed = args.signal
      return { text: llmReply, tokensUsed: 7 }
    })
    const out = await port.consolidate({
      stage1Entries: [],
      existingMemoryMd: null,
      existingRawMemoriesMd: null,
      mode: "INIT",
      signal: ac.signal,
    })
    expect(observed).toBe(ac.signal)
    expect(out.tokensUsed).toBe(7)
  })

  test("AbortError from summarizer propagates unchanged", async () => {
    const aborted = new Error("cancelled")
    aborted.name = "AbortError"
    const port = new LlmPhase2Port(async () => {
      throw aborted
    })
    const err = await port
      .consolidate({
        stage1Entries: [],
        existingMemoryMd: null,
        existingRawMemoriesMd: null,
        mode: "incremental",
        signal: new AbortController().signal,
      })
      .catch((e: unknown) => e)
    expect(err).toBe(aborted)
  })

  test("non-abort summarizer errors still wrap in Phase2ConsolidateError", async () => {
    const port = new LlmPhase2Port(async () => {
      throw new Error("llm down")
    })
    const err = await port
      .consolidate({
        stage1Entries: [],
        existingMemoryMd: null,
        existingRawMemoriesMd: null,
        mode: "INIT",
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Phase2ConsolidateError)
    expect((err as Error).message).toContain("llm down")
  })
})

import { describe, expect, test } from "bun:test"
import { LlmPhase2Port } from "../../../src/memory/consolidate/phase2-llm"

/**
 * Hellgate — DATA-LOSS regression (ADR-0068).
 *
 * Bug: `buildUserMessage` gated inclusion of the prior `raw_memories.md`
 * on `mode === "incremental"`. An INIT / full-rebuild therefore NEVER showed
 * the LLM the prior append-only evidence trail; the subsequent
 * `writeAtomic` would then overwrite the file — silently destroying the
 * documented INIT source of truth.
 *
 * The adversarial case that would have caught it: run a full rebuild (INIT,
 * zero new stage1 entries) with a non-null prior raw trail and assert the
 * trail reaches the LLM prompt. Before the fix, it did not.
 */

const TRIPLE = [
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

const PRIOR_RAW = "- 2026-05-01 decided to keep append-only evidence trail INTACT (sentinel-XYZ)"

describe("LlmPhase2Port INIT raw-trail inclusion (hellgate)", () => {
  test("INIT full-rebuild surfaces the prior raw_memories.md trail to the LLM", async () => {
    let userText = ""
    const port = new LlmPhase2Port(async (args) => {
      userText = args.userText
      return { text: TRIPLE }
    })
    await port.consolidate({
      stage1Entries: [],
      existingMemoryMd: null,
      existingRawMemoriesMd: PRIOR_RAW,
      mode: "INIT",
    })
    // The verbatim prior evidence MUST be in the prompt; otherwise the
    // writer rebuilds from nothing and the trail is destroyed.
    expect(userText).toContain(PRIOR_RAW)
    // Heading is branched by mode but the content is always appended.
    expect(userText).toContain("## Prior raw_memories.md")
  })

  test("incremental still surfaces the prior raw trail (no regression on the original path)", async () => {
    let userText = ""
    const port = new LlmPhase2Port(async (args) => {
      userText = args.userText
      return { text: TRIPLE }
    })
    await port.consolidate({
      stage1Entries: [],
      existingMemoryMd: null,
      existingRawMemoriesMd: PRIOR_RAW,
      mode: "incremental",
    })
    expect(userText).toContain(PRIOR_RAW)
    expect(userText).toContain("extend in incremental mode")
  })

  test("null prior raw trail emits no raw-memories section in either mode", async () => {
    for (const mode of ["INIT", "incremental"] as const) {
      let userText = ""
      const port = new LlmPhase2Port(async (args) => {
        userText = args.userText
        return { text: TRIPLE }
      })
      await port.consolidate({
        stage1Entries: [],
        existingMemoryMd: null,
        existingRawMemoriesMd: null,
        mode,
      })
      expect(userText).not.toContain("## Prior raw_memories.md")
    }
  })
})

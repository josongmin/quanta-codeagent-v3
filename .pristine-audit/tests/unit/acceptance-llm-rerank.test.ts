/**
 * Bridge: AcceptanceScored[] → pure LLM selector (chooser/reviewer) → chosen index.
 * Verifies the mapping (id = scored index, touchedFiles parsed from the diff) and
 * that fail-open / never-veto propagate from the pure cores through the bridge.
 */

import { describe, expect, test } from "bun:test"
import { buildAcceptanceLlmRerank } from "../../src/runner/batch/eval/acceptance-llm-rerank"
import type { AcceptanceScored } from "../../src/runner/batch/eval/acceptance-select"

const scored = (index: number, file: string): AcceptanceScored => ({
  index,
  patch: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`,
  patchKey: file,
  reproPass: false,
  regressionFailures: 0,
})

describe("buildAcceptanceLlmRerank", () => {
  test("chooser: returns the model-chosen scored index", async () => {
    const admissible = [scored(0, "a.py"), scored(2, "c.py")]
    const rerank = buildAcceptanceLlmRerank("chooser", "the bug", async () => "BEST: 2")
    expect(await rerank(admissible)).toBe(2)
  })

  test("chooser prompt carries the candidate diff + touched files", async () => {
    let prompt = ""
    const rerank = buildAcceptanceLlmRerank("chooser", "ISSUE-TEXT", async (p) => {
      prompt = p
      return "BEST: 0"
    })
    await rerank([scored(0, "pkg/mod.py"), scored(1, "pkg/other.py")])
    expect(prompt).toContain("ISSUE-TEXT")
    expect(prompt).toContain("pkg/mod.py") // touchedFiles parsed from the diff header
    expect(prompt).toContain("candidate 0")
    expect(prompt).toContain("candidate 1")
  })

  test("reviewer: highest score wins, mapped to the scored index", async () => {
    const admissible = [scored(0, "a.py"), scored(3, "b.py")]
    const rerank = buildAcceptanceLlmRerank("reviewer", "bug", async (p) =>
      p.includes("candidate 3") ? "SCORE: 0.9" : "SCORE: 0.1",
    )
    expect(await rerank(admissible)).toBe(3)
  })

  test("fail-open: unparseable chooser response ⇒ null (deterministic stands)", async () => {
    const rerank = buildAcceptanceLlmRerank("chooser", "bug", async () => "no idea")
    expect(await rerank([scored(0, "a.py"), scored(1, "b.py")])).toBeNull()
  })

  test("fail-open: throwing ask ⇒ null", async () => {
    const rerank = buildAcceptanceLlmRerank("chooser", "bug", async () => {
      throw new Error("down")
    })
    expect(await rerank([scored(0, "a.py"), scored(1, "b.py")])).toBeNull()
  })
})

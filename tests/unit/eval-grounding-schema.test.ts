import { describe, expect, test } from "bun:test"
import { loadGroundingCases, parseGroundingCase } from "@/../src/apps/eval/grounding"

describe("grounding schema", () => {
  test("parses a valid minimal case", () => {
    const parsed = parseGroundingCase({
      schema: 1,
      id: "sample",
      usecase: "persistent-context.conversation-state.thread-grounding",
      history: [{ role: "assistant", text: "Active thread prompt_rules." }],
      targetUtterance: "이제 다 됐냐?",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      bucket: "ellipsis",
      severity: "critical",
    })
    expect(parsed.id).toBe("sample")
    expect(parsed.gold.intent).toBe("status_check")
  })

  test("rejects malformed cases fail-closed", () => {
    expect(() =>
      parseGroundingCase({
        schema: 1,
        id: "broken",
        usecase: "persistent-context.conversation-state.thread-grounding",
        history: "not-an-array",
        targetUtterance: "x",
        gold: {},
        bucket: "ellipsis",
        severity: "critical",
      }),
    ).toThrow("history must be an array")

    expect(() =>
      parseGroundingCase({
        schema: 1,
        id: "broken-2",
        usecase: "persistent-context.conversation-state.thread-grounding",
        history: [],
        targetUtterance: "x",
        gold: {
          activeThreadId: null,
          referentId: null,
          intent: "status_check",
          scope: "current_workstream",
          shouldClarify: false,
          confidence: "high",
        },
        bucket: "bogus",
        severity: "critical",
      }),
    ).toThrow("bucket must be one of")
  })

  test("governed corpora stay at canary=28 and nightly=52", () => {
    expect(loadGroundingCases({ suite: "canary" })).toHaveLength(28)
    expect(loadGroundingCases({ suite: "nightly" })).toHaveLength(52)
  })
})

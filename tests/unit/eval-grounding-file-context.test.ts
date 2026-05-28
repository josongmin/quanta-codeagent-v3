import { describe, expect, test } from "bun:test"
import {
  extractGroundingFileIds,
  resolveGroundingSpecificFileContext,
  type GroundingCase,
} from "@/../src/apps/eval/grounding"

const baseCase = (overrides: Partial<GroundingCase> = {}): GroundingCase => ({
  schema: 2,
  id: "case",
  usecase: "persistent-context.conversation-state.thread-grounding",
  history: [{ role: "assistant", text: "Active thread prompt_rules." }],
  targetUtterance: "그 파일만 손봐.",
  gold: {
    activeThreadId: "prompt_rules",
    referentId: "src/agent/prompt.ts",
    intent: "execute_change",
    scope: "specific_file",
    shouldClarify: false,
    confidence: "high",
  },
  bucket: "reference",
  severity: "medium",
  ...overrides,
})

describe("grounding file context", () => {
  test("extracts concrete file ids from free text", () => {
    expect(extractGroundingFileIds("Touch src/agent/prompt.ts then src/agent/loop.ts.")).toEqual([
      "src/agent/prompt.ts",
      "src/agent/loop.ts",
    ])
  })

  test("resolves an explicit file path from the target utterance", () => {
    const resolved = resolveGroundingSpecificFileContext(
      baseCase({
        targetUtterance: "src/agent/prompt.ts만 손봐.",
      }),
    )
    expect(resolved.resolvedReferentId).toBe("src/agent/prompt.ts")
    expect(resolved.isAmbiguous).toBe(false)
  })

  test("uses owner shortlist ordering as primary file authority", () => {
    const resolved = resolveGroundingSpecificFileContext(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "prompt_rules",
            mentionedFileIds: ["src/apps/eval/index.ts", "src/apps/eval/grounding/report.ts"],
            text: "Owner shortlist ranks src/apps/eval/index.ts first, then src/apps/eval/grounding/report.ts.",
          },
        ],
        workingState: {
          ownerShortlist: [
            { file: "src/apps/eval/index.ts", reason: "primary owner" },
            { file: "src/apps/eval/grounding/report.ts", reason: "secondary owner" },
          ],
          blockers: [],
          nextStepQueue: [],
          deferredValidation: [],
        },
      }),
    )
    expect(resolved.primaryFileId).toBe("src/apps/eval/index.ts")
    expect(resolved.resolvedReferentId).toBe("src/apps/eval/index.ts")
  })

  test("marks basename collisions ambiguous", () => {
    const resolved = resolveGroundingSpecificFileContext(
      baseCase({
        history: [
          {
            role: "assistant",
            threadId: "ui_polish",
            mentionedFileIds: ["src/apps/eval/index.ts", "src/apps/cli/index.ts"],
            text: "Active thread ui_polish is touching src/apps/eval/index.ts and src/apps/cli/index.ts.",
          },
        ],
        targetUtterance: "index 쪽부터 해.",
        gold: {
          activeThreadId: "ui_polish",
          referentId: null,
          intent: "execute_change",
          scope: "specific_file",
          shouldClarify: true,
          confidence: "high",
        },
      }),
    )
    expect(resolved.isAmbiguous).toBe(true)
    expect(resolved.resolvedReferentId).toBeNull()
  })
})

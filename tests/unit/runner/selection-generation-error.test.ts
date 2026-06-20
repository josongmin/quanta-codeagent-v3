import { describe, expect, it } from "bun:test"
import { selectionGenerationErrorOf } from "@/runner/batch/eval/selection-generation-error"

describe("selectionGenerationErrorOf", () => {
  it("keeps provider/runtime stopReason:error as a generation failure", () => {
    expect(
      selectionGenerationErrorOf({
        stopReason: "error",
        agentError: "429 Too Many Requests",
      }),
    ).toBe("429 Too Many Requests")
  })

  it("fails open for exhaustion/no-patch terminal strings carried through agentError", () => {
    expect(
      selectionGenerationErrorOf({
        stopReason: "error",
        agentError: "agent reached max turns before verification",
      }),
    ).toBeUndefined()
    expect(
      selectionGenerationErrorOf({
        stopReason: "error",
        agentError: "no patch produced before max turns exhausted (no_patch_exhausted)",
      }),
    ).toBeUndefined()
    expect(
      selectionGenerationErrorOf({
        stopReason: "error",
        agentError: "agent exhausted token budget before verification",
      }),
    ).toBeUndefined()
    expect(
      selectionGenerationErrorOf({
        stopReason: "error",
        agentError: "no patch produced before token budget exhausted (no_patch_exhausted)",
      }),
    ).toBeUndefined()
  })

  it("preserves refusal as a generation failure", () => {
    expect(selectionGenerationErrorOf({ stopReason: "refusal" })).toBe(
      "agent stopped with refusal before verification",
    )
  })
})

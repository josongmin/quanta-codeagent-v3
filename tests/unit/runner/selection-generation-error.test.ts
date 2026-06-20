import { describe, expect, it } from "bun:test"
import { selectionGenerationErrorOf } from "@/runner/batch/eval/selection-generation-error"

describe("selectionGenerationErrorOf", () => {
  it("keeps provider/runtime stopReason:error as a generation failure", () => {
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "error",
        agentError: "429 Too Many Requests",
      }),
    ).toBe("429 Too Many Requests")
  })

  it("fails open only for typed non-error terminal stop reasons", () => {
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "max_turns",
        agentError: "agent reached max turns before verification",
      }),
    ).toBeUndefined()
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "budget_exhausted",
        agentError: "agent exhausted token budget before verification",
      }),
    ).toBeUndefined()
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "aborted",
        agentError: "agent aborted before verification",
      }),
    ).toBeUndefined()
  })

  it("ADVERSARIAL: legacy exhaustion-like strings on stopReason:error fail closed", () => {
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "error",
        agentError: "agent reached max turns before verification",
      }),
    ).toBe("agent reached max turns before verification")
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "error",
        agentError: "no patch produced before max turns exhausted (no_patch_exhausted)",
      }),
    ).toBe("no patch produced before max turns exhausted (no_patch_exhausted)")
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "error",
        agentError: "agent exhausted token budget before verification",
      }),
    ).toBe("agent exhausted token budget before verification")
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "error",
        agentError: "no patch produced before token budget exhausted (no_patch_exhausted)",
      }),
    ).toBe("no patch produced before token budget exhausted (no_patch_exhausted)")
  })

  it("ADVERSARIAL: typed terminal stopReason outranks contradictory agentError strings", () => {
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "max_turns",
        agentError: "429 Too Many Requests",
      }),
    ).toBeUndefined()
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "budget_exhausted",
        agentError: "provider crashed before verification",
      }),
    ).toBeUndefined()
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "aborted",
        agentError: "agent reached max turns before verification",
      }),
    ).toBeUndefined()
  })

  it("ADVERSARIAL: refusal authority is not downgraded by exhaustion-like strings", () => {
    expect(
      selectionGenerationErrorOf({
        patch: "",
        stopReason: "refusal",
        agentError: "agent exhausted token budget before verification",
      }),
    ).toBe("agent stopped with refusal before verification")
  })

  it("preserves refusal as a generation failure", () => {
    expect(selectionGenerationErrorOf({ patch: "", stopReason: "refusal" })).toBe(
      "agent stopped with refusal before verification",
    )
  })

  it("ADVERSARIAL: non-empty patch survives post-edit provider error as a scorable candidate", () => {
    expect(
      selectionGenerationErrorOf({
        stopReason: "error",
        patch: "diff --git a/x b/x\n+fix\n",
        agentError: "429 Too Many Requests",
      }),
    ).toBeUndefined()
  })

  it("ADVERSARIAL: non-empty patch survives post-edit refusal as a scorable candidate", () => {
    expect(
      selectionGenerationErrorOf({
        stopReason: "refusal",
        patch: "diff --git a/x b/x\n+fix\n",
        agentError: "policy refusal after edit",
      }),
    ).toBeUndefined()
  })
})

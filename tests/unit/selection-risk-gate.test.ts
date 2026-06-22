import { describe, expect, it } from "bun:test"
import { FakeLlm } from "@/apps/headless/fake-llm"
import type { Candidate } from "@/runner/batch/eval/selection-executor"
import { buildSelectionRiskGate } from "@/runner/batch/eval/selection-risk-gate"

const candidate = (patch: string, files: readonly string[] = ["x.py"]): Candidate => ({
  id: "cand-0",
  patch,
  turns: 1,
  files: [...files],
  baseValidatedRed: true,
})

describe("buildSelectionRiskGate", () => {
  it("on-mode expands when the LLM gate reports semantic risk", async () => {
    const llm = new FakeLlm([
      {
        text: JSON.stringify({
          expand: true,
          reasons: ["issue-condition-not-evidenced"],
        }),
      },
    ])
    const gate = buildSelectionRiskGate({
      structural: true,
      llmMode: "on",
      llm,
      problemStatement:
        "Fix the patch so explicit axis inversion still works when limits are preserved.",
      ownerFiles: ["pkg/axis.py"],
      ownerEvidence: [
        {
          file: "pkg/axis.py",
          symbols: ["invert_axis"],
          provenance: "selection-owner",
          sourceSlice: "def invert_axis(ax):\n    ax.set_xlim(...)",
        },
      ],
    })
    const decision = await gate?.(candidate("+++ b/pkg/axis.py\n+fix", ["pkg/axis.py"]))
    expect(decision?.expand).toBe(true)
    expect(decision?.reasons).toEqual(["llm:issue-condition-not-evidenced"])
    expect(decision?.llmEvidencePacket?.stage).toBe("candidate_review")
    expect(decision?.llmEvidencePacket?.ownerEvidence[0]?.sourceSlice).toContain("invert_axis")
    // structural arm forwards cand0's typed patch-budget verdict (a single clean
    // file is within budget) so the counterfactual path consumes facts directly.
    expect(decision?.patchBudget?.withinBudget).toBe(true)
  })

  it("shadow mode preserves structural decision and records the LLM advisory separately", async () => {
    const llm = new FakeLlm([
      {
        text: JSON.stringify({
          expand: true,
          reasons: ["symptom-site-only", "uncertain"],
        }),
      },
    ])
    const gate = buildSelectionRiskGate({
      structural: true,
      llmMode: "shadow",
      llm,
      problemStatement:
        "Fix the patch so explicit axis inversion still works when limits are preserved.",
      ownerFiles: ["pkg/axis.py"],
    })
    const decision = await gate?.(candidate("+++ b/pkg/axis.py\n+fix", ["pkg/axis.py"]))
    expect(decision?.expand).toBe(false)
    expect(decision?.reasons).toEqual([])
    expect(decision?.shadow).toEqual({
      expand: true,
      reasons: ["llm:symptom-site-only", "llm:uncertain"],
    })
    // structural verdict is forwarded alongside the shadow advisory (telemetry-only).
    expect(decision?.patchBudget?.withinBudget).toBe(true)
  })

  it("on-mode short-circuits the LLM call when the structural gate already expands", async () => {
    const llm = new FakeLlm([{ text: '{"expand": false, "reasons": []}' }])
    const gate = buildSelectionRiskGate({
      structural: true,
      llmMode: "on",
      llm,
      problemStatement: "Fix the patch without broadening the scope.",
      ownerFiles: ["pkg/a.py"],
    })
    const decision = await gate?.(candidate("", []))
    expect(decision?.expand).toBe(true)
    expect(decision?.reasons).toContain("empty-patch")
    expect(llm.seen).toHaveLength(0)
  })

  it("on-mode fails closed on invalid LLM output", async () => {
    const llm = new FakeLlm([{ text: "not json" }])
    const gate = buildSelectionRiskGate({
      structural: false,
      llmMode: "on",
      llm,
      problemStatement: "Fix the regression while preserving explicit behavior.",
      ownerFiles: ["pkg/x.py"],
    })
    const decision = await gate?.(candidate("+++ b/pkg/x.py\n+fix", ["pkg/x.py"]))
    expect(decision?.expand).toBe(true)
    expect(decision?.reasons).toEqual(["llm:invalid-output"])
    expect(decision?.llmEvidencePacket?.stage).toBe("candidate_review")
  })
})

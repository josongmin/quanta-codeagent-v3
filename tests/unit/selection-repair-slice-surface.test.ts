/**
 * B1 + B7 hellgate for the SELECTOR repair packet (`buildRepairPacketText`).
 *
 * B1: repair owner evidence must carry a real `sourceSlice` when a readSource +
 * issue symbols are threaded (reusing the slice-capable owner-evidence factory),
 * instead of the path-only `{symbols:[], no slice}` reconstruction that forces
 * the router's `localizationCertain` to false in every repair phase.
 *
 * B7: the candidate-local repair_seed + candidate_post_review packets must carry
 * the focus candidate's SOURCE-ONLY edit surface (touchedFiles / touchedSymbols)
 * derived from the candidate's OWN diff — never hidden-test paths.
 *
 * ENGAGE: the slice and the edit surface must appear in the RENDERED packet a
 * model/router would actually receive (not merely the builder-internal object).
 *
 * Red-without-fix: before B1/B7, `buildRepairPacketText` reconstructs owner
 * evidence path-only (no readSource arg accepted, symbols:[]) and emits no
 * candidate edit surface, so both assertions fail.
 */

import { describe, expect, test } from "bun:test"
import type { LlmEvidencePacket } from "@/runner/batch/eval/llm-evidence-packet"
import { buildRepairPacketText } from "@/runner/batch/eval/selection-repair-seed"
import type { Candidate, ScoredEntry } from "@/runner/batch/eval/selection-types"

const OWNER_SOURCE =
  "import os\n\nclass Axis:\n    def invert_axis(self, ax):\n        ax.set_xlim(1, 0)\n        return ax\n"

const patchFor = (file: string, sym: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -4,2 +4,2 @@ def ${sym}(self, ax):\n-        ax.set_xlim(1, 0)\n+        ax.set_xlim(0, 1)\n`

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "c0",
  patch: patchFor("pkg/axis.py", "invert_axis"),
  turns: 1,
  files: ["pkg/axis.py"],
  baseValidatedRed: true,
  familyOwnerFiles: ["pkg/axis.py"],
  ...over,
})

const entry = (candidate: Candidate, over: Partial<ScoredEntry> = {}): ScoredEntry => ({
  candidate,
  hard: {
    baseValidatedRed: true,
    patchProduced: true,
    patchedResolvedKofN: null,
    regressionGreen: null,
    smokeGreen: null,
    applyClean: null,
  },
  resolvedKofN: null,
  voterQuorum: null,
  verdict: { admissible: false, score: 0, reasons: [] },
  requiredContractsSatisfied: 0,
  contractsSatisfied: 0,
  ...over,
})

const capture = (
  args: Parameters<typeof buildRepairPacketText>[0],
): { rendered: string; packets: LlmEvidencePacket[] } => {
  const packets: LlmEvidencePacket[] = []
  const rendered = buildRepairPacketText({
    ...args,
    recordLlmEvidencePacket: (p) => packets.push(p),
  })
  return { rendered, packets }
}

describe("B1 — selector repair owner evidence carries a real source slice", () => {
  test("ENGAGE: the resolved owner slice appears in the rendered repair packet", () => {
    const { rendered, packets } = capture({
      scored: [entry(cand())],
      seed: "Regenerate to satisfy the public proof.",
      winner: null,
      problemStatement: "Axis inversion fails when explicit limits are preserved.",
      issueSymbols: ["invert_axis"],
      readSource: (rel) => (rel === "pkg/axis.py" ? OWNER_SOURCE : null),
    })
    const owner = packets.flatMap((p) => p.ownerEvidence).find((o) => o.file === "pkg/axis.py")
    expect(owner?.sourceSlice).toBeDefined()
    expect(owner?.sourceSlice).toContain("def invert_axis")
    expect(owner?.sourceSlice).not.toContain("import os")
    // ENGAGE: the slice is in the model-visible bytes, not just the object.
    expect(rendered).toContain("def invert_axis")
  })

  test("FALSE when genuinely unresolvable: no readSource ⇒ path-only (no slice)", () => {
    const { packets } = capture({
      scored: [entry(cand())],
      seed: "Regenerate.",
      winner: null,
      problemStatement: "Axis inversion fails.",
      issueSymbols: ["invert_axis"],
    })
    const owner = packets.flatMap((p) => p.ownerEvidence).find((o) => o.file === "pkg/axis.py")
    expect(owner?.sourceSlice).toBeUndefined()
  })
})

describe("B7 — selector repair packets carry the candidate's source-only edit surface", () => {
  test("ENGAGE: touchedFiles + touchedSymbols appear in the rendered packet", () => {
    const { rendered, packets } = capture({
      scored: [entry(cand())],
      seed: "Regenerate.",
      winner: null,
      problemStatement: "Axis inversion fails.",
      issueSymbols: ["invert_axis"],
      readSource: (rel) => (rel === "pkg/axis.py" ? OWNER_SOURCE : null),
    })
    for (const p of packets) {
      expect(p.candidateEditSurface?.touchedFiles).toContain("pkg/axis.py")
      expect(p.candidateEditSurface?.touchedSymbols).toContain("invert_axis")
    }
    expect(rendered).toContain('"candidateEditSurface"')
    expect(rendered).toContain("pkg/axis.py")
  })
})

import { describe, expect, test } from "bun:test"
import {
  buildRepairRoundLlmEvidencePacket,
  buildRepairRoundSeedMessage,
} from "@/runner/batch/eval/repair/llm-evidence"

describe("repair-round llm evidence", () => {
  test("buildRepairRoundSeedMessage prepends a typed repair_seed packet and preserves legacy prose", () => {
    const out = buildRepairRoundSeedMessage({
      problem: "Fix add() so it returns a+b instead of a-b.",
      cumulativeDiff: 'diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n@@ -1 +1 @@\n-return a - b\n+return a * b\n',
      failTail: "AssertionError: expected 5 got 6",
      validationSource: "verify_cmd",
      validationCmd: "node -e \"require('./math.js')\"",
      validationExitCode: 1,
      round: 1,
      siblingOwners: ["math.js"],
    })
    expect(out.packet.stage).toBe("repair_seed")
    expect(out.packet.evidenceRevision).toBe("repair-round-v1")
    expect(out.packet.ownerEvidence[0]?.file).toBe("math.js")
    expect(out.seedMsg).toContain('"stage": "repair_seed"')
    expect(out.seedMsg).toContain("Repair round 1.")
    expect(out.seedMsg).toContain("AssertionError: expected 5 got 6")
  })

  test("missing validation gate is carried as typed missingEvidence, not a silent blank", () => {
    const packet = buildRepairRoundLlmEvidencePacket({
      problem: "Fix add() so it returns a+b instead of a-b.",
      cumulativeDiff: "",
      failTail: "",
      validationSource: "none",
      round: 2,
    })
    expect(packet.missingEvidence).toContainEqual({
      kind: "verification_command",
      reason: "no_runnable_validation_gate_captured",
    })
    expect(packet.proofReceipts).toEqual([])
  })

  test("custom repair seed text is preserved under the typed packet prefix", () => {
    const out = buildRepairRoundSeedMessage(
      {
        problem: "Fix add() so it returns a+b instead of a-b.",
        cumulativeDiff: "",
        failTail: "AssertionError",
        validationSource: "verify_cmd",
        validationCmd: "node repro.js",
        validationExitCode: 1,
        round: 2,
      },
      "CUSTOM_REPAIR_CONTEXT",
    )
    expect(out.seedMsg).toContain('"stage": "repair_seed"')
    expect(out.seedMsg).toContain("CUSTOM_REPAIR_CONTEXT")
  })
})

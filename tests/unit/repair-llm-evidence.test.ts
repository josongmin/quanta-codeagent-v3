import { describe, expect, test } from "bun:test"
import {
  buildRepairRoundLlmEvidencePacket,
  buildRepairRoundSeedMessage,
} from "@/runner/batch/eval/repair/llm-evidence"

describe("repair-round llm evidence", () => {
  test("buildRepairRoundSeedMessage prepends a typed repair_seed packet and preserves legacy prose", () => {
    const out = buildRepairRoundSeedMessage({
      problem: "Fix add() so it returns a+b instead of a-b.",
      cumulativeDiff:
        "diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n@@ -1 +1 @@\n-return a - b\n+return a * b\n",
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

  // ── A3: infra/exec failure must NOT be coerced to candidate_red ───────────────
  describe("A3 — proof state separates infra failure from correctness", () => {
    test("an explicit exec-failure outcome maps to execution_failed, not candidate_red", () => {
      const packet = buildRepairRoundLlmEvidencePacket({
        problem: "Fix add().",
        cumulativeDiff: "",
        failTail: "ModuleNotFoundError: No module named 'numpy'",
        validationSource: "verify_cmd",
        validationCmd: "python -m pytest",
        validationExitCode: 1,
        validationOutcome: "exec_failed",
        round: 1,
      })
      const receipt = packet.proofReceipts[0]
      expect(receipt?.state).toBe("execution_failed")
      expect(receipt?.state).not.toBe("candidate_red")
    })

    test("an OS-reserved 'command not found' exit code (127) maps to execution_failed", () => {
      const packet = buildRepairRoundLlmEvidencePacket({
        problem: "Fix add().",
        cumulativeDiff: "",
        failTail: "pytest: command not found",
        validationSource: "verify_cmd",
        validationCmd: "pytest",
        validationExitCode: 127,
        round: 1,
      })
      expect(packet.proofReceipts[0]?.state).toBe("execution_failed")
    })

    test("an ordinary nonzero test failure (exit 1, no infra signal) is STILL candidate_red", () => {
      const packet = buildRepairRoundLlmEvidencePacket({
        problem: "Fix add().",
        cumulativeDiff: "",
        failTail: "AssertionError: expected 5 got 6",
        validationSource: "verify_cmd",
        validationCmd: "python -m pytest",
        validationExitCode: 1,
        round: 1,
      })
      expect(packet.proofReceipts[0]?.state).toBe("candidate_red")
    })
  })

  // ── B3: verificationTarget must reach the classic-repair packet ──────────────
  test("B3 — verificationTarget is forwarded into the classic-repair packet", () => {
    const packet = buildRepairRoundLlmEvidencePacket({
      problem: "Fix add().",
      cumulativeDiff: "",
      failTail: "",
      validationSource: "verify_cmd",
      validationCmd: "node repro.js",
      validationExitCode: 1,
      round: 1,
      verificationTarget: {
        primaryRail: { kind: "repro", cmd: "python repro.py", successPredicate: "stdout_contains" },
        required: [],
        optional: [],
        baseValidatedRed: true,
      },
    })
    expect(packet.verificationTarget).toBeDefined()
    expect(packet.verificationTarget?.primaryRail?.kind).toBe("repro")
  })

  // ── B7: candidate edit surface (source-only) on the classic-repair packet ─────
  test("B7 — candidate touched files/symbols appear as a source-only edit surface", () => {
    const patch =
      "diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n@@ -1,1 +1,1 @@ function add(a, b) {\n-  return a - b\n+  return a + b\n}\n"
    const packet = buildRepairRoundLlmEvidencePacket({
      problem: "Fix add().",
      cumulativeDiff: patch,
      failTail: "",
      validationSource: "verify_cmd",
      validationCmd: "node repro.js",
      validationExitCode: 1,
      round: 1,
    })
    expect(packet.candidateEditSurface?.touchedFiles).toContain("math.js")
    expect(packet.candidateEditSurface?.touchedSymbols).toContain("add")
  })

  test("B7 — edit surface is blind: a hidden-test marker in the diff THROWS at build", () => {
    expect(() =>
      buildRepairRoundLlmEvidencePacket({
        problem: "Fix add().",
        cumulativeDiff: "diff --git a/FAIL_TO_PASS b/FAIL_TO_PASS\n+leak\n",
        failTail: "",
        validationSource: "verify_cmd",
        validationCmd: "node repro.js",
        validationExitCode: 1,
        round: 1,
      }),
    ).toThrow()
  })

  // ── B1: classic-repair owner evidence carries a real sourceSlice when readable ─
  test("B1 — classic-repair owner evidence attaches the exact slice when source is readable", () => {
    const source = "import os\n\nclass Adder:\n    def add(self, a, b):\n        return a - b\n"
    const packet = buildRepairRoundLlmEvidencePacket({
      problem: "Fix add().",
      cumulativeDiff: "",
      failTail: "",
      validationSource: "verify_cmd",
      validationCmd: "node repro.js",
      validationExitCode: 1,
      round: 1,
      siblingOwners: ["adder.py"],
      issueSymbols: ["add"],
      readSource: (rel) => (rel === "adder.py" ? source : null),
    })
    const owner = packet.ownerEvidence.find((o) => o.file === "adder.py")
    expect(owner?.sourceSlice).toBeDefined()
    expect(owner?.sourceSlice).toContain("def add")
    expect(owner?.sourceSlice).not.toContain("import os")
  })

  // ── B2: missing slice is VISIBLE in the classic-repair packet ────────────────
  test("B2 — an owner with no resolvable slice emits owner_slice missingEvidence", () => {
    const packet = buildRepairRoundLlmEvidencePacket({
      problem: "Fix add().",
      cumulativeDiff: "",
      failTail: "",
      validationSource: "verify_cmd",
      validationCmd: "node repro.js",
      validationExitCode: 1,
      round: 1,
      siblingOwners: ["adder.py"],
      issueSymbols: ["add"],
      readSource: () => null, // unreadable ⇒ no slice
    })
    expect(packet.missingEvidence).toContainEqual({
      kind: "owner_slice",
      reason: "no_resolvable_slice:adder.py",
    })
  })
})

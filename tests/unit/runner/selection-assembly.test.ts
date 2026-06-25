import { describe, expect, test } from "bun:test"
import type { SelectionContractBundle } from "@/runner/batch/eval/public-contract-types"
import {
  composeSelectionAgentHint,
  prepareSelectionEvidenceContext,
  selectionGenerationPromptInput,
} from "@/runner/batch/eval/selection-assembly"

const promptContracts = {
  contracts: [
    {
      contractId: "owner-must-touch:pkg/a.py",
      kind: "owner-must-touch",
      strength: "required",
      provenance: "public-issue-text",
      subjectFiles: ["pkg/a.py"],
      subjectSymbols: [],
    },
    {
      contractId: "api-surface:target_fn",
      kind: "api-surface",
      strength: "supporting",
      provenance: "static-witness",
      subjectFiles: [],
      subjectSymbols: ["target_fn"],
    },
  ],
} satisfies SelectionContractBundle

const ownerEvidence = [
  {
    file: "pkg/a.py",
    symbols: ["target_fn"],
    provenance: "selection-owner",
    sourceSlice: "def target_fn(x):\n    return x",
  },
]

const staticWitnessDiagnostics = [
  {
    kind: "static_witness_unsupported_language" as const,
    file: "pkg/helper.ts",
    reason: "read source has no recognizable Python structure",
  },
]

const existingTestExpectations = [
  "tests/test_target.py::test_target exact/public literal: target_fn must preserve None",
]

describe("selection assembly", () => {
  test("selectionGenerationPromptInput maps authority vs advisory contracts into model-facing facts", () => {
    const input = selectionGenerationPromptInput(
      {
        verifySelectProofRequired: true,
        selectorMode: "clean",
        problemStatement: "target_fn returns the wrong value",
        ownerEvidence,
        promptContracts,
        baseValidatedRed: true,
        reproHint: "python -m pytest tests/test_target.py",
        validatedReproScripts: ["python repro.py"],
        existingTestExpectations,
        closureHint: "follow the public repro before editing",
        envCaveats: ["public repro helper is unavailable"],
        staticWitnessDiagnostics,
      },
      "candidate-seed",
    )

    expect(input.contracts).toEqual([
      {
        contractId: "owner-must-touch:pkg/a.py",
        authority: "public-issue-text/required",
        satisfied: "unknown",
      },
      {
        contractId: "api-surface:target_fn",
        authority: "advisory:static-witness/supporting",
        satisfied: "unknown",
      },
    ])
    expect(input.baseValidatedRed).toBe(true)
    expect(input.reproCommand).toBe("python -m pytest tests/test_target.py")
    expect(input.validatedReproScripts).toEqual(["python repro.py"])
    expect(input.existingTestExpectations).toEqual(existingTestExpectations)
    expect(input.closureHint).toBe("follow the public repro before editing")
    expect(input.envCaveats).toEqual(["public repro helper is unavailable"])
    expect(input.staticWitnessDiagnostics).toEqual(staticWitnessDiagnostics)
    expect(input.seed).toBe("candidate-seed")
  })

  test("composeSelectionAgentHint stays a plain closure-hint merge outside proof-clean mode", () => {
    const observedStages: string[] = []
    const hint = composeSelectionAgentHint(
      {
        verifySelectProofRequired: false,
        selectorMode: "clean",
        problemStatement: "target_fn returns the wrong value",
        ownerEvidence,
        promptContracts,
        baseValidatedRed: true,
        validatedReproScripts: ["python repro.py"],
        existingTestExpectations: [],
        closureHint: "follow the public repro before editing",
        envCaveats: [],
        staticWitnessDiagnostics: [],
        recordLlmEvidencePacket: (packet) => observedStages.push(packet.stage),
      },
      "candidate-seed",
    )

    expect(hint).toBe("follow the public repro before editing\n\ncandidate-seed")
    expect(observedStages).toEqual([])
  })

  test("composeSelectionAgentHint builds the clean prompt and records a candidate_generation packet", () => {
    const observedStages: string[] = []
    const hint = composeSelectionAgentHint(
      {
        verifySelectProofRequired: true,
        selectorMode: "clean",
        problemStatement: "target_fn returns the wrong value",
        ownerEvidence,
        promptContracts,
        baseValidatedRed: true,
        reproHint: "python -m pytest tests/test_target.py",
        validatedReproScripts: ["python repro.py"],
        existingTestExpectations,
        closureHint: "follow the public repro before editing",
        envCaveats: ["public repro helper is unavailable"],
        staticWitnessDiagnostics,
        recordLlmEvidencePacket: (packet) => observedStages.push(packet.stage),
      },
      "candidate-seed",
    )

    expect(hint).toContain("candidate-seed")
    expect(hint).toContain("follow the public repro before editing")
    expect(hint).toContain("python repro.py")
    expect(hint).toContain("target_fn must preserve None")
    expect(hint).toContain("pkg/a.py")
    expect(observedStages).toEqual(["candidate_generation"])
  })

  test("prepareSelectionEvidenceContext keeps authority/advisory split and nulls baseValidatedRed for discovered regression", () => {
    const context = prepareSelectionEvidenceContext({
      problemStatement: "target_fn returns the wrong value",
      sandbox: "/tmp/sandbox",
      n: 2,
      ownerCandidates: ["pkg/a.py", "pkg/helper.ts"],
      ownerResolved: undefined,
      publicContracts: promptContracts,
      verifySelectRegression: "discovered",
      baseValidatedRed: true,
      reproHint: undefined,
      reproTest: { installed: false, reason: "not_installed" },
      verificationTarget: undefined,
      oracleFailureRepairSeed: "repair-seed",
      existingTestExpectations,
      readSource: (rel) =>
        rel === "pkg/a.py"
          ? "def target_fn(x):\n    return x\n"
          : rel === "pkg/helper.ts"
            ? "export const helper = 1\n"
            : null,
    })

    expect(context.selectionBaseValidatedRed).toBeNull()
    expect(context.selectionAuthorityContracts).toEqual(promptContracts)
    expect(context.advisoryPromptContracts?.contracts.length).toBeGreaterThanOrEqual(
      promptContracts.contracts.length,
    )
    expect(context.selectionInputs.ownerFiles).toEqual(["pkg/a.py", "pkg/helper.ts"])
    expect(context.selectionOwnerEvidence.map((fact) => fact.file)).toContain("pkg/a.py")
    expect(context.existingTestExpectations).toEqual(existingTestExpectations)
    expect(context.staticWitnessDiagnostics).toEqual([
      {
        kind: "static_witness_unsupported_language",
        file: "pkg/helper.ts",
        reason:
          "static-witness is Python-only (def/class regex); this source was read but has no recognizable Python structure, so it contributes no static witness",
      },
    ])
    expect(context.generationEnvCaveats).toEqual([
      "public repro helper is unavailable in this runtime; no executable public repro command is attached",
    ])
    expect(context.oracleFailureRepairSeed).toBe("repair-seed")
  })

  test("a per-candidate owner seed is ADDITIVE — candidate 1 is NOT blinded to sibling owners (case A)", () => {
    // Generic non-Python source + symbol-free issue text ⇒ no static-witness
    // family forms, so seedFor(1) takes the plain per-owner (softened) path.
    const context = prepareSelectionEvidenceContext({
      problemStatement: "the output is wrong",
      sandbox: "/tmp/sandbox",
      n: 3,
      ownerCandidates: ["pkg/a.txt", "pkg/sibling.txt"],
      ownerResolved: undefined,
      publicContracts: undefined,
      verifySelectRegression: "off",
      baseValidatedRed: true,
      reproHint: undefined,
      reproTest: { installed: false, reason: "not_installed" },
      verificationTarget: undefined,
      oracleFailureRepairSeed: undefined,
      existingTestExpectations: [],
      readSource: (rel) =>
        rel === "pkg/a.txt" ? "alpha line\n" : rel === "pkg/sibling.txt" ? "beta line\n" : null,
    })

    // The softened per-owner seed for candidate 1 nudges toward the FIRST owner
    // only, with evidential (non-imperative) wording…
    const seedForCand1 = context.selectionInputs.seeds[1]
    expect(seedForCand1).toContain("`pkg/a.txt`")
    expect(seedForCand1).toContain("pay particular attention to")
    expect(seedForCand1).toContain("consider the other candidates too")
    expect(seedForCand1).not.toContain("Focus your investigation")
    expect(seedForCand1).not.toContain("`pkg/sibling.txt`")

    // …but when that seed is composed into the generation prompt alongside the
    // FULL owner evidence, candidate 1 STILL sees its sibling owner. The seed is
    // an additive nudge, not a withholding filter (the prompt is built from the
    // complete owner-candidate set + this seed).
    const prompt = composeSelectionAgentHint(
      {
        verifySelectProofRequired: true,
        selectorMode: "clean",
        problemStatement: "the output is wrong",
        ownerEvidence: context.selectionOwnerEvidence,
        promptContracts: context.advisoryPromptContracts,
        baseValidatedRed: context.selectionBaseValidatedRed,
        validatedReproScripts: [],
        existingTestExpectations: [],
        envCaveats: [],
        staticWitnessDiagnostics: context.staticWitnessDiagnostics,
      },
      seedForCand1,
    )
    expect(prompt).toBeDefined()
    expect(prompt).toContain("pkg/a.txt")
    // TEETH: the sibling owner candidate 1 was NOT seeded toward is still present.
    expect(prompt).toContain("pkg/sibling.txt")
  })
})

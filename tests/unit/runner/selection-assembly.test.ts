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
})

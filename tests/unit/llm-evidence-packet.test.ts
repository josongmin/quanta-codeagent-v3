import { describe, expect, test } from "bun:test"
import {
  assembleOwnerEvidence,
  assertPacketBlind,
  buildCandidatePostReviewLlmEvidencePacket,
  buildCandidateReviewLlmEvidencePacket,
  buildIntakeLlmEvidencePacket,
  buildRepairSeedLlmEvidencePacket,
  buildSelectionExplanationPacket,
  buildSelectionGenerationLlmEvidencePacket,
  buildSelectionGenerationPrompt,
  buildSelectionOwnerEvidence,
  type CandidatePostReviewPacketInput,
  type CandidateReviewPacketInput,
  candidatePatchHash,
  extractSymbolSlice,
  extractSymbolSliceResult,
  type LlmEvidenceArtifacts,
  type LlmEvidencePacket,
  opaqueInstanceIdHash,
  ownerTestResultReceipt,
  PacketBlindnessViolation,
  type ProofReceiptFact,
  type ProofReceiptSourcePolicy,
  ProofReceiptSourcePolicyError,
  type RepairSeedPacketInput,
  recordLlmEvidencePacket,
  renderLlmEvidencePacket,
  type SelectionGenerationPacketInput,
  sourcePolicyOf,
  summarizeLlmEvidenceArtifacts,
  verificationTargetFromPlan,
} from "@/runner/batch/eval/llm-evidence-packet"
import { makeStaticWitness } from "@/runner/batch/eval/static-witness"

// A8: the dead string-returning `build*Packet` wrappers were removed (zero
// production callers). These thin test-local shims keep the existing
// render-string assertions exercising the LIVE object builders + the shared
// renderLlmEvidencePacket — the exact rendering path production uses.
const buildSelectionGenerationPacket = (input: SelectionGenerationPacketInput): string =>
  renderLlmEvidencePacket(buildSelectionGenerationLlmEvidencePacket(input))
const buildCandidateReviewPacket = (input: CandidateReviewPacketInput): string =>
  renderLlmEvidencePacket(buildCandidateReviewLlmEvidencePacket(input))
const buildCandidatePostReviewPacket = (input: CandidatePostReviewPacketInput): string =>
  renderLlmEvidencePacket(buildCandidatePostReviewLlmEvidencePacket(input))
const buildRepairSeedPacket = (input: RepairSeedPacketInput): string =>
  renderLlmEvidencePacket(buildRepairSeedLlmEvidencePacket(input))

/** Parse the JSON body out of a rendered packet. */
const parseRendered = (rendered: string): Record<string, unknown> =>
  JSON.parse(rendered.split("```json")[1]?.split("```")[0] ?? "{}")

const VERIFICATION_PLAN = {
  primaryRail: {
    kind: "repro" as const,
    cmd: "python repro.py",
    authority: "execution" as const,
    successPredicate: { type: "stdout_contains" as const, substring: "Issue resolved" },
  },
  required: [
    {
      kind: "repro" as const,
      cmd: "python repro.py",
      authority: "execution" as const,
      successPredicate: { type: "stdout_contains" as const, substring: "Issue resolved" },
    },
  ],
  optional: [],
  baseValidatedRed: false,
}

describe("llm evidence packet — render + blindness guard", () => {
  test("renders a bounded typed packet with stable hashes", () => {
    const rendered = renderLlmEvidencePacket({
      stage: "repair_seed",
      instanceIdHash: opaqueInstanceIdHash("Public issue text"),
      evidenceRevision: "test-v1",
      candidatePatchHash: candidatePatchHash("+++ b/x.py\n+fix"),
      question: "Generate a bounded repair instruction.",
      allowedActions: ["repair_only"],
      forbiddenSources: ["hidden_tests", "gold_patch"],
      publicIssueFacts: ["issue summary: the bug"],
      ownerEvidence: [{ file: "x.py", symbols: ["run"], provenance: "repair-owner" }],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" }],
      contractFacts: [
        { contractId: "multi-site-family:x.py", authority: "static-witness", satisfied: false },
      ],
      staticFacts: [{ kind: "edit_surface", value: "preserve bounded" }],
      missingEvidence: [
        { kind: "regression", reason: "no_issue_positive_public_regression_proof" },
      ],
    })
    expect(rendered).toContain("## LLM Evidence Packet")
    expect(rendered).toContain('"stage": "repair_seed"')
    expect(rendered).toContain('"file": "x.py"')
    expect(rendered).toContain('"state": "candidate_red"')
    expect(opaqueInstanceIdHash("Public issue text")).toHaveLength(16)
  })

  test("assertPacketBlind THROWS when a dataset key leaks into a structured field", () => {
    const poisoned: LlmEvidencePacket = {
      stage: "candidate_generation",
      instanceIdHash: "x",
      evidenceRevision: "v",
      question: "q",
      allowedActions: [],
      forbiddenSources: [],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [{ source: "FAIL_TO_PASS", state: "candidate_red" }],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [],
    }
    expect(() => assertPacketBlind(poisoned)).toThrow(PacketBlindnessViolation)
  })

  test("builders reject hidden oracle markers before issue-summary truncation", () => {
    expect(() =>
      buildSelectionGenerationPacket({
        problemStatement: `${"x".repeat(300)}FAIL_TO_PASS`,
        ownerEvidence: [],
        contracts: [],
      }),
    ).toThrow(PacketBlindnessViolation)
  })

  test("blindness guard does NOT trip on the forbiddenSources meta menu naming gold_patch", () => {
    const ok: LlmEvidencePacket = {
      stage: "candidate_generation",
      instanceIdHash: "x",
      evidenceRevision: "v",
      question: "q",
      allowedActions: [],
      forbiddenSources: ["gold_patch", "hidden_tests"],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [],
    }
    expect(() => assertPacketBlind(ok)).not.toThrow()
  })
})

describe("verificationTargetFromPlan — answer-key fence (leak-by-path)", () => {
  const planWithLeakySteps = {
    primaryRail: {
      kind: "repro" as const,
      cmd: "python /sandbox/repro_xyz.py",
      authority: "execution" as const,
      successPredicate: { type: "stdout_contains" as const, substring: "Issue resolved" },
    },
    required: [
      {
        kind: "repro" as const,
        cmd: "python /sandbox/repro_xyz.py",
        authority: "execution" as const,
        successPredicate: { type: "stdout_contains" as const, substring: "Issue resolved" },
      },
      // A hidden test referenced BY PATH — the exact leak assertPacketBlind cannot see.
      {
        kind: "owner-test" as const,
        cmd: "pytest tests/regressions/test_secret.py::test_hidden_failing_node",
        authority: "execution" as const,
        successPredicate: { type: "test_exit_zero" as const },
      },
    ],
    optional: [{ kind: "module-smoke" as const, cmd: "pytest pkg/tests/test_smoke.py::leak_node" }],
    baseValidatedRed: true,
  }

  test("surfaces repro step cmd but WITHHOLDS non-repro (owner-test/module-smoke) cmd", () => {
    const target = verificationTargetFromPlan(planWithLeakySteps)
    expect(target?.primaryRail?.cmd).toBe("python /sandbox/repro_xyz.py")
    expect(target?.required[0]?.cmd).toBe("python /sandbox/repro_xyz.py")
    expect(target?.required[1]?.cmd).toBeUndefined()
    expect(target?.required[1]?.cmdWithheld).toBe(true)
    expect(target?.optional[0]?.cmd).toBeUndefined()
    expect(target?.optional[0]?.cmdWithheld).toBe(true)
    // successPredicate is reduced to its discriminant, never its substring/selector value.
    expect(target?.primaryRail?.successPredicate).toBe("stdout_contains")
    expect(JSON.stringify(target)).not.toContain("Issue resolved")
  })

  test("a non-repro step's path-bearing cmd never reaches the rendered generation packet", () => {
    const target = verificationTargetFromPlan(planWithLeakySteps)
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "public issue",
      ownerEvidence: [],
      contracts: [],
      ...(target !== undefined ? { verificationTarget: target } : {}),
    })
    expect(rendered).not.toContain("test_hidden_failing_node")
    expect(rendered).not.toContain("tests/regressions/test_secret.py")
    expect(rendered).not.toContain("leak_node")
    // ...but the blind repro target IS surfaced.
    expect(rendered).toContain("python /sandbox/repro_xyz.py")
    expect(rendered).toContain('"verificationTarget"')
  })
})

describe("llm evidence packet — cleanPacket dedup (teeth for uniqueLines/uniqueObjects)", () => {
  test("repeated string facts and identical evidence objects collapse to one", () => {
    const dupOwner = { file: "a.py", symbols: ["foo"], provenance: "selection-owner" }
    const parsed = parseRendered(
      renderLlmEvidencePacket({
        stage: "candidate_generation",
        instanceIdHash: "id",
        evidenceRevision: "v",
        question: "q",
        allowedActions: ["x", "x"],
        forbiddenSources: [],
        publicIssueFacts: ["same fact", "same fact", "other"],
        ownerEvidence: [dupOwner, { ...dupOwner }],
        proofReceipts: [],
        contractFacts: [],
        staticFacts: [],
        missingEvidence: [],
      }),
    )
    expect(parsed.publicIssueFacts).toEqual(["same fact", "other"])
    expect(parsed.allowedActions).toEqual(["x"])
    expect((parsed.ownerEvidence as unknown[]).length).toBe(1)
  })
})

describe("llm evidence packet — stage builders", () => {
  test("candidate_review builder preserves the stage-scoped question and exact owner evidence", () => {
    const rendered = buildCandidateReviewPacket({
      problemStatement: "Axis inversion still fails when explicit limits are preserved.",
      candidatePatchHash: "deadbeef",
      candidateFiles: ["pkg/axis.py"],
      ownerEvidence: [
        {
          file: "pkg/axis.py",
          symbols: ["invert_axis"],
          provenance: "selection-owner",
          sourceSlice: "def invert_axis(ax):\n    ax.set_xlim(...)",
        },
      ],
    })
    expect(rendered).toContain('"stage": "candidate_review"')
    expect(rendered).toContain('"candidatePatchHash": "deadbeef"')
    expect(rendered).toContain("invert_axis")
    expect(rendered).toContain("sourceSlice")
  })

  test("generation packet renders explicit env caveats when they are provided", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Crash in resolve_owner when env prep differs.",
      ownerEvidence: [],
      contracts: [],
      envCaveats: [
        "attempted public repro helper failed to execute on the base environment; no executable public repro command is attached",
      ],
    })
    expect(rendered).toContain("env caveat:")
    expect(rendered).toContain("attempted public repro helper failed to execute")
  })

  test("generation packet carries validated public repro scripts as bounded contracts", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Connection settings are ignored by the shell command.",
      ownerEvidence: [],
      contracts: [],
      validatedReproScripts: [
        "print('Issue reproduced')\nassert run_shell() == 'Issue reproduced'",
      ],
    })
    const parsed = parseRendered(rendered)
    expect(parsed.staticFacts).toContainEqual({
      kind: "validated_public_repro",
      value: "script 1: print('Issue reproduced')\nassert run_shell() == 'Issue reproduced'",
    })
  })

  test("generation packet surfaces static-witness unsupported-language diagnostics instead of staying silent", () => {
    const parsed = parseRendered(
      buildSelectionGenerationPacket({
        problemStatement: "Fix render() in widget.ts.",
        ownerEvidence: [],
        contracts: [],
        staticWitnessDiagnostics: [
          {
            kind: "static_witness_unsupported_language",
            file: "widget.ts",
            reason: "static-witness is Python-only and found no recognizable Python structure",
          },
        ],
      }),
    )
    expect(parsed.staticFacts).toContainEqual({
      kind: "static_witness_unsupported_language",
      value: "widget.ts: static-witness is Python-only and found no recognizable Python structure",
    })
    expect(parsed.missingEvidence).toContainEqual({
      kind: "static_witness",
      reason: "static_witness_unsupported_language:widget.ts",
    })
  })

  test("AUDIT: validated repro scripts carry an evidence-toned framing note (not a 'must pass' mandate)", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Connection settings are ignored.",
      ownerEvidence: [],
      contracts: [],
      validatedReproScripts: ["print('Issue reproduced')"],
    })
    const parsed = parseRendered(rendered)
    const facts = parsed.staticFacts as Array<{ kind: string; value: string }>
    const note = facts.find((f) => f.kind === "validated_public_repro_note")
    expect(note).toBeDefined()
    expect(note?.value.toLowerCase()).toContain("root cause")
    expect(note?.value.toLowerCase()).toContain("exit 0")
    expect(note?.value.toLowerCase()).not.toContain("must make them report")
  })

  test("AUDIT: NO framing note when there are no validated repro scripts", () => {
    const parsed = parseRendered(
      buildSelectionGenerationPacket({
        problemStatement: "issue",
        ownerEvidence: [],
        contracts: [],
      }),
    )
    const facts = parsed.staticFacts as Array<{ kind: string; value: string }>
    expect(facts.some((f) => f.kind === "validated_public_repro_note")).toBe(false)
  })

  test("generation packet rejects hidden oracle markers inside validated repro scripts", () => {
    expect(() =>
      buildSelectionGenerationPacket({
        problemStatement: "public issue",
        ownerEvidence: [],
        contracts: [],
        validatedReproScripts: ["print('FAIL_TO_PASS')"],
      }),
    ).toThrow(PacketBlindnessViolation)
  })

  test("generation packet rejects hidden oracle markers before bounded truncation", () => {
    expect(() =>
      buildSelectionGenerationPacket({
        problemStatement: "public issue",
        ownerEvidence: [],
        contracts: [],
        validatedReproScripts: [`${"x".repeat(1_300)}FAIL_TO_PASS`],
      }),
    ).toThrow(PacketBlindnessViolation)
    expect(() =>
      buildSelectionGenerationPacket({
        problemStatement: "public issue",
        ownerEvidence: [],
        contracts: [],
        seed: `${"x".repeat(500)}PASS_TO_PASS`,
      }),
    ).toThrow(PacketBlindnessViolation)
  })

  test("post-exec review packet carries executed proof receipts without pretending to be a winner decision", () => {
    const rendered = buildCandidatePostReviewPacket({
      problemStatement: "Axis inversion still fails when explicit limits are preserved.",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [
        { file: "pkg/axis.py", symbols: ["invert_axis"], provenance: "repair-owner" },
      ],
      proofReceipts: [
        { source: "public_mwe", state: "candidate_red", command: "python repro.py" },
        { source: "hard:proofRequiredMissing", state: "not_run" },
      ],
      contracts: [{ contractId: "owner-touch", authority: "static-witness/weak", satisfied: true }],
    })
    expect(rendered).toContain('"stage": "candidate_post_review"')
    expect(rendered).toContain('"candidatePatchHash": "deadbeef"')
    expect(rendered).toContain('"source": "public_mwe"')
    expect(rendered).toContain('"state": "candidate_red"')
    expect(rendered).not.toContain("select_winner")
  })

  // ── B2: owner_slice missingEvidence mirrored into post_review + repair_seed ────
  test("B2 — post_review auto-emits owner_slice missingEvidence for an unresolved owner slice", () => {
    const packet = buildCandidatePostReviewLlmEvidencePacket({
      problemStatement: "Axis inversion fails.",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [{ file: "pkg/axis.py", symbols: [], provenance: "repair-owner" }],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" }],
      contracts: [],
    })
    expect(packet.missingEvidence).toContainEqual({
      kind: "owner_slice",
      reason: "no_resolvable_slice:pkg/axis.py",
    })
  })

  test("B2 — repair_seed auto-emits owner_slice missingEvidence for an unresolved owner slice", () => {
    const packet = buildRepairSeedLlmEvidencePacket({
      problemStatement: "Axis inversion fails.",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [{ file: "pkg/axis.py", symbols: [], provenance: "repair-owner" }],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" }],
      contracts: [],
    })
    expect(packet.missingEvidence).toContainEqual({
      kind: "owner_slice",
      reason: "no_resolvable_slice:pkg/axis.py",
    })
  })

  test("B2 — an owner WITH a resolved slice emits NO owner_slice missingEvidence (paired-control)", () => {
    const packet = buildCandidatePostReviewLlmEvidencePacket({
      problemStatement: "Axis inversion fails.",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [
        {
          file: "pkg/axis.py",
          symbols: ["invert_axis"],
          provenance: "repair-owner",
          sourceSlice: "def invert_axis(): ...",
        },
      ],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" }],
      contracts: [],
    })
    expect(packet.missingEvidence.some((m) => m.kind === "owner_slice")).toBe(false)
  })

  // ── B7: candidate edit surface on candidate-local packets (source-only) ───────
  test("B7 — post_review carries the candidate's touched files/symbols (source-only)", () => {
    const rendered = buildCandidatePostReviewPacket({
      problemStatement: "Axis inversion fails.",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [
        { file: "pkg/axis.py", symbols: ["invert_axis"], provenance: "repair-owner" },
      ],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" }],
      contracts: [],
      candidateEditSurface: { touchedFiles: ["pkg/axis.py"], touchedSymbols: ["invert_axis"] },
    })
    expect(rendered).toContain('"candidateEditSurface"')
    expect(rendered).toContain('"pkg/axis.py"')
    expect(rendered).toContain('"invert_axis"')
  })

  test("B7 — repair_seed carries the candidate's touched files/symbols (source-only)", () => {
    const rendered = buildRepairSeedPacket({
      problemStatement: "Axis inversion fails.",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [
        { file: "pkg/axis.py", symbols: ["invert_axis"], provenance: "repair-owner" },
      ],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" }],
      contracts: [],
      candidateEditSurface: { touchedFiles: ["pkg/axis.py"], touchedSymbols: ["invert_axis"] },
    })
    expect(rendered).toContain('"candidateEditSurface"')
    expect(rendered).toContain('"invert_axis"')
  })

  test("B7 — edit-surface blindness: a leaked marker in a touched file THROWS at build", () => {
    expect(() =>
      buildCandidatePostReviewLlmEvidencePacket({
        problemStatement: "Axis inversion fails.",
        candidatePatchHash: "deadbeef",
        ownerEvidence: [],
        proofReceipts: [],
        contracts: [],
        candidateEditSurface: { touchedFiles: ["FAIL_TO_PASS"], touchedSymbols: [] },
      }),
    ).toThrow()
  })

  test("shared clean generation prompt omits baseValidatedRed when repro authority is null", () => {
    const rendered = buildSelectionGenerationPrompt({
      problemStatement: "dbshell ignores connection settings.",
      ownerEvidence: [],
      contracts: [],
      baseValidatedRed: null,
    })
    expect(rendered).toContain('"stage": "candidate_generation"')
    expect(rendered).not.toContain("baseValidatedRed")
  })

  test("shared clean generation prompt forwards static-witness diagnostics into the rendered packet", () => {
    const rendered = buildSelectionGenerationPrompt({
      problemStatement: "Fix buildWidget() in widget.ts so it preserves the input object.",
      ownerEvidence: [{ file: "widget.ts", symbols: [], provenance: "selection-owner" }],
      contracts: [],
      baseValidatedRed: false,
      staticWitnessDiagnostics: [
        {
          kind: "static_witness_unsupported_language",
          file: "widget.ts",
          reason: "python-only analyzer could not interpret TS source",
        },
      ],
    })
    expect(rendered).toContain("static_witness_unsupported_language")
    expect(rendered).toContain("widget.ts")
  })
})

describe("llm evidence packet — stage history aggregation", () => {
  test("multiple packets in the same stage preserve history for summary/count surfaces", () => {
    const packet = (revision: string, missingKind: string): LlmEvidencePacket => ({
      stage: "candidate_generation",
      instanceIdHash: "x",
      evidenceRevision: revision,
      question: "q",
      allowedActions: [],
      forbiddenSources: [],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [{ kind: missingKind, reason: missingKind }],
    })
    const artifacts: Partial<LlmEvidenceArtifacts> = {}
    recordLlmEvidencePacket(artifacts, packet("v1", "first"))
    recordLlmEvidencePacket(artifacts, packet("v2", "second"))
    const summary = summarizeLlmEvidenceArtifacts(artifacts)
    expect(summary?.stages).toEqual(["candidate_generation"])
    expect(summary?.revisionByStage).toEqual({ candidate_generation: "v2" })
    expect(summary?.missingKinds).toEqual(["first", "second"])
    expect(
      (artifacts as { candidateGenerationHistory?: unknown[] }).candidateGenerationHistory,
    ).toHaveLength(2)
  })

  test("candidate_review stage is retained in artifact summaries", () => {
    const packet: LlmEvidencePacket = {
      stage: "candidate_review",
      instanceIdHash: "x",
      evidenceRevision: "risk-gate-v2",
      question: "q",
      allowedActions: [],
      forbiddenSources: [],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [{ kind: "risk_context", reason: "risk_context" }],
    }
    const artifacts: Partial<LlmEvidenceArtifacts> = {}
    recordLlmEvidencePacket(artifacts, packet)
    const summary = summarizeLlmEvidenceArtifacts(artifacts)
    expect(summary?.stages).toEqual(["candidate_review"])
    expect(summary?.revisionByStage).toEqual({ candidate_review: "risk-gate-v2" })
    expect(summary?.missingKinds).toEqual(["risk_context"])
  })

  test("candidate_post_review stage is retained in artifact summaries", () => {
    const packet: LlmEvidencePacket = {
      stage: "candidate_post_review",
      instanceIdHash: "x",
      evidenceRevision: "candidate-post-review-v1",
      question: "q",
      allowedActions: [],
      forbiddenSources: [],
      publicIssueFacts: [],
      ownerEvidence: [],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" }],
      contractFacts: [],
      staticFacts: [],
      missingEvidence: [],
    }
    const artifacts: Partial<LlmEvidenceArtifacts> = {}
    recordLlmEvidencePacket(artifacts, packet)
    const summary = summarizeLlmEvidenceArtifacts(artifacts)
    expect(summary?.stages).toEqual(["candidate_post_review"])
    expect(summary?.revisionByStage).toEqual({ candidate_post_review: "candidate-post-review-v1" })
  })
})

describe("llm evidence packet — bounded source slice (assembleOwnerEvidence / extractSymbolSlice)", () => {
  const SRC = "import os\n\ndef foo(x):\n    y = x + 1\n    return y\n\ndef bar():\n    pass\n"

  test("extractSymbolSlice returns only the symbol's def block, not the whole file", () => {
    const slice = extractSymbolSlice(SRC, "foo")
    expect(slice).toContain("def foo(x):")
    expect(slice).toContain("return y")
    expect(slice).not.toContain("import os")
    expect(slice).not.toContain("def bar")
  })

  test("extractSymbolSlice is bounded and returns undefined for an absent symbol", () => {
    expect(extractSymbolSlice(SRC, "missing")).toBeUndefined()
    const huge = `def big():\n${Array.from({ length: 500 }, (_, i) => `    s${i} = ${i}`).join("\n")}\n`
    expect((extractSymbolSlice(huge, "big") ?? "").split("\n").length).toBeLessThanOrEqual(40)
  })

  test("assembleOwnerEvidence attaches the exact slice for issue symbols defined in the file", () => {
    const ev = assembleOwnerEvidence({
      ownerFiles: ["m.py"],
      issueSymbols: ["foo"],
      readSource: () => SRC,
    })
    expect(ev[0]?.symbols).toContain("foo")
    expect(ev[0]?.sourceSlice).toContain("def foo")
    expect(ev[0]?.sourceSlice).not.toContain("import os")
  })

  test("assembleOwnerEvidence yields path-only (no slice, no whole-file) when source is unreadable", () => {
    const ev = assembleOwnerEvidence({
      ownerFiles: ["m.py"],
      issueSymbols: ["foo"],
      readSource: () => null,
    })
    expect(ev[0]?.file).toBe("m.py")
    expect(ev[0]?.sourceSlice).toBeUndefined()
    expect(ev[0]?.symbols).toEqual([])
  })

  test("buildSelectionOwnerEvidence keeps static witness provenance and exact slices", () => {
    const ev = buildSelectionOwnerEvidence({
      ownerFiles: ["pkg/owner.py"],
      issueSymbols: ["foo"],
      staticWitnesses: [
        makeStaticWitness({
          kind: "override-family",
          authority: "authoritative",
          provenance: "ast",
          subjectFiles: ["pkg/owner.py"],
          subjectSymbols: ["foo"],
          reason: "shared method across owner files",
        }),
      ],
      readSource: () => SRC,
    })
    expect(ev.some((fact) => fact.provenance === "selection-owner")).toBe(true)
    expect(
      ev.some(
        (fact) =>
          fact.provenance === "static-witness:override-family/ast/authoritative" &&
          fact.sourceSlice?.includes("def foo(x):") === true,
      ),
    ).toBe(true)
  })
})

describe("llm evidence packet — intake (typed, public-only)", () => {
  const packet = buildIntakeLlmEvidencePacket({
    problemStatement: "The callback should stop raising in run().",
    localizeCandidates: ["pkg/core.py", "pkg/hooks.py"],
    faultEvidence: {
      candidates: [
        {
          file: "pkg/core.py",
          score: 5,
          sources: ["issue-file", "owner-resolve"],
          symbols: ["run"],
        },
      ],
      issueSymbols: ["run"],
      truncated: false,
      partial: false,
    },
    verificationPlan: VERIFICATION_PLAN,
    reproTest: {
      installed: false,
      reason: "no_reproduced_candidate",
      samples: 3,
      reproducedCount: 0,
    },
  })

  test("owner evidence is typed and carries the fault file + provenance", () => {
    expect(packet.stage).toBe("intake")
    expect(packet.ownerEvidence[0]?.file).toBe("pkg/core.py")
    expect(packet.ownerEvidence[0]?.provenance).toContain("fault-evidence")
  })

  test("the typed verification target is surfaced from the plan", () => {
    expect(packet.verificationTarget?.primaryRail?.cmd).toBe("python repro.py")
    expect(packet.verificationTarget?.required[0]?.successPredicate).toBe("stdout_contains")
  })

  test("missing evidence is typed reasons, not free strings", () => {
    expect(packet.missingEvidence.some((m) => m.reason === "public_mwe_base_not_attempted")).toBe(
      false,
    )
    expect(packet.proofReceipts.some((r) => r.source === "public_mwe")).toBe(true)
  })

  test("infra repro sample tails keep the tail end when bounded", () => {
    const tailMarker = "TAIL_IMPORT_ERROR_END"
    const intake = buildIntakeLlmEvidencePacket({
      problemStatement: "Importing the package crashes.",
      localizeCandidates: ["pkg/core.py"],
      reproTest: {
        installed: false,
        reason: "env_exec_failed",
        sampleStdoutTail: `STDOUT_HEAD\n${"o".repeat(900)}${tailMarker}`,
        sampleStderrTail: `STDERR_HEAD\n${"e".repeat(900)}${tailMarker}`,
      },
    })
    const receipt = intake.proofReceipts.find((r) => r.sourcePolicy === "infra")
    expect(receipt?.stdoutTail).toContain(tailMarker)
    expect(receipt?.stdoutTail).not.toContain("STDOUT_HEAD")
    expect(receipt?.stderrTail).toContain(tailMarker)
    expect(receipt?.stderrTail).not.toContain("STDERR_HEAD")
  })
})

describe("llm evidence packet — generation (self-contained, bounded)", () => {
  test("carries real issue facts + owner slice, never the ambient-prompt placeholder", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Crash in resolve_owner when config is empty.",
      ownerEvidence: [
        {
          file: "pkg/owner.py",
          symbols: ["resolve_owner"],
          provenance: "selection-owner",
          sourceSlice: "def resolve_owner(cfg):\n    return cfg.owner",
        },
      ],
      contracts: [
        { contractId: "owner-touch", authority: "static-witness/weak", satisfied: "unknown" },
      ],
      reproCommand: "python repro.py",
      baseValidatedRed: true,
    })
    expect(rendered).not.toContain("already attached in the main task prompt")
    expect(rendered).toContain("resolve_owner")
    expect(rendered).toContain('"state": "base_red"')
    expect(rendered).toContain('"command": "python repro.py"')
  })

  test("an owner file with no resolvable slice yields a typed missingEvidence note, not a broad excerpt", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Some public issue.",
      ownerEvidence: [{ file: "pkg/owner.py", symbols: [], provenance: "selection-owner" }],
      contracts: [],
    })
    expect(rendered).toContain("no_resolvable_slice:pkg/owner.py")
  })

  test("path-only owner stub does not create missingEvidence when the same file has a static-witness slice", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Some public issue.",
      ownerEvidence: [
        { file: "pkg/owner.py", symbols: [], provenance: "selection-owner" },
        {
          file: "pkg/owner.py",
          symbols: ["run"],
          provenance: "static-witness:override-family/ast/authoritative",
          sourceSlice: "def run():\n    return 1",
        },
      ],
      contracts: [],
    })
    expect(rendered).toContain("def run")
    expect(rendered).not.toContain("no_resolvable_slice:pkg/owner.py")
  })
})

describe("llm evidence packet — repair seed (self-contained, stable id)", () => {
  test("instanceIdHash is the opaque problem-statement hash; candidate identity is separate", () => {
    const problem = "Public issue about a backend bug."
    const rendered = buildRepairSeedPacket({
      problemStatement: problem,
      candidatePatchHash: "cand-9",
      ownerEvidence: [{ file: "a.py", symbols: [], provenance: "repair-owner" }],
      proofReceipts: [{ source: "hard:mweProof=candidate_red", state: "candidate_red" }],
      contracts: [],
      repairGuidance: "Regenerate to satisfy the public repro.",
    })
    expect(rendered).toContain(`"instanceIdHash": "${opaqueInstanceIdHash(problem)}"`)
    expect(rendered).toContain('"candidatePatchHash": "cand-9"')
    expect(rendered).not.toContain("already attached in the main task prompt")
    expect(rendered).toContain("repair_guidance")
  })

  test("no positive executed proof ⇒ typed missingEvidence flag", () => {
    const rendered = buildRepairSeedPacket({
      problemStatement: "x",
      candidatePatchHash: "c",
      ownerEvidence: [],
      proofReceipts: [{ source: "hard:staticSanity=foo", state: "static_only" }],
      contracts: [],
    })
    expect(rendered).toContain("no_positive_executed_public_proof_attached")
  })

  test("rejects hidden oracle markers before bounded repair guidance truncation", () => {
    expect(() =>
      buildRepairSeedPacket({
        problemStatement: "Simple public bug",
        candidatePatchHash: "deadbeef",
        ownerEvidence: [],
        proofReceipts: [],
        contracts: [],
        repairGuidance: `${"x".repeat(1_900)}FAIL_TO_PASS`,
      }),
    ).toThrow(PacketBlindnessViolation)
  })
})

describe("llm evidence packet — selection explanation (report-only, no submit authority)", () => {
  const packet = buildSelectionExplanationPacket({
    problemStatement: "Time zone conversion is wrong across backends",
    ownerFiles: ["django/db/backends/mysql/operations.py"],
    winnerId: null,
    proofRequired: true,
    noWinnerReason: "proof_required_missing",
    proofSummary: {
      proofState: "proof_missing",
      proofSource: "none",
      proofRequiredMissing: true,
      contractOnlySubmitted: false,
      contractOnlyBlocked: true,
      publicRegressionState: "safety_green",
      repairOnlyCandidates: 2,
      submittedCandidateProof: false,
    },
    candidates: [
      {
        id: "cand-0",
        files: ["django/db/backends/mysql/operations.py"],
        admissible: false,
        reasons: ["hard:proofRequiredMissing"],
        proofState: "proof_missing",
        requiredContractsSatisfied: 1,
        contractsSatisfied: 1,
      },
    ],
  })

  test("is advisory: its allowed actions cannot admit or override", () => {
    expect(packet.stage).toBe("selection_explanation")
    expect(packet.allowedActions).toContain("explain_selection_outcome")
    expect(packet.allowedActions.every((a) => !/submit|admit|override|select_winner/.test(a))).toBe(
      true,
    )
    expect(packet.forbiddenSources).toContain("selection_override")
  })

  test("surfaces the deterministic outcome + typed candidate breakdown", () => {
    expect(
      packet.staticFacts.some((s) => s.kind === "selected_candidate" && s.value === "<none>"),
    ).toBe(true)
    expect(packet.contractFacts.some((c) => c.contractId === "candidate:cand-0")).toBe(true)
    expect(
      packet.missingEvidence.some((m) => m.reason === "no_positive_executed_public_proof"),
    ).toBe(true)
  })

  test("maps proof receipts by exact proof-state enums instead of string heuristics", () => {
    const mapped = buildSelectionExplanationPacket({
      problemStatement: "Time zone conversion is wrong across backends",
      ownerFiles: ["django/db/backends/mysql/operations.py"],
      winnerId: null,
      proofSummary: {
        proofState: "proof_missing",
        proofSource: "none",
        proofRequiredMissing: false,
        contractOnlySubmitted: false,
        contractOnlyBlocked: false,
        publicMweState: "base_not_red",
        publicRegressionState: "coverage_capped",
        reproConsensusState: "false_negative_suspected",
        repairOnlyCandidates: 0,
        submittedCandidateProof: false,
      },
      candidates: [],
    })
    expect(mapped.proofReceipts).toEqual([
      // B8: each report receipt now carries its explicit typed source policy.
      { source: "public_mwe", sourcePolicy: "public_repro", state: "base_green" },
      {
        source: "discovered_regression",
        sourcePolicy: "public_discovered_test",
        state: "static_only",
      },
      { source: "repro_consensus", sourcePolicy: "public_repro", state: "static_only" },
    ])
  })
})

// OPC-07 acceptance (A4): golden snapshots lock the FULL rendered shape of the
// three named failed cases — a regression fence that fails on ANY drift, paired
// with the behavioral intent tests below. Inputs are deterministic (hashes are
// sha256 of fixed text), so the snapshots are stable.
describe("OPC-07 3-case golden snapshots (full-shape regression fence)", () => {
  test("astropy env-failure intake packet", () => {
    expect(
      renderLlmEvidencePacket(
        buildIntakeLlmEvidencePacket({
          problemStatement: "astropy: import fails building C extension on the target env.",
          localizeCandidates: ["astropy/io/fits/header.py"],
          reproTest: {
            installed: false,
            reason: "env prep failed: gcc missing",
            samples: 0,
            reproducedCount: 0,
          },
        }),
      ),
    ).toMatchSnapshot()
  })

  test("django-11138 contract-only repair packet", () => {
    expect(
      buildRepairSeedPacket({
        problemStatement: "django-11138: tz conversion wrong across DB backends.",
        candidatePatchHash: "fixedhash11138",
        ownerEvidence: [
          {
            file: "django/db/backends/mysql/operations.py",
            symbols: [],
            provenance: "repair-owner",
          },
        ],
        proofReceipts: [{ source: "hard:proofRequiredMissing", state: "not_run" }],
        contracts: [
          { contractId: "owner-touch", authority: "static-witness/weak", satisfied: true },
        ],
        repairGuidance: "Satisfy the public proof before submit.",
      }),
    ).toMatchSnapshot()
  })

  test("django-14315 shell/env generation packet", () => {
    expect(
      buildSelectionGenerationPacket({
        problemStatement: "django-14315: dbshell ignores connection settings.",
        ownerEvidence: [
          {
            file: "django/db/backends/base/client.py",
            symbols: ["runshell"],
            provenance: "selection-owner",
          },
        ],
        contracts: [],
        reproCommand: "python -m pytest dbshell/tests -q",
        baseValidatedRed: true,
        verificationTarget: {
          primaryRail: {
            kind: "repro",
            cmd: "python -m pytest dbshell/tests -q",
            authority: "execution",
          },
          required: [
            { kind: "repro", cmd: "python -m pytest dbshell/tests -q", authority: "execution" },
          ],
          optional: [],
          baseValidatedRed: true,
        },
      }),
    ).toMatchSnapshot()
  })
})

// OPC-07 acceptance: the three failed cases must route to the right ask.
describe("llm evidence packet — 3-case packet semantics", () => {
  test("astropy env failure ⇒ infra state (env_prep_failed), never candidate blame", () => {
    const packet = buildIntakeLlmEvidencePacket({
      problemStatement: "astropy: import fails building C extension.",
      localizeCandidates: ["astropy/io/fits/x.py"],
      reproTest: {
        installed: false,
        reason: "env prep failed: gcc missing",
        samples: 0,
        reproducedCount: 0,
      },
    })
    const mwe = packet.proofReceipts.find(
      (r) => r.source === "public_mwe" && r.state !== "static_only",
    )
    expect(mwe?.state).toBe("env_prep_failed")
    expect(packet.proofReceipts.every((r) => r.state !== "candidate_red")).toBe(true)
  })

  test("django 11138 contract-only ⇒ repair asks bounded repair, not submit", () => {
    const rendered = buildRepairSeedPacket({
      problemStatement: "django: tz conversion across backends.",
      candidatePatchHash: "c0",
      ownerEvidence: [
        { file: "django/db/backends/mysql/operations.py", symbols: [], provenance: "repair-owner" },
      ],
      proofReceipts: [{ source: "hard:proofRequiredMissing", state: "not_run" }],
      contracts: [{ contractId: "owner-touch", authority: "static-witness/weak", satisfied: true }],
    })
    const parsed = parseRendered(rendered)
    const allowedActions = parsed.allowedActions as string[]
    expect(allowedActions).toContain("bounded_repair_only")
    expect(allowedActions.some((a) => /submit/.test(a))).toBe(false)
    expect(rendered).toContain("no_positive_executed_public_proof_attached")
  })

  test("django 14315 shell/env ⇒ generation carries the runshell proof command", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "django: dbshell ignores settings.",
      ownerEvidence: [
        { file: "django/db/backends/base/client.py", symbols: [], provenance: "selection-owner" },
      ],
      contracts: [],
      reproCommand: "python -m pytest dbshell/tests -q",
      baseValidatedRed: true,
    })
    expect(rendered).toContain('"command": "python -m pytest dbshell/tests -q"')
    expect(rendered).toContain('"state": "base_red"')
  })
})

// ── A4: bounded validated-repro truncation emits an omitted-count fact ─────────
describe("A4 — validatedReproScripts truncation surfaces an omitted-count fact", () => {
  const scriptsFacts = (rendered: string): Array<{ kind: string; value: string }> =>
    (parseRendered(rendered).staticFacts as Array<{ kind: string; value: string }>) ?? []

  test("3+ scripts ⇒ an omitted-count fact appears (no silent truncation)", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Some public bug.",
      ownerEvidence: [],
      contracts: [],
      validatedReproScripts: ["print('a')", "print('b')", "print('c')", "print('d')"],
    })
    const facts = scriptsFacts(rendered)
    const omitted = facts.find((f) => f.kind === "validated_public_repro_omitted")
    expect(omitted).toBeDefined()
    // 4 scripts, cap of 2 ⇒ 2 omitted.
    expect(omitted?.value).toContain("Omitted 2 additional")
    // exactly the capped number of scripts are rendered.
    expect(facts.filter((f) => f.kind === "validated_public_repro")).toHaveLength(2)
  })

  test("exactly 2 scripts ⇒ NO omitted-count fact (paired-control: only-N-existed)", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Some public bug.",
      ownerEvidence: [],
      contracts: [],
      validatedReproScripts: ["print('a')", "print('b')"],
    })
    expect(scriptsFacts(rendered).some((f) => f.kind === "validated_public_repro_omitted")).toBe(
      false,
    )
  })

  test("1 script ⇒ NO omitted-count fact", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Some public bug.",
      ownerEvidence: [],
      contracts: [],
      validatedReproScripts: ["print('a')"],
    })
    expect(scriptsFacts(rendered).some((f) => f.kind === "validated_public_repro_omitted")).toBe(
      false,
    )
  })
})

// ── B4: extractSymbolSlice precision (decorators / ambiguity / non-source) ─────
describe("B4 — extractSymbolSliceResult precision", () => {
  test("walks BACKWARD over contiguous @decorator lines and includes them", () => {
    const src = [
      "import os",
      "",
      "@cached",
      "@register('x')",
      "def target(a):",
      "    return a + 1",
      "",
      "def other():",
      "    pass",
    ].join("\n")
    const r = extractSymbolSliceResult(src, "target")
    expect(r.slice).toContain("@cached")
    expect(r.slice).toContain("@register('x')")
    expect(r.slice).toContain("def target(a):")
    expect(r.slice).not.toContain("def other")
    // back-compat string API also includes the decorators now.
    expect(extractSymbolSlice(src, "target")).toContain("@cached")
  })

  test("a blank line between decorator and def BREAKS the decorator chain (bounded)", () => {
    const src = ["@stale", "", "def target():", "    pass"].join("\n")
    const r = extractSymbolSliceResult(src, "target")
    expect(r.slice).toContain("def target():")
    expect(r.slice).not.toContain("@stale")
  })

  test("multiple same-name defs ⇒ matchCount>1 (ambiguity is a distinguishable signal)", () => {
    const src = ["def dup():", "    return 1", "", "def dup():", "    return 2"].join("\n")
    const r = extractSymbolSliceResult(src, "dup")
    expect(r.matchCount).toBe(2)
    expect(r.slice).toContain("return 1") // first match chosen
  })

  test("single def ⇒ matchCount===1, no ambiguity", () => {
    const r = extractSymbolSliceResult("def only():\n    return 1\n", "only")
    expect(r.matchCount).toBe(1)
  })

  test("decorators stay BOUNDED — a pathological decorator stack never exceeds maxLines", () => {
    const decos = Array.from({ length: 60 }, (_, i) => `@d${i}`).join("\n")
    const r = extractSymbolSliceResult(`${decos}\ndef target():\n    pass\n`, "target", 40)
    expect((r.slice ?? "").split("\n").length).toBeLessThanOrEqual(40)
    // the def line itself is always retained (closest decorators kept).
    expect(r.slice).toContain("def target():")
  })

  test("a decorator at a DIFFERENT indent is not swallowed into the slice", () => {
    const src = ["class C:", "    @m", "    def target(self):", "        pass"].join("\n")
    const r = extractSymbolSliceResult(src, "target")
    expect(r.slice).toContain("@m")
    expect(r.slice).toContain("def target")
    expect(r.slice).not.toContain("class C")
  })

  test("readable source, symbol absent ⇒ miss=not_found (distinguishable channel)", () => {
    const r = extractSymbolSliceResult("def a():\n    pass\n", "missing")
    expect(r.slice).toBeUndefined()
    expect(r.miss).toBe("not_found")
  })

  test("binary/non-source (NUL byte) ⇒ miss=non_source, NOT conflated with not_found", () => {
    const binary = `def x():\n${String.fromCharCode(0)}\n`
    const r = extractSymbolSliceResult(binary, "x")
    expect(r.slice).toBeUndefined()
    expect(r.miss).toBe("non_source")
  })

  test("assembleOwnerEvidence threads the ambiguity + non-source signals into owner facts", () => {
    const dupSrc = ["def dup():", "    return 1", "", "def dup():", "    return 2"].join("\n")
    const ambiguous = assembleOwnerEvidence({
      ownerFiles: ["m.py"],
      issueSymbols: ["dup"],
      readSource: () => dupSrc,
    })
    expect(ambiguous[0]?.ambiguousSliceMatch).toBe(true)

    const binary = assembleOwnerEvidence({
      ownerFiles: ["m.py"],
      issueSymbols: ["dup"],
      readSource: () => `${String.fromCharCode(0)}garbage`,
    })
    expect(binary[0]?.sliceMiss).toBe("non_source")
  })
})

// ── B5: owner-test / module-smoke RESULT receipt — result only, command fenced ─
describe("B5 — ownerTestResultReceipt (result only, command WITHHELD)", () => {
  test("renders a result state + source policy, NEVER a command", () => {
    const receipt = ownerTestResultReceipt({ kind: "owner_test", result: "red" })
    expect(receipt.state).toBe("candidate_red")
    expect(receipt.source).toBe("owner_test")
    expect(receipt.sourcePolicy).toBe("official_hidden_withheld")
    expect(receipt.cmdWithheld).toBe(true)
    expect(receipt.command).toBeUndefined()
  })

  test("green result ⇒ candidate_green; infra ⇒ execution_failed; absent ⇒ not_run", () => {
    expect(ownerTestResultReceipt({ kind: "module_smoke", result: "green" }).state).toBe(
      "candidate_green",
    )
    expect(ownerTestResultReceipt({ kind: "owner_test", result: "infra_failed" }).state).toBe(
      "execution_failed",
    )
    expect(ownerTestResultReceipt({ kind: "owner_test", result: "not_run" }).state).toBe("not_run")
  })

  test("the receipt renders into a candidate_post_review packet WITHOUT any command text", () => {
    const receipt = ownerTestResultReceipt({ kind: "owner_test", result: "red" })
    const rendered = buildCandidatePostReviewPacket({
      problemStatement: "Owner test fails for the public bug.",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [],
      proofReceipts: [receipt],
      contracts: [],
    })
    expect(rendered).toContain('"state": "candidate_red"')
    expect(rendered).toContain('"cmdWithheld": true')
    // C3 fence: the rendered packet must not contain pytest/path selectors.
    expect(rendered).not.toMatch(/pytest|::|\.py/)
    // and blindness still holds.
    expect(() =>
      assertPacketBlind(
        buildCandidatePostReviewLlmEvidencePacket({
          problemStatement: "Owner test fails.",
          candidatePatchHash: "deadbeef",
          ownerEvidence: [],
          proofReceipts: [receipt],
          contracts: [],
        }),
      ),
    ).not.toThrow()
  })
})

// ── B8: typed source-policy class on proof receipts ───────────────────────────
describe("B8 — ProofReceiptFact source policy is explicit + typed", () => {
  test("sourcePolicyOf classifies known identifiers and hard deterministic reasons", () => {
    expect(sourcePolicyOf("public_mwe")).toBe("public_repro")
    expect(sourcePolicyOf("discovered_regression")).toBe("public_discovered_test")
    expect(sourcePolicyOf("repro_consensus")).toBe("public_repro")
    expect(sourcePolicyOf("selection")).toBe("static")
    expect(sourcePolicyOf("hard:proofRequiredMissing")).toBe("static")
    expect(sourcePolicyOf("module_smoke")).toBe("official_hidden_withheld")
    expect(sourcePolicyOf("totally-unknown")).toBeUndefined()
  })

  test("render path FAILS CLOSED when a proof receipt has an unknown source and no explicit policy", () => {
    expect(() =>
      renderLlmEvidencePacket({
        stage: "candidate_post_review",
        instanceIdHash: "x",
        evidenceRevision: "v",
        candidatePatchHash: "c",
        question: "q",
        allowedActions: [],
        forbiddenSources: [],
        publicIssueFacts: [],
        ownerEvidence: [],
        proofReceipts: [{ source: "totally-unknown", state: "not_run" }],
        contractFacts: [],
        staticFacts: [],
        missingEvidence: [],
      }),
    ).toThrow(ProofReceiptSourcePolicyError)
  })

  test("in-file producers emit an explicit typed sourcePolicy", () => {
    const intake = buildIntakeLlmEvidencePacket({
      problemStatement: "A public bug in run().",
      localizeCandidates: ["pkg/x.py"],
      reproTest: { installed: false, reason: "env prep failed", samples: 0, reproducedCount: 0 },
    })
    // env failure ⇒ infra policy (not a public-repro verdict).
    expect(
      intake.proofReceipts.some((r) => r.state === "env_prep_failed" && r.sourcePolicy === "infra"),
    ).toBe(true)
    // the static issue-seed receipt is public_issue provenance.
    expect(
      intake.proofReceipts.some(
        (r) => r.state === "static_only" && r.sourcePolicy === "public_issue",
      ),
    ).toBe(true)

    const gen = buildSelectionGenerationLlmEvidencePacket({
      problemStatement: "A public bug.",
      ownerEvidence: [],
      contracts: [],
      reproCommand: "python repro.py",
      baseValidatedRed: true,
    })
    expect(gen.proofReceipts[0]?.sourcePolicy).toBe("public_repro")
  })

  test("sourcePolicy is a CLOSED union: a leaked free string fails the type contract", () => {
    // A valid typed receipt compiles.
    const ok: ProofReceiptFact = {
      source: "public_mwe",
      sourcePolicy: "public_repro",
      state: "candidate_red",
    }
    expect(ok.sourcePolicy).toBe("public_repro")
    // B8 TYPE FENCE: a free-string policy must NOT typecheck. The @ts-expect-error
    // below is itself an assertion — if the union ever reopens to `string`, the
    // suppressed error disappears and `@ts-expect-error` becomes an UNUSED-directive
    // compile error, going red at typecheck:tests time.
    const leaked = {
      source: "x",
      // @ts-expect-error — `gold_patch` is not a member of the closed source-policy union.
      sourcePolicy: "gold_patch" satisfies ProofReceiptSourcePolicy,
      state: "not_run",
    }
    expect(leaked.source).toBe("x")
  })
})

import { describe, expect, test } from "bun:test"
import {
  buildCandidatePostReviewPacket,
  assembleOwnerEvidence,
  assertPacketBlind,
  buildCandidateReviewPacket,
  buildSelectionOwnerEvidence,
  buildIntakeLlmEvidencePacket,
  buildRepairSeedPacket,
  buildSelectionExplanationPacket,
  buildSelectionGenerationPacket,
  buildSelectionGenerationPrompt,
  candidatePatchHash,
  extractSymbolSlice,
  type LlmEvidenceArtifacts,
  type LlmEvidencePacket,
  opaqueInstanceIdHash,
  PacketBlindnessViolation,
  recordLlmEvidencePacket,
  renderLlmEvidencePacket,
  summarizeLlmEvidenceArtifacts,
  verificationTargetFromPlan,
} from "@/runner/batch/eval/llm-evidence-packet"
import { makeStaticWitness } from "@/runner/batch/eval/static-witness"

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
      contractFacts: [{ contractId: "multi-site-family:x.py", authority: "static-witness", satisfied: false }],
      staticFacts: [{ kind: "edit_surface", value: "preserve bounded" }],
      missingEvidence: [{ kind: "regression", reason: "no_issue_positive_public_regression_proof" }],
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

  test("post-exec review packet carries executed proof receipts without pretending to be a winner decision", () => {
    const rendered = buildCandidatePostReviewPacket({
      problemStatement: "Axis inversion still fails when explicit limits are preserved.",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [{ file: "pkg/axis.py", symbols: ["invert_axis"], provenance: "repair-owner" }],
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
    expect((artifacts as { candidateGenerationHistory?: unknown[] }).candidateGenerationHistory).toHaveLength(2)
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
    const ev = assembleOwnerEvidence({ ownerFiles: ["m.py"], issueSymbols: ["foo"], readSource: () => null })
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
      candidates: [{ file: "pkg/core.py", score: 5, sources: ["issue-file", "owner-resolve"], symbols: ["run"] }],
      issueSymbols: ["run"],
      truncated: false,
      partial: false,
    },
    verificationPlan: VERIFICATION_PLAN,
    reproTest: { installed: false, reason: "no_reproduced_candidate", samples: 3, reproducedCount: 0 },
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
    expect(packet.missingEvidence.some((m) => m.reason === "public_mwe_base_not_attempted")).toBe(false)
    expect(packet.proofReceipts.some((r) => r.source === "public_mwe")).toBe(true)
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
      contracts: [{ contractId: "owner-touch", authority: "static-witness/weak", satisfied: "unknown" }],
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
    expect(packet.allowedActions.every((a) => !/submit|admit|override|select_winner/.test(a))).toBe(true)
    expect(packet.forbiddenSources).toContain("selection_override")
  })

  test("surfaces the deterministic outcome + typed candidate breakdown", () => {
    expect(packet.staticFacts.some((s) => s.kind === "selected_candidate" && s.value === "<none>")).toBe(true)
    expect(packet.contractFacts.some((c) => c.contractId === "candidate:cand-0")).toBe(true)
    expect(packet.missingEvidence.some((m) => m.reason === "no_positive_executed_public_proof")).toBe(true)
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
      { source: "public_mwe", state: "base_green" },
      { source: "discovered_regression", state: "static_only" },
      { source: "repro_consensus", state: "static_only" },
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
          reproTest: { installed: false, reason: "env prep failed: gcc missing", samples: 0, reproducedCount: 0 },
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
          { file: "django/db/backends/mysql/operations.py", symbols: [], provenance: "repair-owner" },
        ],
        proofReceipts: [{ source: "hard:proofRequiredMissing", state: "not_run" }],
        contracts: [{ contractId: "owner-touch", authority: "static-witness/weak", satisfied: true }],
        repairGuidance: "Satisfy the public proof before submit.",
      }),
    ).toMatchSnapshot()
  })

  test("django-14315 shell/env generation packet", () => {
    expect(
      buildSelectionGenerationPacket({
        problemStatement: "django-14315: dbshell ignores connection settings.",
        ownerEvidence: [
          { file: "django/db/backends/base/client.py", symbols: ["runshell"], provenance: "selection-owner" },
        ],
        contracts: [],
        reproCommand: "python -m pytest dbshell/tests -q",
        baseValidatedRed: true,
        verificationTarget: {
          primaryRail: { kind: "repro", cmd: "python -m pytest dbshell/tests -q", authority: "execution" },
          required: [{ kind: "repro", cmd: "python -m pytest dbshell/tests -q", authority: "execution" }],
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
      reproTest: { installed: false, reason: "env prep failed: gcc missing", samples: 0, reproducedCount: 0 },
    })
    const mwe = packet.proofReceipts.find((r) => r.source === "public_mwe" && r.state !== "static_only")
    expect(mwe?.state).toBe("env_prep_failed")
    expect(packet.proofReceipts.every((r) => r.state !== "candidate_red")).toBe(true)
  })

  test("django 11138 contract-only ⇒ repair asks bounded repair, not submit", () => {
    const rendered = buildRepairSeedPacket({
      problemStatement: "django: tz conversion across backends.",
      candidatePatchHash: "c0",
      ownerEvidence: [{ file: "django/db/backends/mysql/operations.py", symbols: [], provenance: "repair-owner" }],
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
      ownerEvidence: [{ file: "django/db/backends/base/client.py", symbols: [], provenance: "selection-owner" }],
      contracts: [],
      reproCommand: "python -m pytest dbshell/tests -q",
      baseValidatedRed: true,
    })
    expect(rendered).toContain('"command": "python -m pytest dbshell/tests -q"')
    expect(rendered).toContain('"state": "base_red"')
  })
})

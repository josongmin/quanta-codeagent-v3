import { describe, expect, test } from "bun:test"
import {
  buildIntakeLlmEvidencePacket,
  buildSelectionExplanationPacket,
  candidatePatchHash,
  opaqueInstanceIdHash,
  renderLlmEvidencePacket,
} from "@/runner/batch/eval/llm-evidence-packet"

describe("llm evidence packet", () => {
  test("renders a bounded typed packet with stable hashes", () => {
    const problem = "Public issue text"
    const patch = "+++ b/x.py\n+fix"
    const rendered = renderLlmEvidencePacket({
      stage: "repair_seed",
      instanceIdHash: opaqueInstanceIdHash(problem),
      evidenceRevision: "test-v1",
      candidatePatchHash: candidatePatchHash(patch),
      question: "Generate a bounded repair instruction for the next candidate.",
      allowedActions: ["repair_only"],
      forbiddenSources: ["hidden_tests", "gold_patch"],
      publicIssueFacts: [problem],
      ownerEvidence: ["x.py"],
      proofReceipts: ["public MWE stayed red on candidate"],
      contractFacts: ["multi-site-family:x.py"],
      staticFacts: ["preserve bounded edit surface"],
      missingEvidence: ["no issue-positive public regression proof"],
    })

    expect(rendered).toContain("## LLM Evidence Packet")
    expect(rendered).toContain('"stage": "repair_seed"')
    expect(rendered).toContain('"candidatePatchHash"')
    expect(rendered).toContain('"allowedActions"')
    expect(rendered).toContain('"forbiddenSources"')
    expect(rendered).toContain('"proofReceipts"')
    expect(rendered).toContain('"missingEvidence"')
    expect(opaqueInstanceIdHash(problem)).toHaveLength(16)
    expect(candidatePatchHash(patch)).toHaveLength(16)
  })

  test("builds an intake packet from public issue + proof metadata only", () => {
    const packet = buildIntakeLlmEvidencePacket({
      problemStatement: `
The callback should stop raising.

Expected: "clean"

\`\`\`python
import pkg
pkg.run()
\`\`\`
`,
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
      verificationPlan: {
        primaryRail: {
          kind: "repro",
          cmd: "python repro.py",
          authority: "execution",
          successPredicate: { type: "stdout_contains", substring: "Issue resolved" },
        },
        required: [
          {
            kind: "repro",
            cmd: "python repro.py",
            authority: "execution",
            successPredicate: { type: "stdout_contains", substring: "Issue resolved" },
          },
        ],
        optional: [],
        baseValidatedRed: false,
      },
      reproTest: {
        installed: false,
        reason: "no_reproduced_candidate",
        samples: 3,
        reproducedCount: 0,
        sampleOutcomes: ["resolved", "resolved", "resolved"],
      },
    })

    expect(packet.stage).toBe("intake")
    expect(packet.question).toContain("Which allowed evidence source")
    expect(packet.ownerEvidence.join("\n")).toContain("pkg/core.py")
    expect(packet.proofReceipts.join("\n")).toContain("public MWE")
    expect(packet.contractFacts.join("\n")).toContain("baseValidatedRed=false")
    expect(packet.forbiddenSources).toContain("official_harness_results")
    expect(packet.forbiddenSources).not.toContain("gold_patch_path")
  })

  test("builds a selection explanation packet without submit authority", () => {
    const packet = buildSelectionExplanationPacket({
      problemStatement: "Time zone conversion is wrong across backends",
      ownerFiles: ["django/db/backends/mysql/operations.py", "django/db/backends/sqlite3/operations.py"],
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
          proofSource: "none",
          requiredContractsSatisfied: 1,
          contractsSatisfied: 1,
        },
      ],
    })

    expect(packet.stage).toBe("selection_explanation")
    expect(packet.allowedActions).toContain("explain_selection_outcome")
    expect(packet.forbiddenSources).toContain("selection_override")
    expect(packet.staticFacts.join("\n")).toContain("selected candidate: <none>")
    expect(packet.missingEvidence).toContain("no_positive_executed_public_proof")
    expect(packet.contractFacts.join("\n")).toContain("cand-0")
  })
})

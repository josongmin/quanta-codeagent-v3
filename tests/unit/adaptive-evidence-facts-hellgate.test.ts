/**
 * Hellgate for the v5 router evidence-facts contract (jun-22 Wave-1). The gap
 * classifier must be a total, deterministic, ONE-fact-one-gap function (paired
 * control: flip a single signal → exactly one gap toggles), and EvidenceFacts
 * must plug into the generic controller as `P` with `evidenceIdsOf` as the
 * citation scope.
 */

import { describe, expect, test } from "bun:test"
import {
  type AdaptiveExecutorInput,
  type AdaptiveRouterInput,
  buildRouterPrompt,
  deriveEvidenceGaps,
  type EvidenceFacts,
  evidenceIdsOf,
  fullyEvidencedFacts,
  renderEvidenceFacts,
  runAdaptiveEscalation,
} from "@/runner/batch/eval/adaptive-escalation"

const IDS = {
  issueId: "ev:issue",
  candidateId: "ev:cand",
  ownersId: "ev:owners",
  proofId: "ev:proof",
}
const clean = (): EvidenceFacts => fullyEvidencedFacts(IDS)

describe("router evidence facts", () => {
  test("FACTS-1: a fully-evidenced facts object yields ZERO gaps", () => {
    expect(deriveEvidenceGaps(clean())).toEqual([])
  })

  describe("FACTS-2: each signal toggles EXACTLY one gap (paired-control)", () => {
    const cases: ReadonlyArray<{ patch: Partial<EvidenceFacts>; gap: string }> = [
      { patch: { localizationCertain: false }, gap: "localization_uncertain" },
      { patch: { declaredConditionEvidenced: false }, gap: "issue_condition_not_evidenced" },
      { patch: { positiveProof: false }, gap: "candidate_no_positive_proof" },
      { patch: { multiOwnerLikely: true }, gap: "multi_owner_likely" },
      { patch: { baseReproEstablished: false }, gap: "base_repro_missing" },
      { patch: { regressionSignal: false }, gap: "regression_signal_missing" },
      { patch: { infraBlocked: true }, gap: "infra_blocked" },
    ]
    for (const { patch, gap } of cases) {
      test(gap, () => {
        expect(deriveEvidenceGaps({ ...clean(), ...patch })).toEqual([gap as never])
      })
    }
  })

  test("FACTS-3: a declared condition of null contributes NO gap (issue declares none)", () => {
    expect(deriveEvidenceGaps({ ...clean(), declaredConditionEvidenced: null })).toEqual([])
  })

  test("FACTS-4: multiple deficits accumulate, order-stable", () => {
    const gaps = deriveEvidenceGaps({
      ...clean(),
      localizationCertain: false,
      positiveProof: false,
      infraBlocked: true,
    })
    expect(gaps).toEqual(["localization_uncertain", "candidate_no_positive_proof", "infra_blocked"])
  })

  test("FACTS-5: evidenceIdsOf exposes exactly the four section ids", () => {
    expect([...evidenceIdsOf(clean())].sort()).toEqual(
      ["ev:cand", "ev:issue", "ev:owners", "ev:proof"].sort(),
    )
  })

  test("FACTS-6: render carries every citable id and feeds the router prompt", () => {
    const body = renderEvidenceFacts(clean())
    for (const id of evidenceIdsOf(clean())) expect(body).toContain(id)
    expect(buildRouterPrompt(body)).toContain(body)
  })

  test("INTEGRATE-1: EvidenceFacts is a valid controller P; citing a real id parses", async () => {
    const router = (input: AdaptiveRouterInput<EvidenceFacts>): Promise<unknown> =>
      Promise.resolve(
        input.packet.positiveProof
          ? {
              action: "accept_thin",
              evidenceGaps: [],
              citedEvidenceIds: ["ev:proof"],
              why: "positive proof is now present",
            }
          : {
              action: "run_proof_clean",
              evidenceGaps: ["candidate_no_positive_proof"],
              citedEvidenceIds: ["ev:proof"],
              why: "no positive proof yet",
            },
      )
    const calls: AdaptiveExecutorInput<EvidenceFacts>[] = []
    const result = await runAdaptiveEscalation<EvidenceFacts>({
      initialPacket: { ...clean(), positiveProof: false },
      citableIds: evidenceIdsOf,
      router,
      executor: (input) => {
        calls.push(input)
        return Promise.resolve({ packet: clean() })
      },
    })
    expect(result.outcome).toBe("finalize")
    expect(calls.length).toBe(1)
  })

  test("INTEGRATE-2: citing an id NOT in the facts fails closed (escalate, no exec)", async () => {
    const calls: unknown[] = []
    const result = await runAdaptiveEscalation<EvidenceFacts>({
      initialPacket: clean(),
      citableIds: evidenceIdsOf,
      router: () =>
        Promise.resolve({
          action: "run_proof_clean",
          evidenceGaps: [],
          citedEvidenceIds: ["ev:not-in-packet"],
          why: "x",
        }),
      executor: (input) => {
        calls.push(input)
        return Promise.resolve({ packet: clean() })
      },
    })
    expect(result.outcome).toBe("escalate_needs_human")
    expect(result.reason).toContain("uncited_evidence_id")
    expect(calls.length).toBe(0)
  })
})

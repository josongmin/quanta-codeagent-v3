/**
 * FIX 1 + FIX 2 unit proofs for selection-repair-seed.ts.
 *
 * FIX 1 — the repair-plan IIFE was collapsed into a declarative ORDERED rule
 * table (`REPAIR_PLAN_RULES`) + first-match `selectRepairPlan`. These tests pin:
 *   - each branch returns its EXACT plan (summary + directive + 3
 *     include-flags), copied verbatim from the original literals;
 *   - PRIORITY/short-circuit: an input matching branch 2 AND branch 4 returns
 *     branch 2's plan (the earlier rule wins, exactly like the old if-cascade);
 *   - no-match ⇒ undefined.
 *
 * FIX 2 — `hardReasonState` now maps from the STRUCTURED `hard:<kind>=` KIND
 * identifier instead of loose substring/`=false` matching. These tests pin the
 * 7 known reason constants (characterization vs the documented OLD output) PLUS
 * the bug-fix regression: a `hard:<x>=false` whose kind is unknown must now be
 * "not_run" (was wrongly "candidate_red" under the old `/=false/` alt).
 *
 * No instance id / gold path / FAIL_TO_PASS regex.
 */
import { describe, expect, it } from "bun:test"
import type { CandidateVerdict, ResolvedKofNSignal } from "@/agent/verification-bundle"
import type { MweProofReceipt } from "@/runner/batch/eval/mwe-proof"
import {
  hardReasonState,
  type RepairPlanContext,
  selectRepairPlan,
} from "@/runner/batch/eval/selection-repair-seed"
import type {
  Candidate,
  ScoredEntry,
  SelectionProofState,
} from "@/runner/batch/eval/selection-types"

const diff = (f: string) =>
  `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,1 @@\n-old\n+new`

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  patch: diff(`pkg/${id}.py`),
  turns: 1,
  files: [`pkg/${id}.py`],
  baseValidatedRed: true,
  ...over,
})

const verdict = (reasons: readonly string[], admissible = false): CandidateVerdict => ({
  admissible,
  score: 0,
  reasons: [...reasons],
})

const entry = (candidate: Candidate, over: Partial<ScoredEntry> = {}): ScoredEntry => ({
  candidate,
  hard: { baseValidatedRed: true, patchProduced: true },
  resolvedKofN: null,
  voterQuorum: null,
  verdict: verdict([], false),
  requiredContractsSatisfied: 0,
  contractsSatisfied: 0,
  ...over,
})

const ctx = (over: Partial<RepairPlanContext> = {}): RepairPlanContext => ({
  scored: [],
  patched: [],
  proofStates: [],
  proofRequired: false,
  ...over,
})

// ── The 5 plan literals, copied verbatim from selection-repair-seed.ts ────────
const INFRA_PLAN = {
  summary:
    "Selector feedback: every generated candidate reached public proof execution, but each run failed in infra/runtime without producing a candidate-correctness verdict.",
  directive:
    "Regenerate from the base tree. Preserve the strongest structural/public coverage already found, but remove candidate-side execution blockers so the named public proof can actually run to completion. Do not widen scope or invent unrelated helpers.",
  includeFamilyRepair: true,
  includeReproFailureTrace: false,
  includeOracleFailureSeed: true,
}
const MWE_PLAN = {
  summary:
    "Selector feedback: every generated candidate was executed against a public issue MWE that reproduced on the base tree, and every candidate still failed that MWE.",
  directive:
    "Regenerate from the base tree. Treat the public MWE in the issue text as the executable contract: the patch must make that MWE pass without broadening the edit beyond the necessary source change.",
  includeFamilyRepair: true,
  includeReproFailureTrace: false,
  includeOracleFailureSeed: true,
}
const REPRO_PLAN = {
  summary:
    "Selector feedback: every generated candidate was re-run against the base-red validated reproduction set, and none reached resolved consensus.",
  directive:
    "Regenerate from the base tree. Treat the validated reproduction script(s) below as public executable contracts: the patch must make the scripts pass cleanly (all assertions green / exit 0) without adding unnecessary helpers, files, or unrelated design surface.",
  includeFamilyRepair: true,
  includeReproFailureTrace: true,
  includeOracleFailureSeed: true,
}
const FAMILY_MISSING_PLAN = {
  summary:
    "Selector feedback: at least one generated candidate selected a typed static family but edited only a partial family surface.",
  directive:
    "Regenerate from the base tree. Complete the missing family owner files named below if public source evidence confirms the family relation; otherwise produce no patch for that family rather than a partial single-site edit. The next candidate still must satisfy positive executed public proof before submit.",
  includeFamilyRepair: true,
  includeReproFailureTrace: true,
  includeOracleFailureSeed: true,
}
const CLEAN_DRIFT_PLAN = {
  summary:
    "Selector feedback: every generated multi-source candidate was rejected as unproven multi-source drift by clean selector authority because no executable proof or public contract justified touching multiple source files.",
  directive:
    "Regenerate from the base tree. Either produce a narrow single-owner patch, or include the complete static/public witness that justifies every source file touched. Do not add helper files, new definitions, or unrelated design surface unless that witness requires them.",
  includeFamilyRepair: false,
  includeReproFailureTrace: false,
  includeOracleFailureSeed: true,
}
const CONTRACT_ONLY_PLAN = {
  summary:
    "Selector feedback: at least one generated candidate achieved structural/public contract coverage, but no candidate produced positive executed public proof.",
  directive:
    "Regenerate from the base tree. Preserve the strongest structural/public coverage already found and make the named public proof run green. Do not broaden file scope, add unrelated helpers, or substitute structural guesses for executed proof.",
  includeFamilyRepair: true,
  includeReproFailureTrace: false,
  includeOracleFailureSeed: true,
}

// Reject-reason constants from selection-gates.ts (verbatim).
const CLEAN_DRIFT_REJECT_REASON =
  "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)"

const mweRed = (id: string): ScoredEntry =>
  entry(cand(id, { mweReceipt: { state: "candidate_red" } as MweProofReceipt }))

const reproUnresolved = (id: string): ScoredEntry => {
  const signal: ResolvedKofNSignal = { votes: 0, k: 3 }
  return entry(cand(id), { resolvedKofN: signal })
}

describe("FIX 1 — selectRepairPlan ordered rule table", () => {
  it("branch 1 (infra-blocked): proofRequired + receipt present + all proofStates infra_blocked", () => {
    const e = entry(cand("a", { mweReceipt: { state: "execution_failed" } as MweProofReceipt }))
    const plan = selectRepairPlan(
      ctx({
        scored: [e],
        patched: [e],
        proofStates: ["infra_blocked"] as SelectionProofState[],
        proofRequired: true,
      }),
    )
    expect(plan).toEqual(INFRA_PLAN)
  })

  it("branch 2 (mweOracle): every patched candidate is mwe candidate_red, none patched_green", () => {
    const scored = [mweRed("a"), mweRed("b")]
    const plan = selectRepairPlan(ctx({ scored, patched: scored }))
    expect(plan).toEqual(MWE_PLAN)
  })

  it("branch 3 (reproOracle): all patched unresolved K-of-N + oracle seed text present", () => {
    const scored = [reproUnresolved("a"), reproUnresolved("b")]
    const plan = selectRepairPlan(
      ctx({ scored, patched: scored, oracleFailureSeedText: "REPRO SCRIPT" }),
    )
    expect(plan).toEqual(REPRO_PLAN)
  })

  it("branch 4 (family-missing): proofRequired + partial typed family coverage gets a repair seed", () => {
    const e = entry(
      cand("a", {
        files: ["django/db/backends/postgresql/client.py"],
        familyId: "override-family",
        familyOwnerFiles: [
          "django/db/backends/base/client.py",
          "django/db/backends/postgresql/client.py",
        ],
      }),
    )
    const plan = selectRepairPlan(
      ctx({
        scored: [e],
        patched: [e],
        proofStates: ["candidate_red", "infra_blocked"] as SelectionProofState[],
        proofRequired: true,
      }),
    )
    expect(plan).toEqual(FAMILY_MISSING_PLAN)
  })

  it("branch 5 (cleanDrift): every patched candidate rejected as multi-source drift", () => {
    const scored = [
      entry(cand("a"), { verdict: verdict([CLEAN_DRIFT_REJECT_REASON]) }),
      entry(cand("b"), { verdict: verdict([CLEAN_DRIFT_REJECT_REASON]) }),
    ]
    const plan = selectRepairPlan(ctx({ scored, patched: scored }))
    expect(plan).toEqual(CLEAN_DRIFT_PLAN)
  })

  it("branch 6 (contract-only): proofRequired, no proof_positive, contract-only evidence present", () => {
    const e = entry(cand("a"), { requiredContractsSatisfied: 1 })
    const plan = selectRepairPlan(
      ctx({
        scored: [e],
        patched: [e],
        proofStates: ["proof_missing"] as SelectionProofState[],
        proofRequired: true,
      }),
    )
    expect(plan).toEqual(CONTRACT_ONLY_PLAN)
  })

  it("PRIORITY: input matching branch 2 AND cleanDrift returns branch 2 (earlier rule wins)", () => {
    // Each entry is BOTH mwe candidate_red (branch 2) AND clean-drift rejected.
    const both = (id: string): ScoredEntry =>
      entry(cand(id, { mweReceipt: { state: "candidate_red" } as MweProofReceipt }), {
        verdict: verdict([CLEAN_DRIFT_REJECT_REASON]),
      })
    const scored = [both("a"), both("b")]
    const plan = selectRepairPlan(ctx({ scored, patched: scored }))
    // Sanity: cleanDrift WOULD match this input in isolation.
    expect(scored.every((s) => s.verdict.reasons.includes(CLEAN_DRIFT_REJECT_REASON))).toBe(true)
    // But branch 2 is earlier in the table, so it wins.
    expect(plan).toEqual(MWE_PLAN)
  })

  it("no rule matches ⇒ undefined", () => {
    expect(selectRepairPlan(ctx())).toBeUndefined()
    // A patched candidate with no receipts / no rejection and proofRequired=false: still no match.
    const e = entry(cand("a"))
    expect(selectRepairPlan(ctx({ scored: [e], patched: [e] }))).toBeUndefined()
  })
})

describe("FIX 2 — hardReasonState maps from the structured kind", () => {
  // The 7 known reason constants → documented OLD output (characterization).
  const KNOWN: ReadonlyArray<[string, string]> = [
    [
      "hard:proofInfraBlocked=true (public proof execution failed; do not treat this as candidate correctness)",
      "execution_failed",
    ],
    [
      "hard:proofRequiredMissing=true (proof-required mode requires positive executed proof; safety or structural evidence alone cannot submit)",
      "not_run",
    ],
    [
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
      "not_run",
    ],
    ["hard:mweProof=candidate_red (public issue MWE still fails after patch)", "candidate_red"],
    [
      "hard:cleanProofAuthorityMissing=true (clean mode has no owner, executable proof, public contract, or static witness authority)",
      "not_run",
    ],
    [
      "hard:declaredExpectedMatch=false (candidate contradicts issue-declared expected behavior)",
      "candidate_red",
    ],
    ["hard:staticSanity=pythonNoneSubscriptMutation(cache) (parse-level violation)", "static_only"],
  ]

  for (const [reason, expected] of KNOWN) {
    it(`known reason → ${expected}: ${reason.slice(0, 48)}…`, () => {
      expect(hardReasonState(reason)).toBe(expected)
    })
  }

  it("BUG-FIX regression: hard:requiredContract=false now → not_run (was wrongly candidate_red under the old /=false/ alt)", () => {
    // Under the OLD function, `/=false/` matched ANY `hard:<x>=false` reason and
    // misclassified it as "candidate_red". The kind `requiredContract` is NOT in
    // the known map, so the fixed function returns the default "not_run".
    expect(hardReasonState("hard:requiredContract=false (some future hard gate)")).toBe("not_run")
  })

  it("unstructured / non-hard reason → not_run (default)", () => {
    expect(hardReasonState("soft:minimality")).toBe("not_run")
    expect(hardReasonState("")).toBe("not_run")
  })
})

/**
 * PMX-03 — the ONE fixture-driven classification table.
 *
 * Every test drives the REAL classifier over REAL upstream-shaped rows and
 * observes the returned disposition. The table itself is exercised through
 * `classifyOfficialPair`, never re-asserted as data against itself.
 *
 * Anti-vacuum rails in this file:
 *  - a COUNT FLOOR proving the fixture set covers all 7 upstream states in the
 *    model position AND all 7 in the golden position (a shrunken fixture set
 *    fails instead of silently testing less);
 *  - a coverage proof that all 4 outcome states and every declared reason are
 *    actually produced by fixtures;
 *  - a RED-ON-INJECTION proof: the same assertions run against a deliberately
 *    corrupted copy of the table and MUST fail, so a passing table test cannot
 *    be passing vacuously.
 */
import { describe, expect, test } from "bun:test"
import type {
  GoldenAuthority,
  ModelOutcome,
  OfficialFinalResult,
} from "@/apps/bench/harness/promax"
import {
  assertClassificationTablesInSync,
  classifyOfficialPair,
  classifyWithTables,
  GOLDEN_AUTHORITY_TABLE,
  isOfficialFinalResult,
  MODEL_OUTCOME_TABLE,
  OFFICIAL_FINAL_RESULTS,
} from "@/apps/bench/harness/promax"
import type { OfficialGradeReason, OfficialGradeState } from "@/runner/batch/eval/official-grade"
import {
  GRADING_VALID_BY_STATE,
  OFFICIAL_GRADE_REASONS,
  OFFICIAL_GRADE_STATE_BY_REASON,
  OFFICIAL_GRADE_STATES,
} from "@/runner/batch/eval/official-grade"
import { UPSTREAM_FINAL_RESULTS } from "./promax-official-fixtures"

/** golden × model → expected outcome. Transcribed from the PMX-03 table. */
interface Case {
  readonly golden: OfficialFinalResult
  readonly model: OfficialFinalResult
  readonly state: OfficialGradeState
  readonly reason: OfficialGradeReason
}

const GOLDEN_SUCCESS_CASES: readonly Case[] = [
  { golden: "success", model: "success", state: "resolved", reason: "official_resolved" },
  {
    golden: "success",
    model: "apply_failed",
    state: "model_miss",
    reason: "patch_apply_failed",
  },
  {
    golden: "success",
    model: "test_patch_apply_failed",
    state: "model_miss",
    reason: "test_patch_apply_failed",
  },
  {
    golden: "success",
    model: "timeout_apply",
    state: "model_miss",
    reason: "model_apply_timeout",
  },
  {
    golden: "success",
    model: "timeout_eval",
    state: "model_miss",
    reason: "model_eval_timeout",
  },
  { golden: "success", model: "non zero exit", state: "model_miss", reason: "test_failed" },
  {
    golden: "success",
    model: "need_human_review",
    state: "ambiguous",
    reason: "upstream_need_human_review",
  },
]

const GOLDEN_BLOCKING_REASON: Readonly<Record<string, OfficialGradeReason>> = {
  apply_failed: "golden_apply_failed",
  test_patch_apply_failed: "golden_test_patch_apply_failed",
  timeout_apply: "golden_timeout_apply",
  timeout_eval: "golden_timeout_eval",
  "non zero exit": "golden_non_zero_exit",
}

/** golden non-success × EVERY model state — golden authority must dominate. */
const GOLDEN_BLOCKED_CASES: readonly Case[] = OFFICIAL_FINAL_RESULTS.flatMap((golden) => {
  if (golden === "success") return []
  return OFFICIAL_FINAL_RESULTS.map((model): Case => {
    if (golden === "need_human_review") {
      return { golden, model, state: "ambiguous", reason: "upstream_need_human_review" }
    }
    const reason = GOLDEN_BLOCKING_REASON[golden]
    if (reason === undefined) throw new Error(`fixture gap: no blocking reason for ${golden}`)
    return { golden, model, state: "infra_invalid", reason }
  })
})

const ALL_CASES: readonly Case[] = [...GOLDEN_SUCCESS_CASES, ...GOLDEN_BLOCKED_CASES]

/** Run every fixture case through a (possibly injected) pair of tables. */
const runAllCases = (
  golden: Record<OfficialFinalResult, GoldenAuthority>,
  model: Record<OfficialFinalResult, ModelOutcome>,
): void => {
  for (const c of ALL_CASES) {
    const got = classifyWithTables(c.golden, c.model, {
      goldenAuthority: golden,
      modelOutcome: model,
    })
    expect({ pair: `${c.golden} | ${c.model}`, ...got }).toEqual({
      pair: `${c.golden} | ${c.model}`,
      state: c.state,
      reason: c.reason,
    })
  }
}

describe("PMX-03 classification table", () => {
  test("every golden×model pair classifies exactly as the ticket table says", () => {
    for (const c of ALL_CASES) {
      const got = classifyOfficialPair(c.golden, c.model)
      expect({ pair: `${c.golden} | ${c.model}`, ...got }).toEqual({
        pair: `${c.golden} | ${c.model}`,
        state: c.state,
        reason: c.reason,
      })
    }
  })

  test("golden non-success prevents model scoring for EVERY model state", () => {
    for (const golden of OFFICIAL_FINAL_RESULTS) {
      if (golden === "success") continue
      const outcomes = new Set(
        OFFICIAL_FINAL_RESULTS.map((model) => classifyOfficialPair(golden, model).state),
      )
      // one golden failure ⇒ one outcome, regardless of what the model did
      expect([golden, [...outcomes]]).toEqual([
        golden,
        [golden === "need_human_review" ? "ambiguous" : "infra_invalid"],
      ])
      for (const model of OFFICIAL_FINAL_RESULTS) {
        expect(classifyOfficialPair(golden, model).state).not.toBe("resolved")
        expect(GRADING_VALID_BY_STATE[classifyOfficialPair(golden, model).state]).toBe(false)
      }
    }
  })

  test("model timeout under golden success stays a model miss (never infra)", () => {
    for (const model of ["timeout_apply", "timeout_eval"] as const) {
      const got = classifyOfficialPair("success", model)
      expect(got.state).toBe("model_miss")
      expect(GRADING_VALID_BY_STATE[got.state]).toBe(true)
    }
  })

  test("NEED_HUMAN_REVIEW is ambiguous from either side and is never grading-valid", () => {
    expect(classifyOfficialPair("success", "need_human_review")).toEqual({
      state: "ambiguous",
      reason: "upstream_need_human_review",
    })
    for (const other of OFFICIAL_FINAL_RESULTS) {
      expect(classifyOfficialPair("need_human_review", other).state).toBe("ambiguous")
    }
    expect(GRADING_VALID_BY_STATE.ambiguous).toBe(false)
  })

  test("unknown / malformed upstream states are refused by the type guard", () => {
    for (const bogus of ["SUCCESS", "non_zero_exit", "", "not run", "resolved", "pass"]) {
      expect([bogus, isOfficialFinalResult(bogus)]).toEqual([bogus, false])
    }
    for (const known of OFFICIAL_FINAL_RESULTS) {
      expect([known, isOfficialFinalResult(known)]).toEqual([known, true])
    }
  })

  test("the runtime drift guard pins both tables to the full upstream state list", () => {
    expect(() => assertClassificationTablesInSync()).not.toThrow()
    expect(Object.keys(GOLDEN_AUTHORITY_TABLE).sort()).toEqual([...OFFICIAL_FINAL_RESULTS].sort())
    expect(Object.keys(MODEL_OUTCOME_TABLE).sort()).toEqual([...OFFICIAL_FINAL_RESULTS].sort())
  })

  test("drift guard is not decorative: a table missing a state throws", () => {
    const { success: _dropped, ...missingSuccess } = GOLDEN_AUTHORITY_TABLE
    expect(() =>
      assertClassificationTablesInSync({
        goldenAuthority: missingSuccess as Record<OfficialFinalResult, GoldenAuthority>,
        modelOutcome: MODEL_OUTCOME_TABLE,
      }),
    ).toThrow(/success/)

    const withExtra = { ...MODEL_OUTCOME_TABLE, invented_state: MODEL_OUTCOME_TABLE.success }
    expect(() =>
      assertClassificationTablesInSync({
        goldenAuthority: GOLDEN_AUTHORITY_TABLE,
        modelOutcome: withExtra as Record<OfficialFinalResult, ModelOutcome>,
      }),
    ).toThrow(/invented_state/)
  })
})

describe("PMX-03 classification anti-vacuum coverage", () => {
  test("COUNT FLOOR: fixtures exercise all 7 upstream states on BOTH sides", () => {
    const goldenSeen = new Set(ALL_CASES.map((c) => c.golden))
    const modelSeen = new Set(ALL_CASES.map((c) => c.model))
    expect(UPSTREAM_FINAL_RESULTS.length).toBe(7)
    expect([...goldenSeen].sort()).toEqual([...UPSTREAM_FINAL_RESULTS].sort())
    expect([...modelSeen].sort()).toEqual([...UPSTREAM_FINAL_RESULTS].sort())
    expect(goldenSeen.size).toBeGreaterThanOrEqual(7)
    expect(modelSeen.size).toBeGreaterThanOrEqual(7)
    // 7 golden-success rows + 6 blocking goldens × 7 models
    expect(ALL_CASES.length).toBe(7 + 6 * 7)
  })

  test("fixtures produce all four outcome states", () => {
    const states = new Set(ALL_CASES.map((c) => classifyOfficialPair(c.golden, c.model).state))
    expect([...states].sort()).toEqual([...OFFICIAL_GRADE_STATES].sort())
  })

  test("every classifier-reachable reason is exercised, and each maps to its state", () => {
    const reasons = new Set(ALL_CASES.map((c) => classifyOfficialPair(c.golden, c.model).reason))
    // the classifier cannot produce the evaluator/schema-level reasons; those
    // belong to the adapter and are covered in promax-evaluator-adapter.test.ts
    const adapterOnly: readonly OfficialGradeReason[] = [
      "schema_invalid",
      "evaluator_no_output",
      "evaluator_nonzero_exit",
      "evaluator_unavailable",
    ]
    const expected = OFFICIAL_GRADE_REASONS.filter((r) => !adapterOnly.includes(r))
    expect([...reasons].sort()).toEqual([...expected].sort())
    for (const r of reasons) {
      const owning = ALL_CASES.filter((c) => classifyOfficialPair(c.golden, c.model).reason === r)
      for (const c of owning) {
        expect([r, OFFICIAL_GRADE_STATE_BY_REASON[r]]).toEqual([r, c.state])
      }
    }
  })
})

describe("PMX-03 red-on-injection: the table is load-bearing", () => {
  test("corrupting the golden-authority table makes the fixture suite FAIL", () => {
    // inject: golden apply_failed silently becomes model-scored (the exact
    // regression 'golden authority' exists to prevent)
    const injected: Record<OfficialFinalResult, GoldenAuthority> = {
      ...GOLDEN_AUTHORITY_TABLE,
      apply_failed: { kind: "model_scored" },
    }
    expect(() => runAllCases(injected, MODEL_OUTCOME_TABLE)).toThrow()
  })

  test("corrupting the model-outcome table makes the fixture suite FAIL", () => {
    // inject: a model eval timeout is laundered into `resolved`
    const injected: Record<OfficialFinalResult, ModelOutcome> = {
      ...MODEL_OUTCOME_TABLE,
      timeout_eval: { state: "resolved", reason: "official_resolved" },
    }
    expect(() => runAllCases(GOLDEN_AUTHORITY_TABLE, injected)).toThrow()
  })

  test("the UNCORRUPTED tables pass the same suite (proving the harness is real)", () => {
    expect(() => runAllCases(GOLDEN_AUTHORITY_TABLE, MODEL_OUTCOME_TABLE)).not.toThrow()
  })
})

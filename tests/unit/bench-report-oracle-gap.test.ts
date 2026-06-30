/**
 * ★ CONTRACT — repair-loop diagnostics serialization (jun-29 oracle pilot).
 *
 * The jun-29 agentless-v6-oracle pilot graded 0/2 on the OFFICIAL harness while the
 * agent-side repair gate reported `canonical-sidecar` issueResolved=true — i.e. the
 * agent's repro was WEAKER than the held-out FAIL_TO_PASS and produced a false green.
 * But `verifyRounds` / `primaryFalseGreen` / `primaryFalseRed` existed on the typed
 * InstanceResult and were DROPPED at report serialization, so an A/B campaign could
 * not read them. This pins: (1) the three diagnostics are now forwarded, (2) the
 * DERIVED `oracleGapFalseGreen` flags the agent-repro-vs-official gap from
 * already-graded fields ONLY (no official-test leak into the loop).
 */
import { describe, expect, test } from "bun:test"
import { buildReport } from "@/runner/batch/report"
import type { InstanceResult } from "@/runner/batch/types"

const base = (id: string, passed: boolean): InstanceResult => ({ id, passed, patch: "x", turns: 1 })
const meta = { model: "m", provider: "p", n: 1, timestamp: "t" }

const CANON_RESOLVED = {
  authority: "canonical-sidecar" as const,
  issueResolved: true,
  regressionFailed: null,
  adoptable: true,
  reason: "canonical sidecar resolved",
}

describe("repair-loop diagnostics — forwarded + derived oracle-gap", () => {
  test("forwards verifyRounds / primaryFalseGreen / primaryFalseRed when present", () => {
    const r = buildReport(meta, [
      { ...base("a", false), verifyRounds: 4, primaryFalseGreen: true, primaryFalseRed: false },
    ])
    const p = r.perInstance[0]
    expect(p?.verifyRounds).toBe(4)
    expect(p?.primaryFalseGreen).toBe(true)
    expect(p?.primaryFalseRed).toBe(false)
  })

  test("omits the diagnostics when absent (byte-identical for non-repair runs)", () => {
    const p = buildReport(meta, [base("a", false)]).perInstance[0]
    expect(p && "verifyRounds" in p).toBe(false)
    expect(p && "primaryFalseGreen" in p).toBe(false)
    expect(p && "oracleGapFalseGreen" in p).toBe(false)
  })

  test("oracleGapFalseGreen=true: agent canonical oracle cleared but official UNRESOLVED", () => {
    // exactly the jun-29 django-11265 / sympy-23413 shape
    const r = buildReport(meta, [
      {
        ...base("django__django-11265", false),
        repairValidationDecision: CANON_RESOLVED,
        gradeBreakdown: { resolved: false, failToPassFailed: 1, passToPassFailed: 0, passToPassTotal: 30 },
      },
    ])
    expect(r.perInstance[0]?.oracleGapFalseGreen).toBe(true)
  })

  test("NO oracle-gap when the official harness AGREES (resolved=true)", () => {
    const p = buildReport(meta, [
      {
        ...base("a", true),
        repairValidationDecision: CANON_RESOLVED,
        gradeBreakdown: { resolved: true, failToPassFailed: 0, passToPassFailed: 0, passToPassTotal: 5 },
      },
    ]).perInstance[0]
    expect(p && "oracleGapFalseGreen" in p).toBe(false)
  })

  test("NO oracle-gap when the gate authority is NOT canonical-sidecar", () => {
    const p = buildReport(meta, [
      {
        ...base("a", false),
        repairValidationDecision: { ...CANON_RESOLVED, authority: "agent-verify-cmd" },
        gradeBreakdown: { resolved: false, failToPassFailed: 1, passToPassFailed: 0, passToPassTotal: 5 },
      },
    ]).perInstance[0]
    expect(p && "oracleGapFalseGreen" in p).toBe(false)
  })
})

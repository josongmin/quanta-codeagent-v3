/**
 * A2 — Typed ValidationDecision + adopt SSOT (jun-28 oracle-first RFC).
 *
 * Two guarantees under hellgate:
 *  1. EQUIVALENCE — `repairCandidateClears` (the new single live-gate SSOT) is
 *     BIT-IDENTICAL to the pre-refactor `clearedAsValidated` logic over the FULL
 *     input space (ok × predicate × consensus × strongOracle × primaryRail). The
 *     reference oracle below re-encodes the legacy decision independently (it
 *     imports `isStrongOracleFalseGreen` directly, NOT `decision.ts`), so a port
 *     error in the SSOT diverges and reds this test.
 *  2. ADOPTABLE TRUTH TABLE — `decideAdoption` is OBSERVE-ONLY and fail-closed:
 *     ONLY a canonical-sidecar `issueResolved===true` round is adoptable. Every
 *     other authority (advisory-hardening, missing, execution-failed,
 *     inconclusive, agent-verify-cmd) is NOT adoptable — even when the round
 *     "cleared" the live gate (the default agent-verify-cmd exit-0 path).
 */

import { describe, expect, test } from "bun:test"
import type { PredicateResult } from "../../src/agent/closure"
import {
  decideAdoption,
  repairCandidateClears,
  type ValidationDecisionContext,
} from "../../src/runner/batch/eval/repair/decision"
import { isStrongOracleFalseGreen } from "../../src/runner/batch/eval/repair/strong-oracle"
import type {
  RepairReproOutcome,
  ReproConsensusVerdict,
  RunRepairRoundsArgs,
  ValidatorResult,
} from "../../src/runner/batch/eval/repair/types"

// ── helpers ────────────────────────────────────────────────────────────────

const PREDICATES: ReadonlyArray<PredicateResult | undefined> = [
  undefined,
  { evaluable: false, matched: false },
  { evaluable: true, matched: true },
  { evaluable: true, matched: false, mismatchReason: "x" },
]
const CONSENSI: ReadonlyArray<ReproConsensusVerdict | undefined> = [
  undefined,
  "resolved",
  "reproduced",
  "inconclusive",
]

const result = (over: Partial<ValidatorResult>): ValidatorResult => ({ ok: false, ...over })

/** Minimal args — `repairCandidateClears` reads ONLY config.strongOracle +
 *  primaryRailStep, so a partial cast is faithful. */
const argsOf = (strongOracle: boolean | undefined, primaryRail: boolean): RunRepairRoundsArgs =>
  ({
    config: strongOracle === undefined ? {} : { strongOracle },
    ...(primaryRail
      ? {
          primaryRailStep: {
            kind: "repro",
            cmd: "x",
            authority: "execution",
            successPredicate: { kind: "exit-zero" },
          },
        }
      : {}),
  }) as unknown as RunRepairRoundsArgs

/** INDEPENDENT reference re-encoding the pre-refactor `clearedAsValidated`
 *  (repair/index.ts) — the golden the SSOT must match bit-for-bit. */
const refClears = (args: RunRepairRoundsArgs, v: ValidatorResult): boolean => {
  if (!v.ok) return false
  if (args.config.strongOracle === true && isStrongOracleFalseGreen(v)) return false
  if (args.primaryRailStep === undefined) return true
  const falseGreen = v.ok && v.predicate?.evaluable === true && v.predicate.matched === false
  return !falseGreen
}

// ── 1. EQUIVALENCE (full input space) ────────────────────────────────────────

describe("repairCandidateClears ≡ legacy clearedAsValidated (bit-identical)", () => {
  // Cartesian product as a FLAT case list (flatMap chain keeps cognitive
  // complexity low vs 5 nested for-loops) — each row is one independent assertion.
  const STRONGS: ReadonlyArray<boolean | undefined> = [undefined, false, true]
  const CASES = [true, false].flatMap((ok) =>
    PREDICATES.flatMap((predicate) =>
      CONSENSI.flatMap((consensus) =>
        STRONGS.flatMap((strongOracle) =>
          [false, true].map((primaryRail) => ({
            ok,
            predicate,
            consensus,
            strongOracle,
            primaryRail,
          })),
        ),
      ),
    ),
  )

  test("matches the reference oracle over the full ok×pred×consensus×strong×rail space", () => {
    expect(CASES.length).toBe(2 * 4 * 4 * 3 * 2)
    for (const c of CASES) {
      const v = result({
        ok: c.ok,
        ...(c.predicate !== undefined ? { predicate: c.predicate } : {}),
        ...(c.consensus !== undefined ? { consensus: c.consensus } : {}),
      })
      const args = argsOf(c.strongOracle, c.primaryRail)
      expect(repairCandidateClears(args, v), `divergence @ ${JSON.stringify(c)}`).toBe(
        refClears(args, v),
      )
    }
  })

  test("default path (no rail, no strong-oracle): an exit-0 agent-verify round CLEARS", () => {
    // This is the legacy default behavior repairCandidateClears MUST preserve —
    // byte-identical default-OFF. `adoptable` will say false (below) but the
    // LIVE gate still clears, exactly as today.
    expect(repairCandidateClears(argsOf(undefined, false), result({ ok: true }))).toBe(true)
  })
})

// ── 2. ADOPTABLE TRUTH TABLE (observe-only, fail-closed) ─────────────────────

const ctx = (over: Partial<ValidationDecisionContext>): ValidationDecisionContext => ({
  validationSource: "none",
  reproAuthority: false,
  ...over,
})

describe("decideAdoption — canonical-only fail-closed truth table", () => {
  test("canonical-sidecar + consensus resolved ⇒ adoptable", () => {
    const d = decideAdoption(
      result({ ok: true, consensus: "resolved" }),
      ctx({ validationSource: "repro", reproAuthority: true }),
    )
    expect(d.authority).toBe("canonical-sidecar")
    expect(d.issueResolved).toBe(true)
    expect(d.adoptable).toBe(true)
  })

  test("canonical-sidecar + reproOutcome resolved (no vote) ⇒ adoptable", () => {
    const d = decideAdoption(
      result({ ok: true, reproOutcome: "resolved" }),
      ctx({ validationSource: "repro", reproAuthority: true }),
    )
    expect(d.authority).toBe("canonical-sidecar")
    expect(d.adoptable).toBe(true)
  })

  test("canonical-sidecar + still reproduced ⇒ NOT adoptable (issueResolved false)", () => {
    const d = decideAdoption(
      result({ ok: false, consensus: "reproduced" }),
      ctx({ validationSource: "repro", reproAuthority: true }),
    )
    expect(d.authority).toBe("canonical-sidecar")
    expect(d.issueResolved).toBe(false)
    expect(d.adoptable).toBe(false)
  })

  test("hardening repro that resolved ⇒ advisory-hardening, NEVER adoptable", () => {
    const d = decideAdoption(
      result({ ok: true, consensus: "resolved" }),
      ctx({ validationSource: "repro", reproAuthority: true, kind: "hardening" }),
    )
    expect(d.authority).toBe("advisory-hardening")
    expect(d.adoptable).toBe(false)
  })

  test("exec_failed ⇒ execution-failed, issueResolved null, NOT adoptable", () => {
    const d = decideAdoption(
      result({ ok: false, reproOutcome: "exec_failed" }),
      ctx({ validationSource: "repro", reproAuthority: true }),
    )
    expect(d.authority).toBe("execution-failed")
    expect(d.issueResolved).toBeNull()
    expect(d.adoptable).toBe(false)
  })

  test("vote inconclusive ⇒ inconclusive, null, NOT adoptable", () => {
    const d = decideAdoption(
      result({ ok: false, consensus: "inconclusive" }),
      ctx({ validationSource: "repro", reproAuthority: true }),
    )
    expect(d.authority).toBe("inconclusive")
    expect(d.issueResolved).toBeNull()
    expect(d.adoptable).toBe(false)
  })

  test("no repro / empty sources (validationSource none) ⇒ missing, NOT adoptable", () => {
    const d = decideAdoption(result({ ok: false }), ctx({ validationSource: "none" }))
    expect(d.authority).toBe("missing")
    expect(d.issueResolved).toBeNull()
    expect(d.adoptable).toBe(false)
  })

  test("agent-verify-cmd exit-0 ⇒ agent-verify-cmd, NOT adoptable (clears live gate but no oracle authority)", () => {
    const d = decideAdoption(result({ ok: true }), ctx({ validationSource: "verify_cmd" }))
    expect(d.authority).toBe("agent-verify-cmd")
    expect(d.adoptable).toBe(false)
  })

  test("MUTATION GUARD: only canonical-sidecar resolved is adoptable", () => {
    // Sweep every authority-shaping ctx/result; exactly the two canonical-resolved
    // rows are adoptable. A mutant that greenlights any other authority reds here.
    const rows: ReadonlyArray<{ v: ValidatorResult; c: ValidationDecisionContext; want: boolean }> =
      [
        {
          v: result({ ok: true, consensus: "resolved" }),
          c: ctx({ validationSource: "repro", reproAuthority: true }),
          want: true,
        },
        {
          v: result({ ok: true, reproOutcome: "resolved" }),
          c: ctx({ validationSource: "repro", reproAuthority: true }),
          want: true,
        },
        {
          v: result({ ok: true, consensus: "resolved" }),
          c: ctx({ validationSource: "repro", reproAuthority: true, kind: "hardening" }),
          want: false,
        },
        { v: result({ ok: true }), c: ctx({ validationSource: "verify_cmd" }), want: false },
        {
          v: result({ ok: false, reproOutcome: "exec_failed" }),
          c: ctx({ reproAuthority: true }),
          want: false,
        },
        {
          v: result({ ok: false, consensus: "inconclusive" }),
          c: ctx({ reproAuthority: true }),
          want: false,
        },
        { v: result({ ok: false }), c: ctx({ validationSource: "none" }), want: false },
      ]
    for (const { v, c, want } of rows) {
      expect(decideAdoption(v, c).adoptable, JSON.stringify({ v, c })).toBe(want)
    }
  })

  test("regressionFailed is null (unobserved no-leak) — documented fail-open", () => {
    const d = decideAdoption(
      result({ ok: true, consensus: "resolved" }),
      ctx({ validationSource: "repro", reproAuthority: true }),
    )
    expect(d.regressionFailed).toBeNull()
  })
})

// avoid unused-type lint on RepairReproOutcome import (used for clarity in cases)
const _outcome: RepairReproOutcome = "resolved"
void _outcome

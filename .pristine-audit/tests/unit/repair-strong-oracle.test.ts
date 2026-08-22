import { describe, expect, test } from "bun:test"
import {
  clearedUnderStrongOracle,
  isStrongOracleFalseGreen,
} from "@/runner/batch/eval/repair/strong-oracle"
import type { ValidatorResult } from "@/runner/batch/eval/repair/types"

/**
 * jun-28 STRONG-ORACLE clear gate — PURE conjunction over the available strong,
 * no-leak signals on a `ValidatorResult`.
 *
 * The gate strengthens the lenient single-self-repro-green clear: a green round is
 * a FALSE GREEN iff ANY available strong signal is red (declared-expected mismatch
 * OR a non-resolved repro-vote consensus). Every conjunct FAILS OPEN on absence so
 * a correct patch is never falsely blocked.
 */

const v = (over: Partial<ValidatorResult>): ValidatorResult => ({ ok: true, ...over })

describe("isStrongOracleFalseGreen — declared-expected conjunct (lever #2)", () => {
  test("predicate evaluable + matched===false ⇒ FALSE GREEN (over-narrow round-0 patch)", () => {
    expect(isStrongOracleFalseGreen(v({ predicate: { evaluable: true, matched: false } }))).toBe(
      true,
    )
  })

  test("predicate evaluable + matched===true ⇒ NOT a false green (declared expected satisfied)", () => {
    expect(isStrongOracleFalseGreen(v({ predicate: { evaluable: true, matched: true } }))).toBe(
      false,
    )
  })

  test("predicate UNEVALUABLE ⇒ FAIL-OPEN (advisory, never a false penalty)", () => {
    expect(isStrongOracleFalseGreen(v({ predicate: { evaluable: false, matched: false } }))).toBe(
      false,
    )
  })

  test("NO predicate (issue declares nothing) ⇒ FAIL-OPEN (behaves as today)", () => {
    expect(isStrongOracleFalseGreen(v({}))).toBe(false)
  })
})

describe("isStrongOracleFalseGreen — repro-vote consensus conjunct", () => {
  test("consensus 'reproduced' (minority-green) ⇒ FALSE GREEN", () => {
    expect(isStrongOracleFalseGreen(v({ consensus: "reproduced" }))).toBe(true)
  })

  test("consensus 'inconclusive' (no decisive majority) ⇒ FALSE GREEN", () => {
    expect(isStrongOracleFalseGreen(v({ consensus: "inconclusive" }))).toBe(true)
  })

  test("consensus 'resolved' ⇒ NOT a false green (K-of-N agreed)", () => {
    expect(isStrongOracleFalseGreen(v({ consensus: "resolved" }))).toBe(false)
  })

  test("consensus ABSENT (single repro / vote did not run) ⇒ FAIL-OPEN", () => {
    expect(isStrongOracleFalseGreen(v({}))).toBe(false)
  })
})

describe("isStrongOracleFalseGreen — CONJUNCTION (any available red ⇒ false green)", () => {
  test("declared-expected MATCH but consensus 'reproduced' ⇒ still a FALSE GREEN", () => {
    expect(
      isStrongOracleFalseGreen(
        v({ predicate: { evaluable: true, matched: true }, consensus: "reproduced" }),
      ),
    ).toBe(true)
  })

  test("both signals green (declared MATCH + consensus resolved) ⇒ NOT a false green", () => {
    expect(
      isStrongOracleFalseGreen(
        v({ predicate: { evaluable: true, matched: true }, consensus: "resolved" }),
      ),
    ).toBe(false)
  })

  test("declared-expected MISMATCH but consensus resolved ⇒ still a FALSE GREEN", () => {
    expect(
      isStrongOracleFalseGreen(
        v({ predicate: { evaluable: true, matched: false }, consensus: "resolved" }),
      ),
    ).toBe(true)
  })
})

describe("clearedUnderStrongOracle — composes ok + the conjunction", () => {
  test("a NON-ok round never clears (base-discrimination still required)", () => {
    // Even with every strong signal green, ok:false ⇒ no clear.
    expect(
      clearedUnderStrongOracle({
        ok: false,
        predicate: { evaluable: true, matched: true },
        consensus: "resolved",
      }),
    ).toBe(false)
  })

  test("ok + all available strong signals green ⇒ CLEARS", () => {
    expect(clearedUnderStrongOracle(v({ consensus: "resolved" }))).toBe(true)
  })

  test("ok + a contradicting strong signal ⇒ does NOT clear", () => {
    expect(clearedUnderStrongOracle(v({ consensus: "reproduced" }))).toBe(false)
  })

  test("ok + NO strong signals (fail-open everywhere) ⇒ CLEARS (byte-identical to legacy)", () => {
    expect(clearedUnderStrongOracle(v({}))).toBe(true)
  })
})

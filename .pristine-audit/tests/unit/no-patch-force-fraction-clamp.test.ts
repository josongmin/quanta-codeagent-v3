import { describe, expect, test } from "bun:test"
import { sanitizeForceCommitFraction } from "@/runner/batch/eval/no-patch-breaker-adapter"

/**
 * FIX 4 — the no-patch force-commit fraction flows unvalidated into
 * `Math.floor(cap * frac)`. `frac >= 1` makes commit-now unreachable; `frac <= 0`
 * forces a commit on turn 0. Match `parseRetryTransientEnv`'s discipline: REJECT
 * an out-of-(0,1) value and fall back to the default (drop the override ⇒
 * `decideNoPatch` uses its built-in 0.8).
 */
describe("sanitizeForceCommitFraction — open interval (0,1) guard", () => {
  test("🔴 frac=1.2 (≥1, commit-now unreachable) ⇒ rejected (undefined ⇒ default)", () => {
    expect(sanitizeForceCommitFraction(1.2)).toBeUndefined()
  })

  test("🔴 frac=0 (commit forced on turn 0) ⇒ rejected", () => {
    expect(sanitizeForceCommitFraction(0)).toBeUndefined()
  })

  test("🔴 frac=-0.5 (negative) ⇒ rejected", () => {
    expect(sanitizeForceCommitFraction(-0.5)).toBeUndefined()
  })

  test("frac=1 (boundary, ≥1) ⇒ rejected", () => {
    expect(sanitizeForceCommitFraction(1)).toBeUndefined()
  })

  test("non-finite (NaN/Infinity) ⇒ rejected", () => {
    expect(sanitizeForceCommitFraction(Number.NaN)).toBeUndefined()
    expect(sanitizeForceCommitFraction(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  test("frac=0.5 (valid, in (0,1)) ⇒ preserved", () => {
    expect(sanitizeForceCommitFraction(0.5)).toBe(0.5)
  })

  test("undefined (no override) ⇒ undefined (default path untouched)", () => {
    expect(sanitizeForceCommitFraction(undefined)).toBeUndefined()
  })
})

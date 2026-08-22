/**
 * R-Phase5 P1-D regression — `HARD_DENY_RULES["rm-recursive-force-system-root"]`
 * pattern is bounded so adversarial inputs cannot trigger catastrophic
 * backtracking. The bound is `{0,500}?` on the three lazy `[\s\S]` spans.
 *
 * The risk pre-fix: three unbounded `[\s\S]*?` lookaheads could nest, and
 * a crafted long input ("rm -r " + thousands of "x " + "-nope") would force
 * the engine to try every possible match position. Modern V8/Bun regex
 * engines mitigate this somewhat, but the theoretical bound was unbounded.
 *
 * The bound preserves correctness:
 *   - Real `rm -rf /etc/foo` (~16 chars) still matches (well under 500).
 *   - Real safe rm (`rm /tmp/foo`) still doesn't match.
 *   - An adversarial 10KB+ input completes in single-digit ms even if the
 *     overall match fails (the engine bails when the bound is hit).
 *
 * Tests assert BOTH correctness (positive + negative on real commands) AND
 * time bound (adversarial inputs complete under a generous ceiling).
 */
import { describe, expect, test } from "bun:test"
import { HARD_DENY_RULES } from "@/permission/policy"

const rmRule = HARD_DENY_RULES.find((r) => r.name === "rm-recursive-force-system-root")
if (!rmRule) throw new Error("rm-recursive-force-system-root rule is missing")
const PATTERN = rmRule.pattern

describe("R-Phase5 P1-D — rm-recursive-force-system-root regex bounded", () => {
  test("positive: 'rm -rf /' matches", () => {
    expect(PATTERN.test("rm -rf /")).toBe(true)
  })

  test("positive: 'rm -rf ~' matches", () => {
    expect(PATTERN.test("rm -rf ~")).toBe(true)
  })

  test("positive: 'rm -rf /etc/foo' matches (Linux FHS root)", () => {
    expect(PATTERN.test("rm -rf /etc/foo")).toBe(true)
  })

  test("positive: 'rm -rf $HOME/somefile' matches", () => {
    expect(PATTERN.test("rm -rf $HOME/somefile")).toBe(true)
  })

  test("negative: 'rm /tmp/foo' (no -rf) doesn't match", () => {
    expect(PATTERN.test("rm /tmp/foo")).toBe(false)
  })

  test("negative: 'rm -rf ./build' (project-relative) doesn't match", () => {
    expect(PATTERN.test("rm -rf ./build")).toBe(false)
  })

  test("negative: 'rm -rf /tmp/scratch' (allowed /tmp target) doesn't match", () => {
    expect(PATTERN.test("rm -rf /tmp/scratch")).toBe(false)
  })

  test("adversarial: 10KB rm-shaped string with mismatched flags completes under 100ms", () => {
    // Pre-bound: this could trigger catastrophic backtracking (the lookaheads
    // would try every possible position for the -r and -f flags). Post-bound,
    // the engine bails at 500 chars per span and the overall match fails fast.
    const filler = "x ".repeat(5_000) // 10,000 chars of "x " separators
    const adversarial = `rm -r ${filler}-nope`
    const start = performance.now()
    const result = PATTERN.test(adversarial)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(100) // generous; in practice well under 5ms
    expect(result).toBe(false) // doesn't match (no -f flag in the 500-char window)
  })

  test("adversarial: nested -r-like tokens completes under 100ms", () => {
    // A pathological input: "rm" + many lines of plausible-looking flag-ish
    // tokens that the lookahead engine might explore.
    const lines = []
    for (let i = 0; i < 1000; i++) lines.push(`-rabbit -fish -rusty`)
    const adversarial = `rm ${lines.join(" ")} /etc/passwd`
    const start = performance.now()
    PATTERN.test(adversarial)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(100)
  })

  test("adversarial: long path target with valid -rf prefix still matches reasonably fast", () => {
    // This SHOULD match (rm -rf /etc/...) but the path is long. The
    // {0,500}? bound limits how far the engine searches for the target.
    // If the actual target is within 500 chars of the flags, it matches.
    const adversarial = `rm -rf /etc/${"a".repeat(200)}`
    const start = performance.now()
    const result = PATTERN.test(adversarial)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(100)
    expect(result).toBe(true) // path is well within the 500-char window
  })

  test("structural: rule object has the expected name + description + pattern fields", () => {
    expect(rmRule.name).toBe("rm-recursive-force-system-root")
    expect(typeof rmRule.description).toBe("string")
    expect(rmRule.description.length).toBeGreaterThan(0)
    expect(PATTERN).toBeInstanceOf(RegExp)
    // Bound markers present in the source pattern (defense-in-depth: a
    // future revert that drops the bounds would surface here).
    expect(PATTERN.source).toContain("{0,500}?")
  })
})

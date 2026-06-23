import { describe, expect, test } from "bun:test"
import {
  validatedReproContractSeed,
  validatedReproRepairSeed,
} from "@/runner/batch/eval/driver"
import { PacketBlindnessViolation } from "@/runner/batch/eval/llm-evidence-packet"

describe("validatedReproContractSeed", () => {
  test("empty or whitespace-only sources produce no seed", () => {
    expect(validatedReproContractSeed([])).toBeUndefined()
    expect(validatedReproContractSeed(["  \n  "])).toBeUndefined()
  })

  test("validated public repro contract is compact: first two scripts, bounded source", () => {
    const longSource = `print("head")\n${"x".repeat(2_000)}\nprint("tail-never-rendered")`
    const seed = validatedReproContractSeed([
      "  \n  ",
      longSource,
      'print("second")',
      'print("third-never-rendered")',
    ])

    expect(seed).toContain("Validated reproduction script 1:")
    expect(seed).toContain("Validated reproduction script 2:")
    expect(seed).not.toContain("Validated reproduction script 3:")
    expect(seed).toContain("Omitted 1 additional validated reproduction script")
    expect(seed).toContain("# ...[truncated]")
    expect(seed).not.toContain("tail-never-rendered")
    expect(seed).not.toContain("third-never-rendered")
    expect(seed?.length ?? 0).toBeLessThan(2_900)
  })

  test("repair seed reuses the same compact public-repro contract", () => {
    const repairSeed = validatedReproRepairSeed([
      'print("first")',
      'print("second")',
      'print("third-never-rendered")',
    ])

    expect(repairSeed).toContain("Validated reproduction script 1:")
    expect(repairSeed).toContain("Validated reproduction script 2:")
    expect(repairSeed).not.toContain("Validated reproduction script 3:")
    expect(repairSeed).toContain("Use this as repair guidance")
  })

  test("AUDIT exact boundary: source truncated only past the 1200-char limit", () => {
    // Red-on-injection: change VALIDATED_REPRO_CONTRACT_SOURCE_LIMIT and exactly
    // one of these flips — the aggregate-size check alone would not catch it.
    const at = validatedReproContractSeed([`print(1)\n${"x".repeat(1_200 - "print(1)\n".length)}`])
    expect(at).not.toContain("# ...[truncated]")
    const over = validatedReproContractSeed([`print(1)\n${"x".repeat(1_200)}`])
    expect(over).toContain("# ...[truncated]")
  })

  test("AUDIT wording: framing is evidence-toned, not an absolute 'must pass' contract (anti-overfit)", () => {
    // The aggressive "a correct candidate MUST make them report Issue resolved"
    // wording invites reward-hacking the self-generated symptom oracle. Softened
    // to prioritize the root-cause fix over narrowly satisfying any single script.
    const seed = validatedReproContractSeed(['print("x")']) ?? ""
    expect(seed).not.toContain("a correct candidate must make them report")
    expect(seed.toLowerCase()).toContain("root cause")
    expect(seed.toLowerCase()).toContain("exit 0")
  })

  test("AUDIT line-safe truncation: an over-limit script is cut at a line boundary, not mid-line", () => {
    // Red-on-injection: a mid-line slice produces syntactically broken Python
    // injected as a 'contract'. The cut must land on a complete line.
    const longSource = `${"print('keep')\n".repeat(120)}` // ~1680 chars, well over 1200
    const seed = validatedReproContractSeed([longSource]) ?? ""
    expect(seed).toContain("# ...[truncated]")
    const body = seed.split("# ...[truncated]")[0] ?? ""
    // the kept region (after the last ```python fence) contains only WHOLE lines:
    const kept = body.slice(body.lastIndexOf("```python") + "```python\n".length)
    // every retained line is a complete "print('keep')" — no partial fragment
    expect(kept.replace(/print\('keep'\)\n?/g, "").trim()).toBe("")
  })

  test("AUDIT seed order: the public-repro contract precedes the repair-guidance line", () => {
    // Salience: the executable contract must come BEFORE the generic guidance.
    const repairSeed = validatedReproRepairSeed(['print("x")']) ?? ""
    const contractIdx = repairSeed.indexOf("Validated reproduction script 1:")
    const guidanceIdx = repairSeed.indexOf("Use this as repair guidance")
    expect(contractIdx).toBeGreaterThanOrEqual(0)
    expect(guidanceIdx).toBeGreaterThan(contractIdx)
  })

  test("raw hidden oracle markers are rejected before source compaction", () => {
    expect(() => validatedReproContractSeed([`${"x".repeat(1_300)}FAIL_TO_PASS`])).toThrow(
      PacketBlindnessViolation,
    )
    expect(() => validatedReproRepairSeed([`${"x".repeat(1_300)}PASS_TO_PASS`])).toThrow(
      PacketBlindnessViolation,
    )
  })
})

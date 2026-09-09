import { describe, expect, test } from "bun:test"
import { finalizeVerificationResult, type GateResult } from "../../../tools/dev/verification-result"
import {
  assertKnownTier,
  orchestrateGates,
  type TierGate,
} from "../../../tools/dev/verification-tier"

const gates: readonly TierGate[] = [
  { id: "lint", tiers: ["smoke", "prepush", "pr", "full"] },
  { id: "tests", consumes: "lint", tiers: ["prepush", "pr", "full"] },
  { id: "heavy", tiers: ["prepush", "pr", "full"] },
]

describe("verification-result", () => {
  test("missing results cannot be success", () => {
    const result = finalizeVerificationResult({ tier: "prepush", gates: [] })
    expect(result.outcome).toBe("failed")
    expect(result.exitCode).not.toBe(0)
  })

  test("cancelled beats failed", () => {
    const gatesResult: GateResult[] = [
      { id: "a", outcome: "failed", elapsedMs: 1 },
      { id: "b", outcome: "cancelled", elapsedMs: 1 },
    ]
    expect(finalizeVerificationResult({ tier: "full", gates: gatesResult }).outcome).toBe(
      "cancelled",
    )
  })
})

describe("verification-tier-runner", () => {
  test("unknown tier is an error", () => {
    expect(() => assertKnownTier("merge-green")).toThrow(/unknown verification tier/)
  })

  test("fail-fast does not start later independent gates", () => {
    const spawned: string[] = []
    const result = orchestrateGates({
      tier: "prepush",
      gates,
      failFast: true,
      runGate: (gate) => {
        spawned.push(gate.id)
        return { ok: gate.id !== "lint" }
      },
    })
    expect(spawned).toEqual(["lint"])
    expect(result.gates.map((gate) => [gate.id, gate.outcome])).toEqual([
      ["lint", "failed"],
      ["tests", "not-run"],
      ["heavy", "not-run"],
    ])
  })

  test("producer failure skips the consumer even when keep-going", () => {
    const spawned: string[] = []
    const result = orchestrateGates({
      tier: "prepush",
      gates,
      failFast: false,
      runGate: (gate) => {
        spawned.push(gate.id)
        return { ok: gate.id !== "lint" }
      },
    })
    expect(spawned).toEqual(["lint", "heavy"])
    expect(result.gates.find((gate) => gate.id === "tests")?.outcome).toBe("skipped-input")
    expect(result.gates.find((gate) => gate.id === "heavy")?.outcome).toBe("passed")
  })

  test("duplicate gate ids are rejected", () => {
    expect(() =>
      orchestrateGates({
        tier: "smoke",
        gates: [
          { id: "lint", tiers: ["smoke"] },
          { id: "lint", tiers: ["smoke"] },
        ],
        failFast: true,
        runGate: () => ({ ok: true }),
      }),
    ).toThrow(/duplicate gate id/)
  })
})

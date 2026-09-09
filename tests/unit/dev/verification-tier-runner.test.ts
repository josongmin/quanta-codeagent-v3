import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { gatesForVerificationTier } from "../../../tools/dev/gate-manifest"
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

describe("manifest tier membership", () => {
  test("prepush still includes the full-suite gate; smoke does not", () => {
    const prepush = gatesForVerificationTier("prepush").map((gate) => gate.id)
    const smoke = gatesForVerificationTier("smoke").map((gate) => gate.id)
    expect(prepush).toContain("full-suite")
    expect(prepush).toContain("typecheck")
    expect(smoke).not.toContain("full-suite")
    expect(smoke).not.toContain("typecheck")
    expect(smoke).toContain("lint")
  })

  test("pr/full/nightly are distinct labels over the same suite population", () => {
    const prepush = gatesForVerificationTier("prepush").map((gate) => gate.id)
    expect(gatesForVerificationTier("pr").map((gate) => gate.id)).toEqual(prepush)
    expect(gatesForVerificationTier("full").map((gate) => gate.id)).toEqual(prepush)
    expect(gatesForVerificationTier("nightly").map((gate) => gate.id)).toEqual(prepush)
  })

  test("gate CLI consumes the tier owner, not a second membership table", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../tools/dev/gate.ts")).text()
    expect(source).toContain("assertKnownTier(")
    expect(source).toContain("gatesForVerificationTier(")
    expect(source).toContain('tier: label === "precommit" ? "prepush" : label')
  })

  test("unknown CLI tier is exit 2, not a silent prepush", () => {
    const proc = Bun.spawnSync(["bun", "run", "tools/dev/gate.ts", "merge-green"], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode).toBe(2)
    expect(new TextDecoder().decode(proc.stderr)).toContain(
      "precommit|smoke|prepush|pr|full|nightly",
    )
  })
})

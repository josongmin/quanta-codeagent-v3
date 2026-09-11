import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { gatesForVerificationTier } from "../../../tools/dev/gate-manifest"
import { finalizeVerificationResult, type GateResult } from "../../../tools/dev/verification-result"
import {
  assertKnownTier,
  orchestrateGates,
  type TierGate,
  tierFromGateCommand,
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

  test("fail-fast does not start later independent gates", async () => {
    const spawned: string[] = []
    const result = await orchestrateGates({
      tier: "prepush",
      gates,
      failFast: true,
      runGate: (gate) => {
        spawned.push(gate.id)
        return { ok: gate.id !== "lint" }
      },
    })
    expect(spawned).toEqual(["lint"])
    // `tests` CONSUMES `lint`, so its reason is that its input failed — not
    // that a flag stopped the run. The old sequencer short-circuited on
    // fail-fast before it looked at `consumes` and reported the less
    // actionable of the two; the DAG reports the specific one. `heavy` is
    // independent and stays `not-run`, which is what this test is named for.
    expect(result.gates.map((gate) => [gate.id, gate.outcome])).toEqual([
      ["lint", "failed"],
      ["tests", "skipped-input"],
      ["heavy", "not-run"],
    ])
  })

  test("producer failure skips the consumer even when keep-going", async () => {
    const spawned: string[] = []
    const result = await orchestrateGates({
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

  test("duplicate gate ids are rejected", async () => {
    await expect(
      orchestrateGates({
        tier: "smoke",
        gates: [
          { id: "lint", tiers: ["smoke"] },
          { id: "lint", tiers: ["smoke"] },
        ],
        failFast: true,
        runGate: () => ({ ok: true }),
      }),
    ).rejects.toThrow(/duplicate gate id/)
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
    expect(source).toContain("tiersForGate(")
    expect(source).toContain("stepGatePlan(")
    expect(source).toContain("outcomeFromGates(")
    expect(source).not.toContain('tier: label === "precommit" ? "prepush" : label')
    expect(source).toMatch(
      /if \(label === "nightly"\) \{\s*process\.env\.QUANTA_TEST_CACHE = NIGHTLY_MEMBERSHIP\.cacheMode/,
    )
    const owner = await Bun.file(
      join(import.meta.dir, "../../../tools/dev/verification-tier.ts"),
    ).text()
    expect(owner).toContain("export const stepGatePlan")
    expect(owner).toMatch(/export const orchestrateGates[\s\S]*stepGatePlan\s*\(/)
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

  test("--list matrix shows smoke excluding typecheck and full-suite", () => {
    const proc = Bun.spawnSync(["bun", "run", "tools/dev/gate.ts", "--list"], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode).toBe(0)
    const out = new TextDecoder().decode(proc.stdout)
    const typecheck = out
      .split("\n")
      .find((line) => line.startsWith("typecheck "))
      ?.trim()
      .split(/\s+/)
    const fullSuite = out
      .split("\n")
      .find((line) => line.startsWith("full-suite "))
      ?.trim()
      .split(/\s+/)
    const lint = out
      .split("\n")
      .find((line) => line.startsWith("lint "))
      ?.trim()
      .split(/\s+/)
    expect(typecheck).toEqual(["typecheck", "-", "y", "y", "y", "y"])
    expect(fullSuite).toEqual(["full-suite", "-", "y", "y", "y", "y"])
    expect(lint).toEqual(["lint", "y", "y", "y", "y", "y"])
  })

  test("--list smoke does not include typecheck or full-suite", () => {
    const proc = Bun.spawnSync(["bun", "run", "tools/dev/gate.ts", "--list", "smoke"], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode).toBe(0)
    const out = new TextDecoder().decode(proc.stdout)
    expect(out).toContain("lint")
    expect(out).not.toContain("typecheck")
    expect(out).not.toContain("full-suite")
  })

  test("--list unknown tier is exit 2", () => {
    const proc = Bun.spawnSync(["bun", "run", "tools/dev/gate.ts", "--list", "merge-green"], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode).toBe(2)
  })
})

describe("campaign command tier parse", () => {
  test("reads the gate.ts argv token, not a nearby flag", () => {
    expect(
      tierFromGateCommand(["bun", "run", "tools/dev/gate.ts", "nightly", "--keep-going"]),
    ).toBe("nightly")
    expect(
      tierFromGateCommand(["bun", "run", "tools/dev/gate.ts", "prepush", "--reuse-receipt"]),
    ).toBe("prepush")
    expect(tierFromGateCommand(["bun", "run", "tools/dev/gate.ts", "precommit"])).toBe("precommit")
    expect(tierFromGateCommand(["bun", "-e", "process.exit(0)"])).toBeNull()
    expect(tierFromGateCommand(["bun", "run", "tools/dev/gate.ts", "merge-green"])).toBeNull()
  })
})

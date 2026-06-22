import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")

describe("runner closure-repair driver parity", () => {
  test("wires owner-sibling resolution into the closure bundle and repair seed", () => {
    expect(DRIVER_SRC).toContain("resolveOwnerSiblings")
    expect(DRIVER_SRC).toContain("const ownerResolved =")
    expect(DRIVER_SRC).toContain('readFileSync(join(sandbox, rel), "utf8")')
    expect(DRIVER_SRC).toContain("...(ownerResolved !== undefined ? { ownerResolved } : {})")
    expect(DRIVER_SRC).toContain("siblingOwners: readonly string[]")
    expect(DRIVER_SRC).toContain("if (repair.buildContext !== undefined)")
    expect(DRIVER_SRC).toContain("buildRepairRoundSeedMessage({ ...ctxArgs, siblingOwners })")
    expect(DRIVER_SRC).toContain("recordLlmEvidencePacket(repairLlmEvidence, repairSeed.packet)")
  })

  test("surfaces false-red and sibling-coverage telemetry", () => {
    expect(DRIVER_SRC).toContain("primaryFalseRed?: boolean")
    expect(DRIVER_SRC).toContain("repairFalseRed = out.primaryFalseRed")
    expect(DRIVER_SRC).toContain("primaryFalseRed: repairFalseRed")
    expect(DRIVER_SRC).toContain("args.extra.primaryFalseRed = args.phase.primaryFalseRed")
    expect(DRIVER_SRC).toContain("siblingFiles: ownerResolved?.map((o) => o.file) ?? []")
  })
})

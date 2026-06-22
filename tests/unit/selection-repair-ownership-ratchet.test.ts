import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const EXECUTOR = readFileSync(
  join(import.meta.dir, "../../src/runner/batch/eval/selection-executor.ts"),
  "utf8",
)
const REPAIR = readFileSync(
  join(import.meta.dir, "../../src/runner/batch/eval/selection-repair-seed.ts"),
  "utf8",
)

describe("selection repair builder ownership", () => {
  test("higher-level repair seed builders live in selection-repair-seed, not the executor", () => {
    expect(REPAIR).toContain("export interface SelectorRepairSeedPlan")
    expect(REPAIR).toContain("export const buildStaticSanityRepairSeed =")
    expect(REPAIR).toContain("export const buildRepairPacketText =")
    expect(REPAIR).toContain("export const buildOracleFailureRepairSeed =")

    expect(EXECUTOR).not.toContain("interface SelectorRepairSeedPlan")
    expect(EXECUTOR).not.toContain("const staticSanityRepairSeed =")
    expect(EXECUTOR).not.toContain("const repairPacketText =")
    expect(EXECUTOR).not.toContain("const reproFailureTraceSeed =")
    expect(EXECUTOR).not.toContain("const oracleFailureRepairSeed =")
  })
})

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
    // B1/B3: the classic-repair packet carries owner slices (paired with issue
    // symbols + a read-source resolver) and names the active proof target — the
    // multiline repairArgs replaced the old `{ ...ctxArgs, siblingOwners }`.
    expect(DRIVER_SRC).toContain("const repairArgs = {")
    expect(DRIVER_SRC).toContain("...ctxArgs,")
    expect(DRIVER_SRC).toContain("issueSymbols: repairIssueSymbols,")
    expect(DRIVER_SRC).toContain("readSource: (rel: string) => readSandboxSource(sandbox, rel),")
    expect(DRIVER_SRC).toContain(
      "...(verificationTarget !== undefined ? { verificationTarget } : {}),",
    )
    expect(DRIVER_SRC).toContain(
      "const repairIssueSymbols = extractIssueHint(instance.problemStatement).symbols",
    )
    expect(DRIVER_SRC).toContain("repair.buildContext?.(repairArgs)")
    expect(DRIVER_SRC).toContain("buildRepairRoundSeedMessage(")
    expect(DRIVER_SRC).toContain("recordLlmEvidencePacket(repairLlmEvidence, repairSeed.packet)")
  })

  test("surfaces false-red and sibling-coverage telemetry", () => {
    expect(DRIVER_SRC).toContain("primaryFalseRed?: boolean")
    expect(DRIVER_SRC).toContain("repairFalseRed = out.primaryFalseRed")
    expect(DRIVER_SRC).toContain("primaryFalseRed: repairFalseRed")
    expect(DRIVER_SRC).toContain("args.extra.primaryFalseRed = args.phase.primaryFalseRed")
    expect(DRIVER_SRC).toContain("siblingFiles: args.prepared.ownerResolved?.map((o) => o.file) ?? []")
  })
})

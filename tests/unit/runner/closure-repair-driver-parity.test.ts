import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

// The runner core driver was split (64df90e84: 7009→441 lines) into
// `src/runner/batch/eval/driver/*.ts` submodules — pure code motion. What used
// to be one `driver.ts` god-file is now a thin re-export BARREL plus one module
// per slice (attempt-context / candidate-family-ports / repair-phase /
// context-types / result-assembly / localize-prep / …). The closure-repair
// wiring these strings pin now lives in those submodules, so this test aggregates
// the barrel + every `driver/*.ts` submodule and pins against the concatenation
// (mirroring tests/unit/apps/bench/shared-verify-select-adapters.test.ts). The
// SSOT invariant — owner-sibling resolution + repair-seed evidence packet +
// false-red telemetry are all wired — is unchanged by the file split.
const DRIVER_DIR = join(REPO_ROOT, "src/runner/batch/eval/driver")
/** Enumerated ONCE: the floor and the blob read the same list, so a lane that
 *  goes unread cannot pass the floor and vanish from the text. */
const laneFiles = (): string[] =>
  readdirSync(DRIVER_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(DRIVER_DIR, f))

const DRIVER_SRC = [
  readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8"),
  ...laneFiles().map((f) => readFileSync(f, "utf8")),
].join("\n")

describe("runner closure-repair driver parity", () => {
  test("ANTI-VACUITY: the driver lane slice was actually read", () => {
    // Every assertion below is a `toContain` on the concatenated blob. A lane
    // that went unread simply is not in the text — and the parity it carries
    // reads as unwired, or, for a `not.toContain`, as clean.
    assertScanPopulation(laneFiles(), DRIVER_DIR, {
      min: 2,
      topLevelOnly: true,
      collectable: (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    })
  })

  test("wires owner-sibling resolution into the closure bundle and repair seed", () => {
    // Owner-sibling resolution (driver/candidate-family-ports.ts +
    // driver/attempt-context.ts): resolve the owning siblings, read their source
    // from the sandbox, and thread the resolved slices into the closure bundle.
    expect(DRIVER_SRC).toContain("resolveOwnerSiblings")
    expect(DRIVER_SRC).toContain("const ownerResolved =")
    expect(DRIVER_SRC).toContain('readFileSync(join(sandbox, rel), "utf8")')
    expect(DRIVER_SRC).toContain("...(ownerResolved !== undefined ? { ownerResolved } : {})")
    // Repair-round seed (driver/repair-phase.ts): the classic-repair packet
    // carries owner slices (paired with issue symbols + a read-source resolver)
    // and names the active proof target — the multiline `repairArgs` object.
    expect(DRIVER_SRC).toContain("siblingOwners: readonly string[]")
    expect(DRIVER_SRC).toContain("const repairArgs = {")
    expect(DRIVER_SRC).toContain("...ctxArgs,")
    // DRIFT (post-split): the seed reads now dereference the args bag, i.e.
    // `args.repairIssueSymbols` / `readSandboxSource(args.sandbox, rel)` (the phase
    // was extracted into `runRepairRoundsInSnapshot(args: {…})`), not the bare
    // `repairIssueSymbols` / `sandbox` locals the pre-split single-file used.
    expect(DRIVER_SRC).toContain("issueSymbols: args.repairIssueSymbols,")
    expect(DRIVER_SRC).toContain(
      "readSource: (rel: string) => readSandboxSource(args.sandbox, rel),",
    )
    expect(DRIVER_SRC).toContain("...(args.verificationTarget !== undefined")
    // The issue symbols the seed consumes are a typed field on the phase args
    // (`extractIssueHint(...).symbols`), populated by the caller — the runner
    // submodule declares the field rather than inlining the `extractIssueHint`
    // call (that inline now lives only in the apps/bench monolithic driver).
    expect(DRIVER_SRC).toContain(
      'repairIssueSymbols: ReturnType<typeof extractIssueHint>["symbols"]',
    )
    expect(DRIVER_SRC).toContain("args.repair.buildContext?.(repairArgs)")
    expect(DRIVER_SRC).toContain("buildRepairRoundSeedMessage(")
    // DRIFT: the evidence packet is recorded off the args bag now (`args.repairLlmEvidence`).
    expect(DRIVER_SRC).toContain(
      "recordLlmEvidencePacket(args.repairLlmEvidence, repairSeed.packet)",
    )
  })

  test("surfaces false-red and sibling-coverage telemetry", () => {
    // The false-red flag is a typed field on the phase result (driver/context-types.ts)
    // and is attached to the instance result only when a primary rail ran
    // (driver/result-assembly.ts).
    expect(DRIVER_SRC).toContain("primaryFalseRed?: boolean")
    expect(DRIVER_SRC).toContain("args.extra.primaryFalseRed = args.phase.primaryFalseRed")
    // DRIFT (post-split): the intermediate `repairFalseRed` local was inlined. The
    // runner core reads the flag straight off `args.phase.primaryFalseRed` (the
    // pre-split `repairFalseRed = out.primaryFalseRed` / `primaryFalseRed: repairFalseRed`
    // form survives only as the `primaryFalseRed: out.primaryFalseRed` inline in the
    // apps/bench monolithic driver, which this runner-side test does not read).
    expect(DRIVER_SRC).toContain("primaryFalseRed: args.phase.primaryFalseRed")
    // Sibling-coverage telemetry (driver/localize-prep.ts): the resolved owner
    // files are projected into the phase's `siblingFiles` list.
    expect(DRIVER_SRC).toContain(
      "siblingFiles: args.prepared.ownerResolved?.map((o) => o.file) ?? []",
    )
  })
})

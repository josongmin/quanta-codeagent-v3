import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  checkDefaultOffLedger,
  type DefaultOffLedger,
  loadDefaultOffLedger,
} from "../../tools/feature-catalog/default-off-ledger-checker"

const ROOT = join(import.meta.dir, "..", "..")
const LEDGER_PATH = join(ROOT, "tools/feature-catalog/default-off-ledger.yaml")
const CATALOG_DIR = join(ROOT, "tools/feature-catalog/features")

const clone = (ledger: DefaultOffLedger): DefaultOffLedger => structuredClone(ledger)

describe("DOF-00 default-off authority ledger hellgate", () => {
  test("anti-vacuum: both live CLI seed authorities and the catalog denominator are populated", async () => {
    const ledger = await loadDefaultOffLedger(LEDGER_PATH)
    const report = await checkDefaultOffLedger(ledger, { catalogDir: CATALOG_DIR })

    expect(report.runtimeCliSeedCount).toBe(28)
    expect(report.eligibleFeatureIds.length).toBeGreaterThanOrEqual(150)
    expect(report.eligibleFeatureIds).toEqual([...report.eligibleFeatureIds].sort())
    // DOF-00 completion invariant: every eligible row resolves every surface
    // default (zero `unknown` cells). Construction-phase allowed unknowns; the
    // finished ledger must not. Remaining `unknown` *values* are proof tiers
    // only (features with genuinely no ON-path test), never surface cells.
    expect(report.unknownSurfaceCount).toBe(0)
    expect(report.summary).toContain(`eligible=${report.eligibleFeatureIds.length}`)
    expect(report.errors).toEqual([])
  })

  test("missing row and duplicate feature id are rejected", async () => {
    const ledger = await loadDefaultOffLedger(LEDGER_PATH)
    const missing = clone(ledger)
    const removed = missing.rows.shift()
    expect(removed).toBeDefined()
    expect((await checkDefaultOffLedger(missing, { catalogDir: CATALOG_DIR })).errors).toContain(
      `missing eligible row: ${removed?.feature_id}`,
    )

    const duplicate = clone(ledger)
    duplicate.rows.push(structuredClone(duplicate.rows[0]))
    expect((await checkDefaultOffLedger(duplicate, { catalogDir: CATALOG_DIR })).errors).toContain(
      `duplicate feature_id: ${duplicate.rows[0]?.feature_id}`,
    )
  })

  test("schema rejects an invalid surface default", async () => {
    const ledger = await loadDefaultOffLedger(LEDGER_PATH)
    const invalid = clone(ledger) as unknown as {
      rows: Array<{ effective_default: { web: string } }>
    }
    const first = invalid.rows[0]
    if (first === undefined) throw new Error("fixture ledger must contain a row")
    first.effective_default.web = "maybe"

    expect(
      checkDefaultOffLedger(invalid as unknown as DefaultOffLedger, { catalogDir: CATALOG_DIR }),
    ).rejects.toThrow(/"effective_default"[\s\S]*"web"/)
  })

  test("red-on-injection: one wrong derived CLI default fails parity for exactly that row", async () => {
    const ledger = await loadDefaultOffLedger(LEDGER_PATH)
    const mutated = clone(ledger)
    const known = mutated.rows.find((row) => row.effective_default.cli === "on")
    if (known === undefined) throw new Error("fixture ledger must contain a CLI-on row")
    known.effective_default.cli = "off"

    const report = await checkDefaultOffLedger(mutated, { catalogDir: CATALOG_DIR })
    expect(report.errors).toEqual([
      `runtime CLI default mismatch: ${known.feature_id} expected on, ledger has off`,
    ])
  })

  test("drift ratchet: no row is reachability=wired AND activation=unwired", async () => {
    const ledger = await loadDefaultOffLedger(LEDGER_PATH)
    const drifted = ledger.rows.filter(
      (row) => row.reachability === "wired" && row.activation === "unwired",
    )
    // A `wired` reachability asserts a live consumer; `unwired` activation says
    // no caller wires it. The two cannot both be true — this pins the ledger
    // against the stale-label drift that Wave L corrected (19 rows).
    expect(drifted.map((r) => r.feature_id)).toEqual([])
  })

  test("red-on-injection: a wired+unwired row is flagged for exactly that feature", async () => {
    const ledger = await loadDefaultOffLedger(LEDGER_PATH)
    const mutated = clone(ledger)
    const victim = mutated.rows.find((row) => row.reachability === "wired")
    if (victim === undefined) throw new Error("fixture ledger must contain a wired row")
    victim.activation = "unwired"

    const report = await checkDefaultOffLedger(mutated, { catalogDir: CATALOG_DIR })
    expect(report.errors).toContain(
      `reachability=wired contradicts activation=unwired (a wired feature has a live consumer): ${victim.feature_id}`,
    )
  })
})

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  checkDefaultOffLedger,
  type DefaultOffLedger,
  loadDefaultOffLedger,
} from "../../tools/feature-catalog/default-off-ledger-checker"
import { loadFeatures } from "../../tools/feature-catalog/schema"

const ROOT = join(import.meta.dir, "..", "..")
const LEDGER_PATH = join(ROOT, "tools/feature-catalog/default-off-ledger.yaml")
const CATALOG_DIR = join(ROOT, "tools/feature-catalog/features")
// This rail loads the whole 1k+ YAML catalog through the production parser.
// It is an integrity census, not a latency budget; retain the same finite
// eight-shard I/O allowance as the companion full-catalog scan rail.
const FULL_CATALOG_CENSUS_TIMEOUT_MS = 300_000

const clone = (ledger: DefaultOffLedger): DefaultOffLedger => structuredClone(ledger)

// The corpus is identical for every arm below and costs ~600ms to read, so it
// is read ONCE and injected. Six arms re-reading it put this file at ~3s in
// isolation and over the 15s per-test budget under suite load — it timed out in
// two of eight shards while passing alone every time.
const catalogOnce = loadFeatures(CATALOG_DIR)
const opts = async (): Promise<{ readonly catalog: Awaited<typeof catalogOnce> }> => ({
  catalog: await catalogOnce,
})

describe("DOF-00 default-off authority ledger hellgate", () => {
  test(
    "anti-vacuum: both live CLI seed authorities and the catalog denominator are populated",
    async () => {
      const ledger = await loadDefaultOffLedger(LEDGER_PATH)
      const report = await checkDefaultOffLedger(ledger, await opts())

      expect(report.runtimeCliSeedCount).toBe(31)
      expect(report.eligibleFeatureIds.length).toBeGreaterThanOrEqual(150)
      expect(report.eligibleFeatureIds).toEqual([...report.eligibleFeatureIds].sort())
      // DOF-00 completion invariant: every eligible row resolves every surface
      // default (zero `unknown` cells). Construction-phase allowed unknowns; the
      // finished ledger must not. Remaining `unknown` *values* are proof tiers
      // only (features with genuinely no ON-path test), never surface cells.
      expect(report.unknownSurfaceCount).toBe(0)
      expect(report.summary).toContain(`eligible=${report.eligibleFeatureIds.length}`)
      expect(report.errors).toEqual([])
    },
    { timeout: FULL_CATALOG_CENSUS_TIMEOUT_MS },
  )

  test("missing row and duplicate feature id are rejected", async () => {
    const ledger = await loadDefaultOffLedger(LEDGER_PATH)
    const missing = clone(ledger)
    const removed = missing.rows.shift()
    if (removed === undefined) throw new Error("fixture ledger must contain a row")
    expect((await checkDefaultOffLedger(missing, await opts())).errors).toContain(
      `missing eligible row: ${removed.feature_id}`,
    )

    const duplicate = clone(ledger)
    const first = duplicate.rows[0]
    if (first === undefined) throw new Error("fixture ledger must contain a row")
    duplicate.rows.push(structuredClone(first))
    expect((await checkDefaultOffLedger(duplicate, await opts())).errors).toContain(
      `duplicate feature_id: ${first.feature_id}`,
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
      checkDefaultOffLedger(invalid as unknown as DefaultOffLedger, await opts()),
    ).rejects.toThrow(/"effective_default"[\s\S]*"web"/)
  })

  test("red-on-injection: one wrong derived CLI default fails parity for exactly that row", async () => {
    const ledger = await loadDefaultOffLedger(LEDGER_PATH)
    const mutated = clone(ledger)
    const known = mutated.rows.find((row) => row.effective_default.cli === "on")
    if (known === undefined) throw new Error("fixture ledger must contain a CLI-on row")
    known.effective_default.cli = "off"

    const report = await checkDefaultOffLedger(mutated, await opts())
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

    const report = await checkDefaultOffLedger(mutated, await opts())
    expect(report.errors).toContain(
      `reachability=wired contradicts activation=unwired (a wired feature has a live consumer): ${victim.feature_id}`,
    )
  })

  /**
   * The eligibility label is an EXACT array-element match, so a near-miss spelling
   * does not fail — it silently removes the feature from the audited population.
   *
   * Five aug-02 RFC features carried `gate:default-off` instead of `default-off`
   * and sat outside this ledger for weeks. Nothing could notice: the checker asks
   * "which features are labelled?", and an unlabelled feature is not a violation,
   * it is absent. `QUANTA_PROC_PANEL` therefore read as a knob nobody had decided
   * about, when the truth is nobody had ever been asked.
   *
   * Two invariants, both derived from the label census rather than a hand-list:
   * nothing may spell the eligibility label almost-right, and the `gate:`
   * namespace stays what its three remaining users made it — an ENV KEY holder,
   * not a second place to write a posture.
   */
  test("no label spells the eligibility posture almost-right", async () => {
    const catalog = await catalogOnce
    const nearMiss = catalog.flatMap(({ feature }) =>
      (feature.labels ?? [])
        .filter((label) => label !== "default-off" && /default[-_ ]?off/i.test(label))
        .map((label) => `${feature.id}: ${label}`),
    )
    expect(
      nearMiss,
      "the eligibility label must be the exact literal `default-off` — anything else is absent from the ledger, not rejected by it",
    ).toEqual([])
    // Anti-vacuity: the census must have found the real population, or an empty
    // catalog satisfies the assertion above.
    const eligible = catalog.filter(({ feature }) => (feature.labels ?? []).includes("default-off"))
    expect(
      eligible.length,
      "no default-off features found — this guard read nothing",
    ).toBeGreaterThan(80)
  })

  test("the `gate:` label namespace holds env keys, not postures", async () => {
    const catalog = await catalogOnce
    const offenders = catalog.flatMap(({ feature }) =>
      (feature.labels ?? [])
        .filter((label) => label.startsWith("gate:") && !/^gate:QUANTA_[A-Z0-9_]+$/.test(label))
        .map((label) => `${feature.id}: ${label}`),
    )
    expect(
      offenders,
      "`gate:` names the env var that gates the feature (its three other users all do); a posture belongs in the bare label",
    ).toEqual([])
  })
})

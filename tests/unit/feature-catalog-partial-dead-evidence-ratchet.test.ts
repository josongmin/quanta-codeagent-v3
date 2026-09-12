/**
 * Decreasing-ceiling ratchet on PARTIAL-dead `evidence.code`.
 *
 * # The blind spot
 *
 * `computeReachabilityOffenders` flags an `≥L3` feature only when ALL of its src
 * evidence is dead (`src.every(isDead)`), so a single live file hides any number of
 * dead ones. Measured at this commit: 0 all-dead — the existing gate is genuinely
 * clean — and 83 features carrying 105 dead src files between them.
 *
 * The precise pair "5,398 entries over 2,763 distinct paths" used to sit here. It
 * does not reproduce: an independent parser measures 5,314 / 2,716 and a second
 * measured 5,409 / 2,738, all giving a ratio near 1.96. The counts depend on how a
 * parser decides which `code:` blocks belong to `evidence:`; the RATIO is what the
 * argument needs, so only the ratio is stated.
 *
 * It gets worse with use, not better. `evidence.code` has roughly 2x fan-in — each
 * source path appears in about two features — so appending a path to an entry makes its
 * all-dead test strictly LESS likely to fire. The blind spot widens every time the
 * catalogue is filled in.
 *
 * # Why a ceiling and not a blocker
 *
 * Flipping `every` to `some` fails 83 features in one step, and the gate could not
 * tell a real overclaim from a legitimate one: nothing in the schema distinguishes
 * a dead WIRING file from a dead auxiliary one, and 18 of the 105 are barrel
 * `index.ts` files that an import graph does not traverse by construction. A gate
 * that cannot name what is wrong is a gate people route around.
 *
 * So the number is measured, printed by `bun fc reachability`, and pinned here to
 * shrink only. Promoting it to a blocker needs the primary-vs-auxiliary axis to
 * exist first — that is a separate campaign with 83 triages in it, and doing it
 * silently under a ratchet commit would be the wrong shape.
 *
 * `.d.ts` is excluded from the count: a type declaration is never "reached" by an
 * import graph, so counting one is a measurement error rather than a finding.
 */
import { describe, expect, test } from "bun:test"
import { computePartialDeadEvidence } from "../../tools/feature-catalog/cli"
import { FEATURES_DIR } from "../../tools/feature-catalog/paths"
import { computeReachability } from "../../tools/feature-catalog/reachability"
import { loadFeaturesStrict } from "../../tools/feature-catalog/schema"

/** Measured 2026-09-12. DECREASING only — never raise it to admit a new one.
 *  Shrinks either by wiring the file or by removing evidence that was never true. */
const PARTIAL_DEAD_FEATURE_CEILING = 83
const PARTIAL_DEAD_FILE_CEILING = 105

describe("partial-dead evidence ratchet", () => {
  test(`≤ ${PARTIAL_DEAD_FEATURE_CEILING} features / ${PARTIAL_DEAD_FILE_CEILING} files carry dead evidence beside live`, async () => {
    const [features, reach] = await Promise.all([
      loadFeaturesStrict(FEATURES_DIR),
      computeReachability(),
    ])
    // Anti-vacuity FIRST: a collapsed reach set makes everything look dead, and a
    // collapsed catalogue makes everything look clean. Either would satisfy a bare
    // ceiling comparison.
    expect(
      reach.reached.size,
      "reach graph collapsed — the verdict is meaningless",
    ).toBeGreaterThan(2000)
    expect(features.length, "catalogue collapsed — nothing was examined").toBeGreaterThan(900)

    const rows = computePartialDeadEvidence(features, reach)
    const files = rows.reduce((n, r) => n + r.dead.length, 0)
    // biome-ignore lint/suspicious/noConsole: ratchet visibility, same as the sibling ratchets.
    console.log(
      `[partial-dead] ${rows.length}/${PARTIAL_DEAD_FEATURE_CEILING} features, ${files}/${PARTIAL_DEAD_FILE_CEILING} files`,
    )
    expect(rows.length).toBeLessThanOrEqual(PARTIAL_DEAD_FEATURE_CEILING)
    expect(files).toBeLessThanOrEqual(PARTIAL_DEAD_FILE_CEILING)
  }, 120_000)

  /**
   * RED-ON-INJECTION, both directions. Without the second case "everything is
   * partial-dead" would pass, which is the failure mode of a one-sided fixture.
   */
  test("a feature with one dead and one live src file is counted", async () => {
    const reach = { reached: new Set(["src/live.ts"]) }
    const synthetic = [
      {
        feature: {
          id: "synthetic-partial",
          maturity: "L3",
          evidence: { code: ["src/live.ts", "src/dead.ts"] },
        },
      },
    ] as unknown as Parameters<typeof computePartialDeadEvidence>[0]
    const rows = computePartialDeadEvidence(synthetic, reach)
    expect(rows.map((r) => r.id)).toEqual(["synthetic-partial"])
    expect(rows[0]?.dead).toEqual(["src/dead.ts"])
  })

  test("PAIRED CONTROL — all-live is not counted, and all-dead belongs to the other gate", async () => {
    const reach = { reached: new Set(["src/a.ts", "src/b.ts"]) }
    const mk = (code: readonly string[]) =>
      [{ feature: { id: "x", maturity: "L3", evidence: { code } } }] as unknown as Parameters<
        typeof computePartialDeadEvidence
      >[0]
    expect(computePartialDeadEvidence(mk(["src/a.ts", "src/b.ts"]), reach)).toEqual([])
    // All-dead is `computeReachabilityOffenders`' subject; double-counting it here
    // would make the two ceilings move together and hide which one regressed.
    expect(computePartialDeadEvidence(mk(["src/dead1.ts", "src/dead2.ts"]), reach)).toEqual([])
  })

  test("a dead `.d.ts` is a measurement artefact, not a finding", async () => {
    const reach = { reached: new Set(["src/a.ts"]) }
    const rows = computePartialDeadEvidence(
      [
        {
          feature: { id: "x", maturity: "L3", evidence: { code: ["src/a.ts", "src/x.d.ts"] } },
        },
      ] as unknown as Parameters<typeof computePartialDeadEvidence>[0],
      reach,
    )
    expect(rows).toEqual([])
  })

  test("below the floor is out of scope (L1/L2 need no production importer)", async () => {
    const reach = { reached: new Set(["src/a.ts"]) }
    const rows = computePartialDeadEvidence(
      [
        {
          feature: { id: "x", maturity: "L2", evidence: { code: ["src/a.ts", "src/dead.ts"] } },
        },
      ] as unknown as Parameters<typeof computePartialDeadEvidence>[0],
      reach,
    )
    expect(rows).toEqual([])
  })
})

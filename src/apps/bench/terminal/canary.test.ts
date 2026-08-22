/**
 * TB21-03 — HELLGATE for the 2.1 canary manifest.
 *
 * The ticket's rule is blunt: "Do not reuse the TB2.0 smoke list." That list is
 * not a memory — it was `tools/tb-smoke/run-tb-smoke.sh`. TB21-06 DELETED that
 * driver, so under the retirement stop rule its task list was MIGRATED first
 * into `./retired-tb-2-0-smoke.ts` (retired evidence, with provenance), and this
 * rail now reads THAT typed record. The disjointness proof therefore still binds
 * real data rather than a memory, and it cannot rot when the record is edited.
 * The other rail is revision binding: a canary set is only meaningful for the
 * dataset ref it was chosen against, so a ref change INVALIDATES it.
 */
import { describe, expect, test } from "bun:test"
import { canaryTaskIds, TERMINAL_CANARY_MANIFEST, validateCanaryManifest } from "./canary"
import { CANONICAL_TASK_IDS, canonicalTaskRef, TERMINAL_BENCH_DATASET_REF } from "./dataset"
import { RETIRED_TB_2_0_SMOKE, retiredTb20SmokeTaskNames } from "./retired-tb-2-0-smoke"

/** The TB2.0 smoke set, read from the migrated record (TB21-06 TC-5). */
const tb20SmokeTasks = (): readonly string[] => retiredTb20SmokeTaskNames()

describe("the canary set is generated from the PINNED 2.1 catalog", () => {
  test("every selected id is a canonical task of the pinned dataset", () => {
    const ids = [...canaryTaskIds("oracle"), ...canaryTaskIds("canary")]
    expect(ids.length).toBe(4)
    for (const id of ids) {
      expect(CANONICAL_TASK_IDS, `${id} is not in the pinned catalog`).toContain(id)
      expect(canonicalTaskRef(id)?.startsWith("sha256:")).toBe(true)
    }
  })

  test("ONE oracle task and THREE category-diverse canaries", () => {
    expect(canaryTaskIds("oracle").length).toBe(1)
    expect(canaryTaskIds("canary").length).toBe(3)
    const categories = TERMINAL_CANARY_MANIFEST.tasks.map((t) => t.category)
    expect(new Set(categories).size).toBe(categories.length)
  })

  test("every entry carries a rationale and machine-readable structural checks", () => {
    for (const t of TERMINAL_CANARY_MANIFEST.tasks) {
      expect(t.rationale.length, `${t.id} rationale`).toBeGreaterThan(20)
      expect(t.expectedStructuralChecks.length, `${t.id} checks`).toBeGreaterThan(0)
    }
  })

  test("RED RAIL — the TB2.0 smoke list is NOT reused", () => {
    const legacy = new Set(tb20SmokeTasks())
    // Anti-vacuity: the legacy list really was read, and it carries the three
    // classes the deleted driver declared (GUARD / LEVER_REGRESSION / TARGETS).
    expect(legacy.size).toBeGreaterThanOrEqual(8)
    expect(legacy.has("fix-git")).toBe(true)
    expect(RETIRED_TB_2_0_SMOKE.guard.length).toBeGreaterThan(0)
    expect(RETIRED_TB_2_0_SMOKE.leverRegression.length).toBeGreaterThan(0)
    expect(RETIRED_TB_2_0_SMOKE.targets.length).toBeGreaterThan(0)
    const reused = TERMINAL_CANARY_MANIFEST.tasks
      .map((t) => t.id.split("/").at(-1) as string)
      .filter((short) => legacy.has(short))
    expect(reused, `TB2.0 smoke tasks reused: ${reused.join(", ")}`).toEqual([])
  })
})

describe("revision binding", () => {
  test("the manifest names the pinned dataset ref", () => {
    expect(TERMINAL_CANARY_MANIFEST.datasetRef).toBe(TERMINAL_BENCH_DATASET_REF)
  })

  test("RED RAIL — a mismatched dataset ref INVALIDATES the manifest", () => {
    const stale = { ...TERMINAL_CANARY_MANIFEST, datasetRef: `${TERMINAL_BENCH_DATASET_REF}0` }
    expect(() => validateCanaryManifest(stale)).toThrow(/datasetRef|ref/i)
    expect(() =>
      validateCanaryManifest({ ...TERMINAL_CANARY_MANIFEST, datasetRef: "latest" }),
    ).toThrow(/datasetRef|ref/i)
  })

  test("RED RAIL — a task id outside the pinned catalog is refused", () => {
    expect(() =>
      validateCanaryManifest({
        ...TERMINAL_CANARY_MANIFEST,
        tasks: [
          ...TERMINAL_CANARY_MANIFEST.tasks,
          {
            id: "terminal-bench/not-a-real-task",
            purpose: "canary",
            category: "invented",
            rationale: "x".repeat(40),
            expectedStructuralChecks: ["nope"],
          },
        ],
      }),
    ).toThrow(/not-a-real-task|catalog/i)
  })

  test("PAIRED CONTROL — the shipped manifest validates", () => {
    expect(validateCanaryManifest(JSON.parse(JSON.stringify(TERMINAL_CANARY_MANIFEST)))).toEqual(
      TERMINAL_CANARY_MANIFEST,
    )
  })
})

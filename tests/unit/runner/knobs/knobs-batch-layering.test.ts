/**
 * Hellgate — knobs→batch layering fully restored (aug-30 structural audit G3-01).
 *
 * The knob framework (`src/runner/knobs/`) is CORE, consumed by every surface;
 * `src/runner/batch/` is an app-level consumer. The dependency must point
 * batch→knobs ONLY. Historically two wrong-direction edges closed a mixed
 * batch+knobs import SCC:
 *   - 55 knob files value-imported `deriveKnob` from
 *     `@/runner/batch/eval/kernel/derive` (the "one sanctioned exception" of
 *     cross-slice-cycle.test.ts),
 *   - `knobs/types.ts` type-imported `Instance` from `@/runner/batch/types`,
 *     whose chain (types → score-label → knobs-bench) value-imports
 *     `@/runner/knobs` back.
 * Both are now cut: `deriveKnob` lives at `@/runner/knobs/derive` (batch keeps
 * a forward shim), and `ApplyContext.instance` is typed by the hoisted
 * `ApplyInstance` leaf shape. This guard pins the STRICTER invariant the old
 * exception could not: NO import — value OR type — from `@/runner/batch`
 * anywhere under `src/runner/knobs/`.
 */
import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { assertScanPopulation } from "../../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const KNOBS_DIR = join(REPO_ROOT, "src", "runner", "knobs")

/**
 * Every .ts module under the knobs slice, recursively, reach-asserted.
 *
 * Reach idiom: `assertScanPopulation` is the house instrument, but its floor
 * lives in tools/dev/scan-reach-baseline.json, which this change may not touch
 * (in-flight). Same principle inline instead: reach = the walk INTERSECTED
 * with what git TRACKS (a gitignored twin is not reach), and the two files
 * whose absence would make the ban vacuous-by-omission are named explicitly.
 */
const knobsModules = async (): Promise<string[]> => {
  const entries = await readdir(KNOBS_DIR, { recursive: true })
  const modules = entries.filter((f) => f.endsWith(".ts")).map((f) => join(KNOBS_DIR, f))
  // This file arrived with the tracked-intersection idiom written INLINE, and
  // said why: the baseline it would otherwise pin to was in flight. It is not
  // any more, so the reach moves onto the house instrument — the floor becomes a
  // MEASURED, committed number instead of `>= 70` against 78, which tolerates
  // eight modules disappearing.
  assertScanPopulation(modules, KNOBS_DIR, {
    id: "tests/unit/runner/knobs/knobs-batch-layering.test.ts#KNOBS-DIR",
    collectable: (n) => n.endsWith(".ts"),
  })
  // The two SCC-closing edge sites — if the walk misses either, the ban proves
  // nothing about the very files this guard exists for.
  expect(modules).toContain(join(KNOBS_DIR, "types.ts"))
  expect(modules).toContain(join(KNOBS_DIR, "register-bench-knobs.ts"))
  return modules
}

describe("hellgate / layering — runner/knobs imports NOTHING from runner/batch", () => {
  test("no knobs module imports @/runner/batch (value OR type)", async () => {
    for (const p of await knobsModules()) {
      const txt = await readFile(p, "utf8")
      // Any import/export-from referencing the batch slice — aliased or
      // relative — is a wrong-direction edge. Unlike cross-slice-cycle.test.ts
      // this ban has NO derive exception and covers type-only imports too
      // (the type edge via batch/types was one of the two SCC-closing edges).
      const batchRef = /from\s+["'](@\/runner\/batch|\.\.[./]*\/batch)[/"']/
      expect({ file: p, importsBatch: batchRef.test(txt) }).toEqual({
        file: p,
        importsBatch: false,
      })
    }
  })

  test("the deriveKnob SSOT primitive lives IN the knobs slice", async () => {
    // Producer-side wiring-proof: the ban above cannot be satisfied by simply
    // deleting the primitive — the slice must OWN it.
    const txt = await readFile(join(KNOBS_DIR, "derive.ts"), "utf8")
    expect(txt).toContain("export const deriveKnob")
  })

  test("batch's old derive path is a forward shim pointing batch→knobs", async () => {
    // Direction restored at the old address: batch (and the derive-parity
    // tests importing the old path) consume the knobs-owned primitive.
    const txt = await readFile(
      join(REPO_ROOT, "src", "runner", "batch", "eval", "kernel", "derive.ts"),
      "utf8",
    )
    expect(txt).toContain('from "@/runner/knobs/derive"')
    expect(txt).not.toContain("export const deriveKnob")
  })
})

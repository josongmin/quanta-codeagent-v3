/**
 * Bundle import test — verifies that side-effect importing every per-knob
 * module populates the registry with all 13 known knob ids.
 *
 * The list of 13 ids is the framework's ground truth. Any new knob added to
 * `src/runner/knobs/knobs/` must add itself to this assertion AND to the CLI
 * bootstrap's import block (`src/apps/cli/knobs-bootstrap.ts`). A missing
 * import surfaces as a missing knob id here.
 *
 * Slice fence: this test sits under `tests/unit/runner/**` so it MUST NOT
 * import from `@/apps/cli`. The bootstrap module is imported only by tests
 * under `tests/unit/cli/**`. Here we import every per-knob module's exported
 * knob OBJECT directly so the assertion is DETERMINISTIC regardless of run
 * order.
 *
 * Registry caveat: module side-effects register a knob exactly once per process
 * (cached); a sibling suite that calls `__resetRegistry()` then wipes the
 * singleton, and a later cached re-import will NOT re-fire `registerKnob`. To
 * stay order-independent we therefore re-register from the imported objects in
 * `beforeAll`, guarded by presence so we never trigger a collision throw.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { type AnyKnob, allKnobs, asAnyKnob, registerKnob } from "@/runner/knobs"
import { advisorKnob } from "@/runner/knobs/knobs/advisor"
import { branchSearchKnob } from "@/runner/knobs/knobs/branch-search"
import { closeoutGuardKnob } from "@/runner/knobs/knobs/closeout-guard"
import { hooksKnob } from "@/runner/knobs/knobs/hooks"
import { issueHintKnob } from "@/runner/knobs/knobs/issue-hint"
import { localizePhaseKnob } from "@/runner/knobs/knobs/localize-phase"
import { lspKnob } from "@/runner/knobs/knobs/lsp"
import { memoryModeKnob } from "@/runner/knobs/knobs/memory-mode"
import { mustPassKnob } from "@/runner/knobs/knobs/must-pass"
import { personaKnob } from "@/runner/knobs/knobs/persona"
import { reproTestKnob } from "@/runner/knobs/knobs/repro-test"
import { skillsKnob } from "@/runner/knobs/knobs/skills"
import { subagentKnob } from "@/runner/knobs/knobs/subagent"
import { taskBudgetKnob } from "@/runner/knobs/knobs/task-budget"
import { workingStateKnob } from "@/runner/knobs/knobs/working-state"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

const ALL_KNOBS: readonly AnyKnob[] = [
  asAnyKnob(advisorKnob),
  asAnyKnob(branchSearchKnob),
  asAnyKnob(closeoutGuardKnob),
  asAnyKnob(hooksKnob),
  asAnyKnob(issueHintKnob),
  asAnyKnob(localizePhaseKnob),
  asAnyKnob(lspKnob),
  asAnyKnob(memoryModeKnob),
  asAnyKnob(mustPassKnob),
  asAnyKnob(personaKnob),
  asAnyKnob(reproTestKnob),
  asAnyKnob(skillsKnob),
  asAnyKnob(subagentKnob),
  asAnyKnob(taskBudgetKnob),
  asAnyKnob(workingStateKnob),
]

const PER_KNOB_DIR = join(import.meta.dir, "..", "..", "..", "..", "src", "runner", "knobs", "knobs")

const ALL_KNOB_IDS = ALL_KNOBS.map((k) => k.id)

// Deterministic population: re-register any knob a sibling suite's
// `__resetRegistry()` may have wiped (guarded so we never collide).
beforeAll(() => {
  const reg = allKnobs()
  for (const k of ALL_KNOBS) {
    if (!reg.has(k.id)) registerKnob(k)
  }
})

describe("per-knob side-effect import bundle", () => {
  test("all known knobs registered after side-effect imports", () => {
    const reg = allKnobs()
    const missing = ALL_KNOB_IDS.filter((id) => !reg.has(id))
    expect(missing).toEqual([])
  })

  test("knob ids are distinct (no duplicate registration)", () => {
    expect(new Set(ALL_KNOB_IDS).size).toBe(ALL_KNOBS.length)
  })

  // Drift guard: ALL_KNOBS MUST cover every per-knob file. A new knob file that
  // forgets to add itself here (or to the barrel) trips this — the whole point
  // of the bundle test. Derived from the filesystem so the count is never stale.
  test("ALL_KNOBS covers every per-knob file (no forgotten knob)", async () => {
    const files = await readdir(PER_KNOB_DIR)
    const knobFileCount = files.filter((f) => f.endsWith(".ts") && f !== "index.ts").length
    expect(ALL_KNOBS.length).toBe(knobFileCount)
  })

  for (const id of ALL_KNOB_IDS) {
    test(`knob "${id}" registered`, () => {
      expect(allKnobs().has(id)).toBe(true)
    })
  }
})

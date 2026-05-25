/**
 * Bundle import test — verifies that side-effect importing every per-knob
 * module populates the registry with all 12 known knob ids.
 *
 * The list of 12 ids is the framework's ground truth. Any new knob added to
 * `src/runner/knobs/knobs/` must add itself to this assertion AND to the CLI
 * bootstrap's import block (`src/apps/cli/knobs-bootstrap.ts`). A missing
 * import surfaces as a missing knob id here.
 *
 * Slice fence: this test sits under `tests/unit/runner/**` so it MUST NOT
 * import from `@/apps/cli`. The bootstrap module is imported only by tests
 * under `tests/unit/cli/**`. Here we replicate the side-effect-import block
 * inline so the registry is populated regardless of run order.
 *
 * Registry caveat: other test files may call `__resetRegistry()` and then
 * re-register; we don't assert a strict size, only membership of the 12 ids
 * the framework exposes.
 */
import { describe, expect, test } from "bun:test"
import { allKnobs } from "@/runner/knobs"

// Replicate the bootstrap's side-effect imports (alphabetical).
import "@/runner/knobs/knobs/branch-search"
import "@/runner/knobs/knobs/closeout-guard"
import "@/runner/knobs/knobs/hooks"
import "@/runner/knobs/knobs/issue-hint"
import "@/runner/knobs/knobs/localize-phase"
import "@/runner/knobs/knobs/lsp"
import "@/runner/knobs/knobs/must-pass"
import "@/runner/knobs/knobs/persona"
import "@/runner/knobs/knobs/repro-test"
import "@/runner/knobs/knobs/skills"
import "@/runner/knobs/knobs/subagent"
import "@/runner/knobs/knobs/working-state"

const ALL_KNOB_IDS = [
  "branch-search",
  "closeout-guard",
  "hooks",
  "issue-hint",
  "localize-phase",
  "lsp",
  "must-pass",
  "persona",
  "repro-test",
  "skills",
  "subagent",
  "working-state",
] as const

describe("per-knob side-effect import bundle", () => {
  test("all 12 known knobs registered after side-effect imports", () => {
    const reg = allKnobs()
    const missing = ALL_KNOB_IDS.filter((id) => !reg.has(id))
    expect(missing).toEqual([])
  })

  for (const id of ALL_KNOB_IDS) {
    test(`knob "${id}" registered`, () => {
      expect(allKnobs().has(id)).toBe(true)
    })
  }
})

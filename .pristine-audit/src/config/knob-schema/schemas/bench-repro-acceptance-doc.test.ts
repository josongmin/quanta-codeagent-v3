import { describe, expect, test } from "bun:test"
import { acceptanceSchema } from "./bench-repro"

/**
 * B5 — the acceptance selector re-ranks the REPAIR-BREADTH candidates; with a
 * single candidate (repair-breadth unset ⇒ projected to 1) there is nothing to
 * re-rank, so `QUANTA_BENCH_ACCEPTANCE` alone is a NO-OP. The knob describe MUST
 * document the `repair-breadth > 1` prerequisite so an operator does not enable
 * acceptance expecting an effect that never fires.
 */
describe("B5 acceptance schema documents the repair-breadth>1 prerequisite", () => {
  test("describe names repair-breadth as a prerequisite", () => {
    expect(acceptanceSchema.describe.toLowerCase()).toContain("repair-breadth")
    // must state the >1 condition (no-op with a single candidate)
    expect(acceptanceSchema.describe).toMatch(/breadth\s*>\s*1|>\s*1|no-op/i)
  })
})

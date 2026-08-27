/**
 * DRIFT RATCHET for the mutation-check proof rail.
 *
 * WHAT ROTTED, AND WHY IT WAS INVISIBLE
 * -------------------------------------
 * `tools/dev/mutation-check.ts` is the red-on-injection proof rail for the
 * May-31 bugbash hellgates: for each entry it pins an exact `find` string that
 * must be present in a production `src` file, swaps it for a `replace` that
 * restores the PRE-fix shape, and asserts the guarding hellgate turns red.
 *
 * The pin is a byte-exact string. Ordinary refactors move it: a de-nested
 * block changes its indentation, a god-module split moves it to a new file, an
 * extracted helper changes the surrounding lines. When that happens the tool's
 * `applyRevert` throws -- correctly, it refuses to read a drifted pin as a
 * blind spot -- but it throws OUT OF THE LOOP, so every entry after the first
 * drifted one never runs either. Measured on 2026-08-26: 3 of 14 entries had
 * drifted, the first of them was entry #1, and effective coverage was
 * therefore 0/14. Three CRITICAL/HIGH hellgates had no red-on-injection proof
 * at all and nothing in the suite said so, because the tool is not part of the
 * test run.
 *
 * WHAT THIS ASSERTS
 * -----------------
 * Statically -- no source file is ever written -- for EVERY entry:
 *   1. the target `src` file EXISTS, and
 *   2. the `find` string occurs in it EXACTLY ONCE.
 * Uniqueness matters as much as presence: the tool's `String.replace` swaps
 * only the FIRST match, so a pin that became ambiguous would mutate the wrong
 * site and prove nothing.
 *
 * ANTI-VACUITY
 * ------------
 * A guard that iterates a list can pass by iterating nothing, and a guard that
 * reads a file can pass by reading a file that is gone (`existsSync` false =>
 * "no occurrences to check"). So the entry list is asserted non-empty, and a
 * missing file is a FAILURE rather than a skip. The paired controls at the
 * bottom feed the same checker synthetic entries -- one whose `find` is absent,
 * one whose file is renamed away -- and assert both are REPORTED, proving the
 * checker can say no.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { MUTATIONS, type Mutation } from "../../../tools/dev/mutation-check"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** One thing wrong with one entry, rendered into the failure message. */
interface Drift {
  readonly id: string
  readonly src: string
  readonly problem: string
}

/**
 * The checker under test. Pure: takes entries, returns the drifts it found.
 * Shared by the real-array assertion and the synthetic paired controls so the
 * controls exercise the SAME code path, not a re-implementation of it.
 */
const findDrifts = (entries: readonly Mutation[]): readonly Drift[] => {
  const drifts: Drift[] = []
  for (const m of entries) {
    const abs = join(REPO_ROOT, m.src)
    if (!existsSync(abs)) {
      drifts.push({ id: m.id, src: m.src, problem: "TARGET FILE MISSING" })
      continue
    }
    const occurrences = readFileSync(abs, "utf8").split(m.find).length - 1
    if (occurrences !== 1) {
      drifts.push({
        id: m.id,
        src: m.src,
        problem:
          occurrences === 0
            ? "find-string NOT PRESENT (0x) -- the pinned text drifted"
            : `find-string NOT UNIQUE (${occurrences}x) -- tighten it`,
      })
    }
  }
  return drifts
}

const render = (drifts: readonly Drift[]): string =>
  drifts.map((d) => `  ${d.id}  [${d.src}]  ${d.problem}`).join("\n")

describe("mutation-check proof rail -- pinned find-strings have not drifted", () => {
  test("the entry list is non-empty (a vacuous sweep would pass silently)", () => {
    expect(MUTATIONS.length).toBeGreaterThan(0)
  })

  test("every entry names a src file that EXISTS", () => {
    const missing = MUTATIONS.filter((m) => !existsSync(join(REPO_ROOT, m.src))).map((m) => m.src)
    expect(missing).toEqual([])
  })

  test("every entry's `find` occurs EXACTLY ONCE in its target src file", () => {
    const drifts = findDrifts(MUTATIONS)
    expect(
      drifts.length === 0
        ? "no drift"
        : `${drifts.length}/${MUTATIONS.length} mutation entries have drifted -- ` +
            "mutation-check throws out of its loop on the FIRST of these, so every entry " +
            `after it is unproven too:\n${render(drifts)}`,
    ).toBe("no drift")
  })

  test("PAIRED CONTROL: the checker REPORTS a synthetic entry whose find is absent", () => {
    const absent: Mutation = {
      id: "synthetic-absent-find",
      severity: "CRITICAL",
      guards: "paired control -- proves this ratchet can fail",
      // A real, present file, so only the `find` is the variable under test.
      src: "tools/dev/mutation-check.ts",
      find: "  this exact text is not in any source file  ",
      replace: "irrelevant",
      gate: "tests/unit/_arch/mutation-check-drift-ratchet.test.ts",
    }
    const drifts = findDrifts([absent])
    expect(drifts.map((d) => d.id)).toEqual(["synthetic-absent-find"])
    expect(drifts[0]?.problem).toContain("NOT PRESENT")
  })

  test("PAIRED CONTROL: the checker REPORTS a synthetic entry whose src file is gone", () => {
    const renamedAway: Mutation = {
      id: "synthetic-missing-file",
      severity: "HIGH",
      guards: "paired control -- a renamed-away target must not read as a pass",
      src: "src/does/not/exist/after-a-rename.ts",
      // If a missing file were treated as "nothing to check", this would pass.
      // It must be REPORTED instead.
      find: "export const x = 1",
      replace: "irrelevant",
      gate: "tests/unit/_arch/mutation-check-drift-ratchet.test.ts",
    }
    const drifts = findDrifts([renamedAway])
    expect(drifts.map((d) => d.problem)).toEqual(["TARGET FILE MISSING"])
  })
})

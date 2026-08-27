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
 * Statically -- no source file is ever written, nothing is spawned -- for EVERY
 * entry:
 *   1. the target `src` file EXISTS, and
 *   2. the `find` string occurs in it EXACTLY ONCE, and
 *   3. the `gate` file EXISTS, and
 *   4. the entry HAS an `only` filter, and
 *   5. that `only` COMPILES as a regex.
 * Uniqueness matters as much as presence: the tool's `String.replace` swaps
 * only the FIRST match, so a pin that became ambiguous would mutate the wrong
 * site and prove nothing.
 *
 * 3/4/5 come from the tool's own `findStaticProblems`, not a copy of the rule.
 * They live here because the tool's pre-flight is MANUAL: measured 2026-08-28,
 * gutting its width guard to `if (ran >= 0)` left this file at 5 pass / 0 fail
 * -- the guard SURVIVED, because nothing in `bun test` reached it. Everything
 * about the entry list that can be checked without spawning is checked here
 * instead.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER: selection WIDTH -- that `only` selects
 * exactly one test -- because measuring it costs one `bun test` spawn per entry
 * (14 entries today, one filtered gate spawn measured 2.4-2.7s each) and `bun
 * test` has no dry-run mode to make it cheap. That
 * check stays in the tool and is labelled MANUAL there. Nor does width prove
 * the RIGHT test was selected; a wrong-but-narrow filter is fail-loud (the
 * unrelated test stays green under the revert => reported BLIND SPOT), which is
 * why it is left open rather than papered over with a name-shape rule.
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
import {
  findOccurrences,
  findStaticProblems,
  MUTATIONS,
  type Mutation,
} from "../../../tools/dev/mutation-check"

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
    // SAME function the tool runs, not a copy of the rule.
    const occurrences = findOccurrences(readFileSync(abs, "utf8"), m.find)
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
    // OWN floor. A sibling test asserting non-emptiness does not stop THIS loop
    // from passing over an empty list on a machine where the import resolved to
    // nothing -- each loop carries its own.
    expect(MUTATIONS.length).toBeGreaterThan(0)
    const missing = MUTATIONS.filter((m) => !existsSync(join(REPO_ROOT, m.src))).map((m) => m.src)
    expect(missing).toEqual([])
  })

  test("every entry's `find` occurs EXACTLY ONCE in its target src file", () => {
    expect(MUTATIONS.length).toBeGreaterThan(0) // OWN floor -- see above.
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

/**
 * The pure half of the tool's pre-flight, hoisted into `bun test`.
 *
 * `findStaticProblems` is the tool's OWN function -- these arms run the same
 * code the tool runs, not a re-implementation of it. The paired controls inject
 * `gateExists` so a synthetic entry can name a gate that does not exist without
 * this test needing a fixture file on disk.
 */
describe("mutation-check proof rail -- the entry list survives static pre-flight", () => {
  const allExist = (): boolean => true

  test("every entry passes the tool's static pre-flight", () => {
    expect(MUTATIONS.length).toBeGreaterThan(0) // OWN floor.
    const problems = findStaticProblems(MUTATIONS)
    expect(
      problems.length === 0
        ? "clean"
        : `${problems.length} entr(ies) fail the tool's OWN static pre-flight:\n` +
            problems.map((p) => `  ${p.id}  [${p.field}]  ${p.problem}`).join("\n"),
    ).toBe("clean")
  })

  test("every entry HAS an `only` filter (absent => the whole gate file runs)", () => {
    expect(MUTATIONS.length).toBeGreaterThan(0) // OWN floor.
    const unfiltered = MUTATIONS.filter((m) => m.only === undefined).map((m) => m.id)
    expect(unfiltered).toEqual([])
  })

  test("PAIRED CONTROL: an entry with NO `only` is REPORTED, attributed to `only`", () => {
    const noFilter: Mutation = {
      id: "synthetic-no-only",
      severity: "CRITICAL",
      guards: "paired control -- proves the absent-filter arm can fail",
      src: "tools/dev/mutation-check.ts",
      find: "irrelevant",
      replace: "irrelevant",
      gate: "tests/unit/_arch/mutation-check-drift-ratchet.test.ts",
      // `only` deliberately omitted.
    }
    const problems = findStaticProblems([noFilter], allExist)
    expect(problems.map((p) => p.id)).toEqual(["synthetic-no-only"])
    expect(problems[0]?.field).toBe("only")
    expect(problems[0]?.problem).toContain("NO `only` filter")
  })

  test("PAIRED CONTROL: a MISSING gate is attributed to `gate`, not to `only`", () => {
    // THE MISATTRIBUTION THIS CLOSES. The width check reads a missing gate and a
    // filter that matched nothing identically -- neither prints a summary line --
    // so it used to say "`only` selected an unreadable count ... anchor it to the
    // LEAF test name" about an entry whose `only` was perfectly good and whose
    // gate file simply did not exist. The field must name the real input.
    const goneGate: Mutation = {
      id: "synthetic-missing-gate",
      severity: "HIGH",
      guards: "paired control -- a renamed gate must not read as a bad filter",
      src: "tools/dev/mutation-check.ts",
      find: "irrelevant",
      replace: "irrelevant",
      gate: "src/permission/__tests__/renamed-away.hellgate.test.ts",
      only: "a perfectly good leaf test name",
    }
    const problems = findStaticProblems([goneGate], (gate) => gate !== goneGate.gate)
    expect(problems.map((p) => p.field)).toEqual(["gate"])
    expect(problems[0]?.problem).toContain("gate file DOES NOT EXIST")
    expect(problems[0]?.problem).not.toContain("LEAF test name")
  })

  test("PAIRED CONTROL: an `only` that is not a valid regex is REPORTED", () => {
    // `-t` compiles its argument. An entry whose filter throws selects nothing,
    // and "selects nothing" is an unkillable green for every mutant under it.
    const badRegex: Mutation = {
      id: "synthetic-uncompilable-only",
      severity: "MED",
      guards: "paired control -- proves the regex arm can fail",
      src: "tools/dev/mutation-check.ts",
      find: "irrelevant",
      replace: "irrelevant",
      gate: "tests/unit/_arch/mutation-check-drift-ratchet.test.ts",
      only: "unbalanced ( paren",
    }
    const problems = findStaticProblems([badRegex], allExist)
    expect(problems.map((p) => p.field)).toEqual(["only"])
    expect(problems[0]?.problem).toContain("not a valid regex")
  })

  test("PAIRED CONTROL: a well-formed entry produces NO problems (no blanket red)", () => {
    // Without this, every arm above would still pass if `findStaticProblems`
    // returned a problem for literally everything.
    const clean: Mutation = {
      id: "synthetic-clean",
      severity: "MED",
      guards: "paired control -- the checker must also be able to say yes",
      src: "tools/dev/mutation-check.ts",
      find: "irrelevant",
      replace: "irrelevant",
      gate: "tests/unit/_arch/mutation-check-drift-ratchet.test.ts",
      only: "hostMutationVerdict\\(.custom.\\) === .defer.",
    }
    expect(findStaticProblems([clean], allExist)).toEqual([])
  })
})

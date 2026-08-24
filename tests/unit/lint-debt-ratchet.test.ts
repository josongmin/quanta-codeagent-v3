/**
 * HELLGATE — the lint-debt ceiling is reachable from `bun test`.
 *
 * This repo gates growth with one-directional ratchets, and five of them are
 * `tests/unit/*-ratchet.test.ts`: god-code, silent-failure-growth, pm-dod, the
 * two default-off-ledger rails. Running `bun test tests/unit/` therefore catches
 * a regression in any of them.
 *
 * `lint:debt` was the exception. It lives only as a `package.json` script
 * (`tools/dev/lint-debt-ceiling.ts`), so a change sweep that ran the whole unit
 * suite — the thing every contributor and every agent actually does — could not
 * see it. Measured: it went RED on main (`noTemplateCurlyInString 24 > 22`)
 * while all five sibling ratchets stayed green, and the regression survived a
 * full `bun test tests/unit/` pass plus a `typecheck:all` pass.
 *
 * That is not a lint problem. It is a REACHABILITY problem: a guard nobody's
 * normal command can reach is a guard that only fires after the fact, in
 * someone else's session.
 *
 * This wraps the SHIPPED script — spawning it, not reimplementing its counting —
 * so the test can never drift from what `bun run lint:debt` reports. A
 * reimplementation would be a second authority, which is the failure mode the
 * ratchet itself exists to prevent.
 */

import { describe, expect, test } from "bun:test"

import { evaluateCeilings, scopeKey, scopeOfPath } from "@/../tools/dev/lint-debt-ceiling"

const REPO_ROOT = new URL("../../", import.meta.url).pathname

describe("lint-debt ceiling — reachable from the unit suite", () => {
  test(
    "`lint:debt` passes (no new lint debt; fix the site, never raise the ceiling)",
    () => {
      const run = Bun.spawnSync({
        cmd: ["bun", "run", "tools/dev/lint-debt-ceiling.ts"],
        cwd: REPO_ROOT,
      })
      const stdout = new TextDecoder().decode(run.stdout)
      const stderr = new TextDecoder().decode(run.stderr)
      // Surface the script's own diagnosis on failure — the ceiling file names
      // the offending rule and both numbers, which is what the fixer needs.
      expect({ exitCode: run.exitCode, report: `${stdout}${stderr}`.trim() }).toEqual({
        exitCode: 0,
        report: expect.stringContaining("lint-debt:") as unknown as string,
      })
    },
    { timeout: 180_000 },
  )

  /**
   * `scopeOfPath` decides which ceiling a diagnostic is measured against, and
   * for `noNonNullAssertion` the two ceilings are 0 and 593 — so a
   * misclassification does not shift a number, it decides whether the rule is
   * enforced at all. A colocated `src/**\/*.test.ts` counted as `prod` would
   * make the prod ceiling unsatisfiable; a `src/` module counted as `tests`
   * would let production debt grow into a 593-wide allowance.
   *
   * These cases are the classifier's own contract, pinned against the shipped
   * function rather than a copy of its regex.
   */
  describe("scope classification", () => {
    const PROD = [
      "src/agent/loop.ts",
      "src/tool/edit/index.ts",
      `${REPO_ROOT}src/apps/cli/main.ts`,
      // "test" as an ordinary path word, not a test file:
      "src/apps/bench/testrun/parse.ts",
      "src/tool/testrun/detect.ts",
      "src/latest.ts",
    ]
    const TESTS = [
      // Colocated tests SHIP in src/ but run only under the test runner.
      "src/agent/__tests__/loop.hellgate.test.ts",
      "src/apps/bench/dataset-family.test.ts",
      "src/llm/replay/__tests__/s3-replay-store.test.ts",
      "src/foo.spec.ts",
      "src/foo.test.tsx",
      "src/foo.test.mts",
      // Outside src/ entirely.
      "tests/unit/agent/loop.test.ts",
      "tools/dev/lint-debt-ceiling.ts",
      "scripts/whatever.ts",
      // Unrecognized shapes must NOT land in prod: the tight ceiling is the one
      // that must never be reachable by accident.
      "",
      "weird-path-with-no-prefix.ts",
      "srcnot/agent/loop.ts",
    ]

    test("production modules classify as prod", () => {
      expect(PROD.length).toBeGreaterThan(4) // anti-vacuity
      for (const p of PROD) expect({ p, scope: scopeOfPath(p) }).toEqual({ p, scope: "prod" })
    })

    test("tests, tools, and unclassifiable paths classify as tests", () => {
      expect(TESTS.length).toBeGreaterThan(8)
      for (const p of TESTS) expect({ p, scope: scopeOfPath(p) }).toEqual({ p, scope: "tests" })
    })
  })

  /**
   * The comparison itself, driven on synthetic inputs.
   *
   * Everything else in this script announces its own breakage — a crashed biome
   * run, a missing report, a degenerate scope classification all exit non-zero
   * with a reason. This is the part that fails QUIETLY: a scoped rule that
   * stopped being compared would print the same reassuring summary and gate
   * nothing, and the only way to notice would be for someone to add debt and
   * watch it sail through. So the comparison is exercised directly.
   */
  describe("ceiling comparison", () => {
    const RULE = "lint/style/noNonNullAssertion"
    const scan = (prod: number, tests: number) => ({
      counts: new Map([[RULE, prod + tests]]),
      scopedCounts: new Map([
        [scopeKey(RULE, "prod"), prod],
        [scopeKey(RULE, "tests"), tests],
      ]),
      ceiling: {
        rules: {},
        scopedRules: { [RULE]: { prod: 0, tests: 593 } },
        worstComplexity: 65,
      },
      worstComplexity: 65,
      worstSite: "x.ts",
    })

    test("at the ceiling in both scopes — clean", () => {
      const v = evaluateCeilings(scan(0, 593))
      expect({ regressions: v.regressions, unpinned: v.unpinned, drops: v.drops }).toEqual({
        regressions: [],
        unpinned: [],
        drops: [],
      })
    })

    test("🔴 one new assertion in PRODUCTION is a regression against a ceiling of 0", () => {
      const v = evaluateCeilings(scan(1, 593))
      expect(v.regressions).toEqual([`  ${RULE} [prod]: 1 > 0`])
    })

    test("🔴 one new assertion in TESTS is a regression in its own scope", () => {
      const v = evaluateCeilings(scan(0, 594))
      expect(v.regressions).toEqual([`  ${RULE} [tests]: 594 > 593`])
    })

    test("🔴 SUBSTITUTION: +1 prod / -1 tests — the case an aggregate ceiling cannot see", () => {
      // This is the whole reason the universe is split. The repo-wide total is
      // 593 before and 593 after, so a single flat ceiling passes it — while
      // production code has just gained an assertion that a ceiling of 0 exists
      // precisely to forbid.
      const before = scan(0, 593)
      const after = scan(1, 592)
      expect([...before.counts.values()]).toEqual([...after.counts.values()]) // total unchanged
      expect(evaluateCeilings(after).regressions).toEqual([`  ${RULE} [prod]: 1 > 0`])
    })

    test("an improvement in one scope is a drop, not a regression, and does not mask the other", () => {
      const v = evaluateCeilings(scan(0, 500))
      expect(v.regressions).toEqual([])
      expect(v.drops).toEqual([`${RULE}[tests] 593→500`])
    })

    test("a scope missing from the ceiling file is UNPINNED (closed universe), not a free pass", () => {
      const base = scan(4, 10)
      const v = evaluateCeilings({
        ...base,
        ceiling: {
          rules: {},
          scopedRules: { [RULE]: { tests: 10 } as never },
          worstComplexity: 65,
        },
      })
      expect(v.unpinned).toEqual([`  4× ${RULE} [prod]  (scope absent from the ceiling ⇒ 0)`])
    })

    test("a rule pinned in BOTH tables refuses to produce a verdict at all", () => {
      const base = scan(0, 593)
      const v = evaluateCeilings({
        ...base,
        ceiling: {
          rules: { [RULE]: 593 },
          scopedRules: { [RULE]: { prod: 0, tests: 593 } },
          worstComplexity: 65,
        },
      })
      expect(v.doublePinned).toEqual([RULE])
      // …and reports nothing else, so a caller cannot mistake it for a pass.
      expect([...v.regressions, ...v.unpinned, ...v.drops]).toEqual([])
    })

    test("a scoped rule that stopped firing entirely still reports its drop", () => {
      // Otherwise the ceiling would sit above zero with nothing holding it, and
      // the next 593 assertions would be free.
      const v = evaluateCeilings({
        counts: new Map(),
        scopedCounts: new Map(),
        ceiling: {
          rules: {},
          scopedRules: { [RULE]: { prod: 0, tests: 593 } },
          worstComplexity: 65,
        },
        worstComplexity: 65,
        worstSite: "x.ts",
      })
      expect(v.drops).toEqual([`${RULE}[tests] 593→0`])
    })
  })
})

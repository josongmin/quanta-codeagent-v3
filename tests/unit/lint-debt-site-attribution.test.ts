/**
 * The lint-debt gate NAMES the files behind a breached ceiling.
 *
 * WHAT WENT WRONG. The gate printed `lint/suspicious/noConsole: 75 > 69` and
 * stopped there. Measured 2026-08-28, turning that number into a file took six
 * separate measurements: re-deriving the tool's own target set (which is not
 * `src tools tests` — a raw biome run over those paths reports a DIFFERENT
 * population), re-running biome with the JSON reporter, and grouping by path by
 * hand. The answer was a scratch file a subagent had left under `tests/unit/`,
 * which is untracked and therefore invisible in every diff. The gate had that
 * file in memory when it printed the number and threw it away.
 *
 * WHY IT IS SHAPED THIS WAY. `evaluateCeilings` is pure and already pinned by
 * tests, so the sites arrive as an OPTIONAL argument: supplied, every breach
 * line gains a `— in <file> (n)` suffix; omitted, the output is byte-identical
 * to what it has always been. That is what lets this land without touching the
 * existing pins, and A-2 is the arm that proves the promise rather than
 * asserting it in a comment.
 *
 *   A-1  a breach names its files, most-offending first
 *   A-2  PAIRED CONTROL — with no sites supplied the line is unchanged
 *   A-3  a SCOPED breach lists only files in the BREACHING scope
 *   A-4  the list is capped, and the elision is counted, not silent
 *   A-5  PAIRED CONTROL — a rule under its ceiling stays silent
 */

import { describe, expect, test } from "bun:test"
import {
  type Ceiling,
  evaluateCeilings,
  SITE_LIST_CAP,
  type SiteAttribution,
  scopeKey,
} from "../../tools/dev/lint-debt-ceiling"

const RULE = "lint/suspicious/noConsole"

/** Default classifier: `src/` is prod, everything else is tests — the same rule
 *  the tool applies. Passed as part of the ATTRIBUTION value, never beside it,
 *  because the two being separable is what A-7 exists to prevent. */
const bySrcPrefix = (file: string): "prod" | "tests" => (file.startsWith("src/") ? "prod" : "tests")

const sites = (
  rows: Record<string, Record<string, number>>,
  scopeOfFile: (file: string) => "prod" | "tests" = bySrcPrefix,
): SiteAttribution => ({
  byRule: new Map(Object.entries(rows).map(([rule, files]) => [rule, new Map(Object.entries(files))])),
  scopeOfFile,
})

const evaluate = (args: {
  counts?: ReadonlyMap<string, number>
  scopedCounts?: ReadonlyMap<string, number>
  ceiling: Ceiling
  sitesByRule?: SiteAttribution
}) =>
  evaluateCeilings({
    counts: args.counts ?? new Map<string, number>(),
    scopedCounts: args.scopedCounts ?? new Map<string, number>(),
    ceiling: args.ceiling,
    worstComplexity: 0,
    worstSite: "<none>",
    // Spread rather than assign: under `exactOptionalPropertyTypes` an explicit
    // `undefined` is NOT the same as an absent key, and "absent" is precisely
    // what A-2 is about.
    ...(args.sitesByRule === undefined ? {} : { sites: args.sitesByRule }),
  })

describe("A — a breached lint ceiling names its sites", () => {
  test("A-1 an aggregate breach lists the files, most-offending first", () => {
    const v = evaluate({
      counts: new Map([[RULE, 71]]),
      ceiling: { rules: { [RULE]: 69 }, worstComplexity: 999 },
      sitesByRule: sites({
        [RULE]: {
          "tests/unit/permission/_probe-scratch.ts": 1,
          "src/apps/eval/index.ts": 68,
          "tests/unit/skill-discover-size-cap.test.ts": 2,
        },
      }),
    })
    expect(v.regressions).toEqual([
      "  lint/suspicious/noConsole: 71 > 69 — in src/apps/eval/index.ts (68), " +
        "tests/unit/skill-discover-size-cap.test.ts (2), tests/unit/permission/_probe-scratch.ts (1)",
    ])
  })

  test("A-2 PAIRED CONTROL — with NO sites supplied the line is exactly what it was", () => {
    // This is the compatibility promise the optional argument exists to keep.
    // If it ever stops holding, the existing pins on `evaluateCeilings` break
    // for a reason that has nothing to do with lint debt.
    const v = evaluate({
      counts: new Map([[RULE, 71]]),
      ceiling: { rules: { [RULE]: 69 }, worstComplexity: 999 },
    })
    expect(v.regressions).toEqual(["  lint/suspicious/noConsole: 71 > 69"])
  })

  test("A-3 a SCOPED breach lists only the files in the BREACHING scope", () => {
    // The scoped ceilings are the subtle case: `[tests]` blew its cap, and
    // listing the prod files under it would send the reader to a file that is
    // within its own ceiling. Attribution that points at the wrong file is
    // worse than none.
    const scoped = "lint/style/noNonNullAssertion"
    const v = evaluate({
      counts: new Map([[scoped, 9]]),
      scopedCounts: new Map([
        [scopeKey(scoped, "prod"), 4],
        [scopeKey(scoped, "tests"), 5],
      ]),
      ceiling: {
        rules: {},
        scopedRules: { [scoped]: { prod: 4, tests: 2 } },
        worstComplexity: 999,
      },
      sitesByRule: sites({
        [scoped]: { "src/a.ts": 3, "src/b.ts": 1, "tests/unit/c.test.ts": 5 },
      }),
    })
    expect(v.regressions).toEqual([
      "  lint/style/noNonNullAssertion [tests]: 5 > 2 — in tests/unit/c.test.ts (5)",
    ])
    // PAIRED CONTROL — prod is AT its ceiling, so it must not be reported at
    // all, with or without a file list.
    expect(v.regressions.join()).not.toContain("src/a.ts")
  })

  test("A-4 the list is CAPPED, and the elision is counted rather than silent", () => {
    const many = Object.fromEntries(
      Array.from({ length: SITE_LIST_CAP + 3 }, (_, i) => [`src/f${i}.ts`, SITE_LIST_CAP + 3 - i]),
    )
    const total = Object.values(many).reduce((a, b) => a + b, 0)
    const v = evaluate({
      counts: new Map([[RULE, total]]),
      ceiling: { rules: { [RULE]: 0 }, worstComplexity: 999 },
      sitesByRule: sites({ [RULE]: many }),
    })
    const line = v.regressions[0] ?? ""
    // Exactly SITE_LIST_CAP files are named...
    expect(line.match(/src\/f\d+\.ts/g)?.length).toBe(SITE_LIST_CAP)
    // ...and the remainder is stated, not dropped. A cap that silently
    // truncated would read as "these are the offenders" when it is not.
    expect(line).toContain("and 3 more file(s)")
  })

  test("A-5 PAIRED CONTROL — a rule UNDER its ceiling names nothing", () => {
    const v = evaluate({
      counts: new Map([[RULE, 68]]),
      ceiling: { rules: { [RULE]: 69 }, worstComplexity: 999 },
      sitesByRule: sites({ [RULE]: { "src/apps/eval/index.ts": 68 } }),
    })
    expect(v.regressions).toEqual([])
    expect(v.unpinned).toEqual([])
    // ...and it is reported as a DROP, so `--tighten` can still see it. (The
    // synthetic `worstComplexity: 999` drops alongside it; the arm is about the
    // RULE, so pin that entry rather than the whole list.)
    expect(v.drops).toContain("lint/suspicious/noConsole 69→68")
  })

  test("A-6 an UNPINNED rule is attributed too — that is the harder one to find", () => {
    // An unpinned rule has no ceiling to diff against, so "which file" is the
    // ONLY actionable fact the gate can offer about it.
    const v = evaluate({
      counts: new Map([["format", 2]]),
      ceiling: { rules: {}, worstComplexity: 999 },
      sitesByRule: sites({ format: { "src/x.ts": 1, "tests/y.test.ts": 1 } }),
    })
    expect(v.unpinned).toEqual([
      "  2× format  (not in the ceiling file ⇒ ceiling 0) — in src/x.ts (1), tests/y.test.ts (1)",
    ])
  })
})

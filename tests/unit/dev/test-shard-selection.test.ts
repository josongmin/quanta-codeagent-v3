/**
 * The two floors the shard runner owns, executed rather than read.
 *
 * # Why this file exists at all
 *
 * `run-test-shards.ts` ends in a top-level `await main()`, so importing it runs
 * a campaign. Every check inside it was therefore unreachable from a test, and
 * the only evidence for the floors was a source read. Worse, the tier floor was
 * "verified" on a DIRTY tree — where the clean-checkout guard fires first and
 * the tier check is never reached — so the runtime path had no execution
 * evidence behind it at all. That is the repo's own named trap: a pure function
 * tested in isolation while the surface that calls it stays inert.
 *
 * The sequence is extracted into `test-shard-selection.ts` with its inputs
 * injected, and these run it.
 *
 * # What the floors must keep apart
 *
 *   suite floor  — the PRE-selection universe. A suite root that still exists
 *                  but stops yielding files shrinks the corpus silently.
 *   tier floor   — the POST-selection population. A tier selecting fewer files
 *                  is a policy decision, not corpus loss.
 *
 * They were one check over one input, so both reported "the corpus shrank under
 * the runner". Today prepush/pr/full happen to resolve to the same set, which is
 * what hid the conflation; the moment PR is narrowed, an intended reduction
 * reads as a lost corpus and points at the wrong file.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { SUITE_ROOTS, type SuiteName } from "../../../tools/dev/test-shard-discovery"
import {
  CorpusLostError,
  type ShardSelectionInput,
  selectShardManifest,
  TierSelectionError,
} from "../../../tools/dev/test-shard-selection"
import type { TierPopulationFile } from "../../../tools/dev/test-tier-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * A v3 record in memory; the loader re-derives, `checkTierPopulation` does not.
 * `measured` is what every suite discovered and selected when it was measured.
 */
const recordWith = (
  tiers: Readonly<Record<string, number>>,
  narrow: Readonly<Record<"core" | "unit" | "integration", number>> = {
    core: 1,
    unit: 1,
    integration: 1,
  },
  measured: { readonly discovered: number; readonly selected: number } = {
    discovered: 100,
    selected: 100,
  },
): TierPopulationFile => {
  const row = (minFiles: number) =>
    Object.fromEntries(
      Object.keys(tiers).map((t) => [
        t,
        { selected: measured.selected, minFiles, reason: "fixture" },
      ]),
    )
  return {
    schema: "quanta.test-tier-population.v3",
    tiers: Object.fromEntries(
      Object.entries(tiers).map(([t, minFiles]) => [t, { minFiles, reason: "fixture" }]),
    ),
    suites: {
      measuredAt: "fixture",
      discovered: {
        full: measured.discovered,
        core: measured.discovered,
        unit: measured.discovered,
        integration: measured.discovered,
      },
      universeSelected: Object.fromEntries(Object.keys(tiers).map((t) => [t, measured.selected])),
      floors: {
        core: row(narrow.core),
        unit: row(narrow.unit),
        integration: row(narrow.integration),
      },
    },
  }
}

const floors: TierPopulationFile = recordWith({ pr: 80, full: 80 })

/**
 * Absolute paths spread round-robin over the SUITE's roots, so discovery is
 * complete for that suite: every root yields at least one file.
 */
const files = (count: number, suite: SuiteName = "full"): readonly string[] => {
  const roots = SUITE_ROOTS[suite].map((root) => root.replace(/^\.\//u, "").replace(/\/+$/u, ""))
  return Array.from(
    { length: count },
    (_, index) =>
      `/abs/repo/${roots[index % roots.length]}/f-${String(index).padStart(4, "0")}.test.ts`,
  )
}

const relativeId = (file: string): string => file.replace("/abs/repo/", "")

/** `tracked` follows `discovered` unless an arm says otherwise — a complete checkout. */
const input = (overrides: Partial<ShardSelectionInput> = {}): ShardSelectionInput => {
  const merged = {
    suite: "full" as SuiteName,
    tier: "pr" as string | undefined,
    discovered: files(100),
    idOf: relativeId,
    suiteFloor: 90,
    tierFloors: floors,
    selectForTier: (ids: readonly string[]) => ({ files: ids, policySha256: "d".repeat(64) }),
    ...overrides,
  }
  return {
    ...merged,
    tracked: overrides.tracked ?? merged.discovered.map(merged.idOf),
  }
}

describe("shard manifest selection", () => {
  test("a lost corpus and a narrowed tier are different failures", () => {
    // The discriminating pair. Same shortfall, different cause, and before the
    // split BOTH produced the corpus-loss message.
    const lost = (): unknown => selectShardManifest(input({ discovered: files(50) }))
    expect(lost).toThrow(CorpusLostError)
    expect(lost).toThrow(/corpus shrank under the runner/)

    const narrowed = (): unknown =>
      selectShardManifest(input({ selectForTier: (ids) => ({ files: ids.slice(0, 10) }) }))
    expect(narrowed).toThrow(TierSelectionError)
    expect(narrowed).toThrow(/The SELECTION is the cause/)
    // …and it must NOT claim the corpus is gone, which is the whole point.
    expect(narrowed).not.toThrow(/corpus shrank under the runner|left the CORPUS/)
  })

  test("a corpus loss at a tier that already excludes files is corpus loss", () => {
    // The audit's reproduction, in miniature: measured 100 discovered / 90
    // selected; 12 SELECTED files are deleted in a commit and the policy is
    // untouched. The old rule (`selected === discovered` or it is a narrowing)
    // called this "a SELECTION shrink … lower the floor".
    const measured = recordWith({ pr: 85 }, undefined, { discovered: 100, selected: 90 })
    const everything = files(100)
    const excluded = new Set(everything.slice(0, 10).map(relativeId))
    const kept = everything.slice(0, 10).concat(everything.slice(22))
    const policy = (ids: readonly string[]) => ({ files: ids.filter((id) => !excluded.has(id)) })
    const lost = (): unknown =>
      selectShardManifest(
        input({ discovered: kept, suiteFloor: 1, tierFloors: measured, selectForTier: policy }),
      )
    expect(lost).toThrow(CorpusLostError)
    expect(lost).toThrow(/12 file\(s\) left the CORPUS/)
    // PAIRED CONTROL: the corpus intact, 12 more excluded by policy.
    const moreExcluded = new Set(everything.slice(0, 22).map(relativeId))
    const narrowed = (): unknown =>
      selectShardManifest(
        input({
          suiteFloor: 1,
          tierFloors: measured,
          selectForTier: (ids) => ({ files: ids.filter((id) => !moreExcluded.has(id)) }),
        }),
      )
    expect(narrowed).toThrow(TierSelectionError)
    expect(narrowed).toThrow(/excludes 12 more file\(s\)/)
  })

  test("discovery is complete before any floor: a tracked file not discovered is corpus loss", () => {
    // Far above every floor, and still refused: slack is not the instrument for a
    // file that is tracked and was not found.
    let selectorCalls = 0
    const moved = (): unknown =>
      selectShardManifest(
        input({
          tracked: [...files(100).map(relativeId), "tools/.moved/lost.test.ts"],
          selectForTier: (ids) => {
            selectorCalls += 1
            return { files: ids }
          },
        }),
      )
    expect(moved).toThrow(CorpusLostError)
    expect(moved).toThrow(/tools\/\.moved\/lost\.test\.ts/)
    expect(selectorCalls).toBe(0)
    // A root that yields nothing, even with its files untracked as well.
    const withoutMeta = files(100).filter((file) => !file.includes("/tests/meta/"))
    expect(() => selectShardManifest(input({ discovered: withoutMeta, suiteFloor: 1 }))).toThrow(
      /suite root tests\/meta yielded no test files/,
    )
    // PAIRED CONTROL: an untracked file discovery found is new work.
    expect(() => selectShardManifest(input({ tracked: files(99).map(relativeId) }))).not.toThrow()
  })

  /**
   * ★ WIRING — the floor is chosen HERE, by suite, and only an arm through this
   * function can see it. `checkTierPopulation` is also driven directly in the
   * sibling file, where a mutation at this call site is invisible.
   */
  test("a narrow suite is judged by its own floor through THIS function", () => {
    const record = recordWith(
      { pr: 80 },
      { core: 60, unit: 30, integration: 20 },
      { discovered: 90, selected: 90 },
    )
    // 40 selected clears unit's 30 and fails the universe's 80.
    expect(() =>
      selectShardManifest(
        input({ suite: "unit", discovered: files(40, "unit"), suiteFloor: 1, tierFloors: record }),
      ),
    ).not.toThrow()
    expect(() =>
      selectShardManifest(
        input({ suite: "full", discovered: files(40), suiteFloor: 1, tierFloors: record }),
      ),
    ).toThrow(CorpusLostError)

    // Below its own floor with files gone: corpus loss, for a narrow suite too.
    expect(() =>
      selectShardManifest(
        input({
          suite: "integration",
          discovered: files(10, "integration"),
          suiteFloor: 1,
          tierFloors: record,
        }),
      ),
    ).toThrow(CorpusLostError)

    // Narrowed below its own floor, nothing gone: a selection shrink.
    expect(() =>
      selectShardManifest(
        input({
          suite: "core",
          discovered: files(90, "core"),
          suiteFloor: 1,
          tierFloors: record,
          selectForTier: (ids) => ({ files: ids.slice(0, 50) }),
        }),
      ),
    ).toThrow(TierSelectionError)
  })

  test("the universe is checked BEFORE tier policy runs", () => {
    // With both faults present the verdict must name the universe, because a
    // tier cannot be judged against a corpus that is already gone. Proven by
    // the fact that the tier selector is never even called.
    let selectorCalls = 0
    expect(() =>
      selectShardManifest(
        input({
          discovered: files(50),
          selectForTier: (ids) => {
            selectorCalls += 1
            return { files: ids.slice(0, 1) }
          },
        }),
      ),
    ).toThrow(CorpusLostError)
    expect(selectorCalls).toBe(0)
  })

  test("a universe below the TIER floor with no narrowing is corpus loss, not selection", () => {
    // The audit finding. `SUITE_FLOORS.full` is 3,600 and the tier floor is
    // 3,900, so a corpus that lost 100 files lands in the band between them: the
    // suite floor does not reach it, and the tier check used to print "this is a
    // SELECTION shrink, not corpus loss" while `selected === discovered` — i.e.
    // while nothing had been narrowed at all. Exactly the mis-attribution the
    // split exists to remove, pointing the other way.
    const whole = files(85)
    const thrown = ((): Error => {
      try {
        selectShardManifest(
          input({
            discovered: whole,
            suiteFloor: 80,
            tierFloors: recordWith({ pr: 90 }),
            selectForTier: (ids) => ({ files: ids }),
          }),
        )
        throw new Error("expected a throw")
      } catch (error) {
        return error as Error
      }
    })()
    expect(thrown).toBeInstanceOf(CorpusLostError)
    expect(thrown.message).toContain("15 file(s) left the CORPUS")
    expect(thrown.message).not.toContain("did not shrink")
  })

  test("an empty tier selection is named as an empty selection", () => {
    expect(() => selectShardManifest(input({ selectForTier: () => ({ files: [] }) }))).toThrow(
      /selected zero of 100/,
    )
  })

  test("a tier with no committed floor fails closed rather than defaulting", () => {
    expect(() => selectShardManifest(input({ tier: "nightly" }))).toThrow(
      /no committed population floor/,
    )
  })

  test("the manifest keeps the discovered spelling, not the policy id", () => {
    // The bridge that a first draft got wrong: the runner hands ABSOLUTE paths
    // because the planner buckets on them and re-relativises them itself, while
    // tier policy is keyed on repo-relative ids. Normalising here would have
    // silently handed the planner paths it relativised a second time.
    const selection = selectShardManifest(
      input({ selectForTier: (ids) => ({ files: ids.slice(0, 90) }) }),
    )
    expect(selection.manifest.length).toBe(90)
    for (const file of selection.manifest) expect(file.startsWith("/abs/repo/")).toBe(true)
    // Discovery ORDER is preserved, because chunk identity derives from it.
    expect(selection.manifest).toEqual(selection.discovered.slice(0, 90))
  })

  test("selection cannot exceed discovery even if the policy layer says so", () => {
    expect(() =>
      selectShardManifest(
        input({
          selectForTier: (ids) => ({ files: [...ids, "tests/unit/ghost.test.ts"] }),
        }),
      ),
    ).not.toThrow()
    // A policy id that is not in the universe simply does not appear — the
    // manifest is filtered FROM discovery, so it can never invent a file.
    const selection = selectShardManifest(
      input({ selectForTier: (ids) => ({ files: [...ids, "tests/unit/ghost.test.ts"] }) }),
    )
    expect(selection.manifest.length).toBe(100)
    expect(selection.manifest.some((file) => file.includes("ghost"))).toBe(false)
  })

  test("no tier means no tier check, and the manifest is the universe", () => {
    let selectorCalls = 0
    const selection = selectShardManifest(
      input({
        tier: undefined,
        selectForTier: (ids) => {
          selectorCalls += 1
          return { files: ids }
        },
      }),
    )
    expect(selection.manifest).toEqual(selection.discovered)
    expect(selectorCalls).toBe(0)
  })

  test("a universe exactly at the floor passes; one below does not", () => {
    expect(() => selectShardManifest(input({ discovered: files(90) }))).not.toThrow()
    expect(() => selectShardManifest(input({ discovered: files(89) }))).toThrow(CorpusLostError)
  })

  test("WIRING — the runner delegates to this selector and nothing else", () => {
    // A correct selector beside a runner that still inlines its own checks is
    // exactly the inert-surface shape this file exists to close.
    const source = readFileSync(join(REPO_ROOT, "tools", "dev", "run-test-shards.ts"), "utf8")
    expect(source).toContain("selectShardManifest({")
    // The old inline comparison must not survive anywhere in the runner.
    expect(source).not.toContain("SUITE_FLOORS[opts.suite]\n    if (manifest.length")
    expect(source).not.toContain("checkTierPopulation(")

    // STRUCTURE, not markers. The previous arm checked that the text
    // `suiteFloor:` existed, which `suiteFloor: SUITE_FLOORS.integration` —
    // every suite judged against integration's 330 — also satisfies. Every call
    // to `selectShardManifest` in the runner (the campaign AND `--discover-only`)
    // must pass these exact expressions.
    const tree = ts.createSourceFile(
      "run-test-shards.ts",
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )
    const calls: ts.CallExpression[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "selectShardManifest"
      ) {
        calls.push(node)
      }
      node.forEachChild(walk)
    }
    walk(tree)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const argument = call.arguments[0]
      if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
        throw new Error("selectShardManifest is not called with an object literal")
      }
      const value = (name: string): string => {
        const property = argument.properties.find(
          (one): one is ts.PropertyAssignment =>
            ts.isPropertyAssignment(one) && ts.isIdentifier(one.name) && one.name.text === name,
        )
        return property === undefined ? "<absent>" : property.initializer.getText(tree)
      }
      const line = tree.getLineAndCharacterOfPosition(call.getStart(tree)).line + 1
      expect({
        line,
        suite: value("suite"),
        suiteFloor: value("suiteFloor"),
        tierFloors: value("tierFloors"),
        tracked: value("tracked"),
      }).toEqual({
        line,
        suite: "opts.suite",
        suiteFloor: "SUITE_FLOORS[opts.suite]",
        tierFloors: "loadTierPopulationFloors()",
        tracked: "trackedSuiteTestFiles(REPO_ROOT, opts.suite)",
      })
      expect(value("selectForTier")).toContain("tierSelectionFromPolicy(")
    }
  })

  test("WIRING — the runner snapshots the tree BEFORE it selects", () => {
    // Taken after, a commit landing during discovery or policy resolution was in
    // both snapshots and the "checkout moved" comparison passed over a manifest
    // that missed the commit's files.
    const source = readFileSync(join(REPO_ROOT, "tools", "dev", "run-test-shards.ts"), "utf8")
    const tree = ts.createSourceFile(
      "run-test-shards.ts",
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )
    const declarationOf = (name: string): ts.VariableStatement[] => {
      const found: ts.VariableStatement[] = []
      const walk = (node: ts.Node): void => {
        if (
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some(
            (one) => ts.isIdentifier(one.name) && one.name.text === name,
          )
        ) {
          found.push(node)
        }
        node.forEachChild(walk)
      }
      walk(tree)
      return found
    }
    const [snapshot] = declarationOf("selectedAt")
    const [selection] = declarationOf("selection").filter((one) =>
      one.getText(tree).includes("selectManifest(opts)"),
    )
    if (snapshot === undefined || selection === undefined) {
      throw new Error("main no longer declares selectedAt / selection")
    }
    expect(snapshot.getText(tree)).toContain("await gitSnapshot()")
    expect(snapshot.parent).toBe(selection.parent)
    const block = snapshot.parent as ts.Block
    expect(block.statements.indexOf(snapshot)).toBeLessThan(block.statements.indexOf(selection))
  })
})

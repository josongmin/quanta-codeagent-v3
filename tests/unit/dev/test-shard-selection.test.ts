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

import {
  CorpusLostError,
  type ShardSelectionInput,
  selectShardManifest,
  TierSelectionError,
} from "../../../tools/dev/test-shard-selection"
import type { TierPopulationFile } from "../../../tools/dev/test-tier-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

const floors: TierPopulationFile = {
  schema: "quanta.test-tier-population.v1",
  tiers: { pr: { minFiles: 80, reason: "fixture" }, full: { minFiles: 80, reason: "fixture" } },
}

const files = (count: number, prefix = "/abs/repo/tests/unit"): readonly string[] =>
  Array.from(
    { length: count },
    (_, index) => `${prefix}/f-${String(index).padStart(4, "0")}.test.ts`,
  )

const input = (overrides: Partial<ShardSelectionInput> = {}): ShardSelectionInput => ({
  suite: "full",
  tier: "pr",
  discovered: files(100),
  idOf: (file) => file.replace("/abs/repo/", ""),
  suiteFloor: 90,
  tierFloors: floors,
  selectForTier: (ids) => ({ files: ids, policySha256: "d".repeat(64) }),
  ...overrides,
})

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
    expect(narrowed).toThrow(/SELECTION shrink, not corpus loss/)
    // …and it must NOT claim the corpus is gone, which is the whole point.
    expect(narrowed).not.toThrow(/corpus shrank under the runner/)
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

    // ANTI-VACUITY: the runner must still pass the pieces that make the split
    // meaningful — the absolute discovery, the id bridge, and both floors.
    for (const marker of ["idOf:", "suiteFloor:", "tierFloors:", "selectForTier:"]) {
      expect({ marker, present: source.includes(marker) }).toEqual({ marker, present: true })
    }
  })
})

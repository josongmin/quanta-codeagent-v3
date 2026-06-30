/**
 * Strategy tool #7 — multi-location-set fanout. Hard scenarios:
 *  - rotation correctness (lead cycles through ranked files)
 *  - INFO PRESERVATION invariant (related always = every other file, in order)
 *  - no-diversity fallback (<2 files ⇒ [] ⇒ base seed, byte-identical)
 *  - n wrapping (more candidates than files reuses locations) + n<1 guard
 *  - whitespace/empty filtering
 *  - determinism (pure)
 *  - seeder composition: appends hint, wraps index, undefined base, no-diversity ⇒ undefined
 *  - red-on-injection: a hint that dropped a related file would fail the invariant
 */

import { describe, expect, test } from "bun:test"
import {
  buildRepairFanoutFiles,
  buildRepairFanoutSymbols,
  buildLocationSeeder,
  type LocationSet,
  partitionLocationSets,
  partitionSymbolSets,
  renderLocationHint,
} from "../../src/runner/batch/eval/location-set-fanout"

const F = ["a.py", "b.py", "c.py"]

describe("partitionLocationSets — rotation + info preservation", () => {
  test("lead rotates through the ranked files; related = every OTHER file in order", () => {
    const sets = partitionLocationSets(F, 3)
    expect(sets.map((s) => s.lead)).toEqual(["a.py", "b.py", "c.py"])
    expect(sets[0]).toEqual({ lead: "a.py", related: ["b.py", "c.py"] })
    expect(sets[1]).toEqual({ lead: "b.py", related: ["a.py", "c.py"] })
    expect(sets[2]).toEqual({ lead: "c.py", related: ["a.py", "b.py"] })
  })

  test("INVARIANT: lead + related is exactly the full file set for every candidate (no file hidden)", () => {
    const sets = partitionLocationSets(F, 5)
    for (const s of sets) {
      expect(new Set([s.lead, ...s.related])).toEqual(new Set(F))
      expect(s.related).not.toContain(s.lead) // lead is not duplicated in related
      expect(s.related.length).toBe(F.length - 1)
    }
  })

  test("n WRAPS when it exceeds the file count (location reuse, Agentless-faithful)", () => {
    const sets = partitionLocationSets(["x", "y"], 5)
    expect(sets.map((s) => s.lead)).toEqual(["x", "y", "x", "y", "x"])
  })

  test("no diversity to inject ⇒ [] (caller falls back to base seed)", () => {
    expect(partitionLocationSets([], 4)).toEqual([])
    expect(partitionLocationSets(["only.py"], 4)).toEqual([]) // single file ⇒ identical sets ⇒ none
    expect(partitionLocationSets(F, 0)).toEqual([]) // n<1
    expect(partitionLocationSets(F, -3)).toEqual([])
  })

  test("blank/whitespace entries are filtered before partitioning", () => {
    const sets = partitionLocationSets(["", "  ", "real.py", "two.py"], 2)
    expect(sets.map((s) => s.lead)).toEqual(["real.py", "two.py"])
    expect(sets[0]?.related).toEqual(["two.py"])
  })

  test("deterministic: identical inputs ⇒ identical output", () => {
    expect(partitionLocationSets(F, 4)).toEqual(partitionLocationSets(F, 4))
  })
})

describe("renderLocationHint", () => {
  test("names the lead as primary and lists EVERY related file (red-on-injection)", () => {
    const set: LocationSet = { lead: "core/mod.py", related: ["util/a.py", "util/b.py"] }
    const hint = renderLocationHint(set)
    expect(hint).toContain("core/mod.py")
    expect(hint).toContain("util/a.py")
    expect(hint).toContain("util/b.py")
    expect(hint).toContain("location-focus")
  })

  test("single-file related ⇒ '(none)' rather than empty", () => {
    expect(renderLocationHint({ lead: "x.py", related: [] })).toContain("(none)")
  })
})

describe("buildLocationSeeder — the perCandidateSeed seam", () => {
  test("appends the index's location hint to the base seed", () => {
    const seed = buildLocationSeeder(F, 3)
    expect(seed).toBeDefined()
    const s0 = seed?.(0, "BASE-SEED")
    expect(s0).toContain("BASE-SEED")
    expect(s0).toContain("a.py") // candidate 0 leads with a.py
    const s1 = seed?.(1, "BASE-SEED")
    expect(s1).toContain("b.py")
    expect(s0).not.toBe(s1) // distinct candidates get distinct seeds
  })

  test("index WRAPS over the location sets", () => {
    const seed = buildLocationSeeder(["x", "y"], 2)
    expect(seed?.(0, "B")).toBe(seed?.(2, "B")) // wraps: 2 % 2 === 0
    expect(seed?.(1, "B")).toBe(seed?.(3, "B"))
  })

  test("undefined base seed ⇒ hint only (no 'undefined' string leak)", () => {
    const seed = buildLocationSeeder(F, 2)
    const s = seed?.(0, undefined)
    expect(s).toContain("a.py")
    expect(s).not.toContain("undefined")
  })

  test("no location diversity ⇒ undefined seeder (driver leaves perCandidateSeed unset ⇒ byte-identical)", () => {
    expect(buildLocationSeeder(["solo.py"], 4)).toBeUndefined() // 1 file, no symbols
    expect(buildLocationSeeder([], 4)).toBeUndefined()
    expect(buildLocationSeeder(F, 0)).toBeUndefined()
  })
})

describe("buildRepairFanoutFiles — widened owner surface feeds repair breadth", () => {
  test("preserves stage1/localize rank order, then appends ownerResolved + witness owners", () => {
    expect(
      buildRepairFanoutFiles({
        localizeCandidates: ["base.py"],
        stage1Files: [{ file: "base.py" }, { file: "consumer.py" }],
        ownerResolved: [{ file: "sibling.py" }],
        witnessOwners: [{ file: "witness.py" }],
      }),
    ).toEqual(["base.py", "consumer.py", "sibling.py", "witness.py"])
  })

  test("dedupes overlaps and falls back to raw localizeCandidates when stage1 files are absent", () => {
    expect(
      buildRepairFanoutFiles({
        localizeCandidates: ["base.py", "consumer.py", "base.py"],
        ownerResolved: [{ file: "consumer.py" }, { file: "sibling.py" }],
        witnessOwners: [{ file: "sibling.py" }, { file: "  " }],
      }),
    ).toEqual(["base.py", "consumer.py", "sibling.py"])
  })

  test("dedupes path-normalized duplicates so breadth slots are not wasted on './x' vs 'x'", () => {
    expect(
      buildRepairFanoutFiles({
        localizeCandidates: ["./pkg/base.py"],
        ownerResolved: [{ file: "pkg/base.py" }, { file: "/pkg/consumer.py" }],
        witnessOwners: [{ file: "pkg/consumer.py" }, { file: "pkg/extra.py" }],
      }),
    ).toEqual(["./pkg/base.py", "/pkg/consumer.py", "pkg/extra.py"])
  })

  test("single localize hit + widened owners becomes a REAL multi-file fanout surface", () => {
    const files = buildRepairFanoutFiles({
      localizeCandidates: ["urls.py"],
      ownerResolved: [{ file: "utils.py" }, { file: "config.py" }],
    })
    const seed = buildLocationSeeder(files, 3)
    expect(seed).toBeDefined()
    expect(seed?.(0, "BASE")).toContain("urls.py")
    expect(seed?.(1, "BASE")).toContain("utils.py")
    expect(seed?.(2, "BASE")).toContain("config.py")
  })
})

describe("buildRepairFanoutSymbols — widened symbol surface feeds single-file fanout", () => {
  test("single-file fanout includes ownerResolved/witness symbols on that same file", () => {
    expect(
      buildRepairFanoutSymbols({
        issueSymbols: [],
        fanoutFiles: ["pkg/core.py"],
        ownerResolved: [{ file: "pkg/core.py", forSymbol: "render" }],
        witnessOwners: [
          { file: "pkg/core.py", forSymbol: "parse" },
          { file: "pkg/other.py", forSymbol: "ignore_me" },
        ],
      }),
    ).toEqual(["render", "parse"])
  })

  test("multi-file fanout keeps only the issue-symbol channel (file rotation already handles diversity)", () => {
    expect(
      buildRepairFanoutSymbols({
        issueSymbols: ["from_issue"],
        fanoutFiles: ["a.py", "b.py"],
        ownerResolved: [{ file: "a.py", forSymbol: "render" }],
        witnessOwners: [{ file: "b.py", forSymbol: "parse" }],
      }),
    ).toEqual(["from_issue"])
  })

  test("single localized file + owner symbols makes symbol rotation non-inert even without issue symbols", () => {
    const files = buildRepairFanoutFiles({ localizeCandidates: ["pkg/core.py"] })
    const symbols = buildRepairFanoutSymbols({
      issueSymbols: [],
      fanoutFiles: files,
      ownerResolved: [
        { file: "pkg/core.py", forSymbol: "render" },
        { file: "pkg/core.py", forSymbol: "parse" },
      ],
    })
    const seed = buildLocationSeeder(files, 2, symbols)
    expect(seed).toBeDefined()
    expect(seed?.(0, "BASE")).toContain("render")
    expect(seed?.(1, "BASE")).toContain("parse")
  })
})

describe("partitionSymbolSets — single-file symbol granularity (Agentless function-level parity)", () => {
  test("rotates the lead symbol within the file; others kept as context", () => {
    const sets = partitionSymbolSets("m.py", ["foo", "bar", "baz"], 3)
    expect(sets.map((s) => s.lead)).toEqual(["foo", "bar", "baz"])
    expect(sets.every((s) => s.file === "m.py")).toBe(true)
    expect(sets[0]).toEqual({ file: "m.py", lead: "foo", otherSymbols: ["bar", "baz"] })
  })

  test("nothing to diversify ⇒ [] (<2 symbols / no file)", () => {
    expect(partitionSymbolSets("m.py", ["only"], 4)).toEqual([])
    expect(partitionSymbolSets("", ["a", "b"], 4)).toEqual([])
    expect(partitionSymbolSets("m.py", ["a", "b"], 0)).toEqual([])
  })
})

describe("buildLocationSeeder — single-file FALLS BACK to symbol rotation (fanout not inert)", () => {
  test("1 file + ≥2 issue symbols ⇒ symbol-leading seeds (was inert before)", () => {
    const seed = buildLocationSeeder(["only.py"], 3, ["parse", "render", "emit"])
    expect(seed).toBeDefined()
    const s0 = seed?.(0, "BASE")
    const s1 = seed?.(1, "BASE")
    expect(s0).toContain("only.py")
    expect(s0).toContain("parse") // candidate 0 leads with the first symbol
    expect(s1).toContain("render")
    expect(s0).not.toBe(s1)
  })

  test("≥2 files takes precedence over symbols (file-level diversity is coarser/preferred)", () => {
    const seed = buildLocationSeeder(["a.py", "b.py"], 2, ["sym1", "sym2"])
    expect(seed?.(0, "B")).toContain("a.py")
    expect(seed?.(0, "B")).not.toContain("sym1") // file mode, not symbol mode
  })

  test("1 file + <2 symbols ⇒ still undefined (genuinely no diversity)", () => {
    expect(buildLocationSeeder(["solo.py"], 4, ["one"])).toBeUndefined()
    expect(buildLocationSeeder(["solo.py"], 4, [])).toBeUndefined()
  })
})

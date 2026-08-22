// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
import { describe, expect, test } from "bun:test"
import {
  type DiffFile,
  isExemptFromFc,
  mergeDiffSources,
  parseDiffNameStatus,
  parseUntrackedFiles,
  runCheckChanged,
} from "../../tools/feature-catalog/check-changed"
import type { Feature, LoadedFeature } from "../../tools/feature-catalog/schema"

function feature(code: readonly string[]): Feature {
  return {
    id: "x",
    title: "x",
    section: 1,
    subsystem: "x",
    order: 0,
    maturity: "L4",
    status: "stable",
    owners: [],
    labels: [],
    depends_on: [],
    lifecycle_stage: "active",
    supersedes: [],
    ui_surfaces: [],
    monitoring: "n-a",
    modes: [],
    configurable: "n-a",
    telemetry_keys: [],
    config_refs: {},
    surface_integration: { cli: "unknown", web: "unknown", evidence: {}, method: "unverified" },
    purpose: "x",
    evidence: { code: code.slice(), adrs: [], tests: { unit: [], integration: [], contract: [] } },
    knobs: [],
    deliberate_hold: null,
  }
}

const f = (code: readonly string[]): LoadedFeature => ({ feature: feature(code), path: "x.yaml" })

describe("isExemptFromFc", () => {
  test("test files are exempt", () => {
    expect(isExemptFromFc("tests/unit/foo.test.ts")).toBe(true)
    expect(isExemptFromFc("src/foo.test.ts")).toBe(true)
    expect(isExemptFromFc("src/foo.spec.ts")).toBe(true)
  })
  test("barrel index.ts is exempt", () => {
    expect(isExemptFromFc("src/foo/index.ts")).toBe(true)
  })
  test("d.ts files are exempt", () => {
    expect(isExemptFromFc("src/foo.d.ts")).toBe(true)
  })
  test("docs / scripts / worktrees / fc-tool itself are exempt", () => {
    expect(isExemptFromFc("docs/foo.md")).toBe(true)
    expect(isExemptFromFc("scripts/foo.ts")).toBe(true)
    expect(isExemptFromFc(".claude/worktrees/agent-abc/src/foo.ts")).toBe(true)
    expect(isExemptFromFc("tools/feature-catalog/audit.ts")).toBe(true)
  })
  test("non-.ts files are exempt (covered by extension check)", () => {
    expect(isExemptFromFc("src/foo.json")).toBe(true)
    expect(isExemptFromFc("README.md")).toBe(true)
  })
  test("regular src/.ts files are NOT exempt", () => {
    expect(isExemptFromFc("src/agent/loop.ts")).toBe(false)
    expect(isExemptFromFc("src/tool/edit/exact.ts")).toBe(false)
  })
})

describe("runCheckChanged", () => {
  test("ADDED src file referenced in fc passes", () => {
    const diff: DiffFile[] = [{ path: "src/foo.ts", status: "A" }]
    const result = runCheckChanged(diff, [f(["src/foo.ts"])])
    expect(result.ok).toBe(true)
    expect(result.addedUntracked).toEqual([])
  })

  test("ADDED src file NOT in fc blocks", () => {
    const diff: DiffFile[] = [{ path: "src/foo.ts", status: "A" }]
    const result = runCheckChanged(diff, [f(["src/other.ts"])])
    expect(result.ok).toBe(false)
    expect(result.addedUntracked).toEqual(["src/foo.ts"])
  })

  test("MODIFIED src file NOT in fc warns but does NOT block", () => {
    const diff: DiffFile[] = [{ path: "src/foo.ts", status: "M" }]
    const result = runCheckChanged(diff, [])
    expect(result.ok).toBe(true)
    expect(result.modifiedUntracked).toEqual(["src/foo.ts"])
    expect(result.addedUntracked).toEqual([])
  })

  test("test files are skipped entirely (not added/modified untracked)", () => {
    const diff: DiffFile[] = [
      { path: "tests/unit/foo.test.ts", status: "A" },
      { path: "src/foo.test.ts", status: "A" },
    ]
    const result = runCheckChanged(diff, [])
    expect(result.ok).toBe(true)
    expect(result.addedUntracked).toEqual([])
    expect(result.modifiedUntracked).toEqual([])
  })

  test("multiple ADD violations are all reported", () => {
    const diff: DiffFile[] = [
      { path: "src/a.ts", status: "A" },
      { path: "src/b.ts", status: "A" },
      { path: "src/c.ts", status: "A" },
    ]
    const result = runCheckChanged(diff, [f(["src/b.ts"])])
    expect(result.ok).toBe(false)
    expect(result.addedUntracked).toEqual(["src/a.ts", "src/c.ts"])
  })

  test("Deletions and renames don't block (status A is the only blocker)", () => {
    const diff: DiffFile[] = [
      { path: "src/old.ts", status: "D" },
      { path: "src/renamed.ts", status: "R" },
    ]
    const result = runCheckChanged(diff, [])
    expect(result.ok).toBe(true)
  })
})

describe("parseDiffNameStatus", () => {
  test("parses A / M / D lines", () => {
    const out = parseDiffNameStatus("A\tsrc/a.ts\nM\tsrc/b.ts\nD\tsrc/c.ts\n")
    expect(out).toEqual([
      { path: "src/a.ts", status: "A" },
      { path: "src/b.ts", status: "M" },
      { path: "src/c.ts", status: "D" },
    ])
  })

  test("parses rename — uses destination path", () => {
    const out = parseDiffNameStatus("R100\tsrc/old.ts\tsrc/new.ts\n")
    expect(out).toEqual([{ path: "src/new.ts", status: "R" }])
  })

  test("ignores blank lines", () => {
    const out = parseDiffNameStatus("A\tsrc/a.ts\n\n\nM\tsrc/b.ts\n")
    expect(out.length).toBe(2)
  })

  test("ignores unknown status codes", () => {
    const out = parseDiffNameStatus("X\tsrc/x.ts\n")
    expect(out).toEqual([])
  })
})

/**
 * aug-22 audit — the gate's BLIND SPOT.
 *
 * `cmdCheckChanged` asked git for `diff <base>...HEAD`, which sees committed
 * history only. Two whole categories of "new src file" were therefore invisible
 * to the gate a developer runs before committing:
 *
 *  - UNTRACKED files (the file exists, is not in the index, and is exactly the
 *    "new standalone file" this gate's docstring says is where features hide);
 *  - files already merged into the base ref, whose fc entry was never written —
 *    once the branch lands, `base...HEAD` is empty and the gate reports ok.
 *
 * Measured on the aug-21/22 bench campaign: `bun fc check-changed` printed ok
 * while 99 added `src/` files carried no fc evidence at all; re-running it
 * against the pre-campaign base surfaced all of them. The gate was not wrong
 * about its inputs — it was asking git the wrong question.
 *
 * The repair keeps the pure decision layer untouched and widens the INPUT: the
 * working tree is merged into the committed diff. In CI (clean checkout) the
 * union is identical to the committed diff, so this is a no-op there and a
 * fail-closed improvement locally.
 */
describe("parseUntrackedFiles", () => {
  test("every untracked path is an ADDED file", () => {
    expect(parseUntrackedFiles("src/a.ts\nsrc/nested/b.ts\n")).toEqual([
      { path: "src/a.ts", status: "A" },
      { path: "src/nested/b.ts", status: "A" },
    ])
  })

  test("blank lines are ignored and paths with spaces survive intact", () => {
    expect(parseUntrackedFiles("\nsrc/my file.ts\n\n")).toEqual([
      { path: "src/my file.ts", status: "A" },
    ])
  })
})

describe("mergeDiffSources", () => {
  test("union of committed diff and working tree", () => {
    const merged = mergeDiffSources(
      [{ path: "src/a.ts", status: "M" }],
      [{ path: "src/b.ts", status: "A" }],
    )
    expect(merged).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "A" },
    ])
  })

  test("ADDED wins over MODIFIED for the same path — a new file edited again is still new", () => {
    const merged = mergeDiffSources(
      [{ path: "src/a.ts", status: "A" }],
      [{ path: "src/a.ts", status: "M" }],
    )
    expect(merged).toEqual([{ path: "src/a.ts", status: "A" }])
    // …and in the other argument order, so the result cannot depend on which
    // git command happened to run first.
    expect(
      mergeDiffSources([{ path: "src/a.ts", status: "M" }], [{ path: "src/a.ts", status: "A" }]),
    ).toEqual([{ path: "src/a.ts", status: "A" }])
  })

  test("no duplicates — one path appears once however many sources report it", () => {
    const merged = mergeDiffSources(
      [{ path: "src/a.ts", status: "M" }],
      [{ path: "src/a.ts", status: "M" }],
      [{ path: "src/a.ts", status: "M" }],
    )
    expect(merged).toEqual([{ path: "src/a.ts", status: "M" }])
  })

  test("END TO END — an untracked src file BLOCKS once the working tree is merged in", () => {
    const committed = parseDiffNameStatus("M\tsrc/known.ts\n")
    const untracked = parseUntrackedFiles("src/brand-new.ts\n")

    // The old input (committed only) reported ok — the blind spot, verbatim.
    expect(runCheckChanged(committed, [f(["src/known.ts"])]).ok).toBe(true)

    // The widened input blocks on exactly the file that was invisible.
    const widened = runCheckChanged(mergeDiffSources(committed, untracked), [f(["src/known.ts"])])
    expect(widened.ok).toBe(false)
    expect(widened.addedUntracked).toEqual(["src/brand-new.ts"])
  })
})

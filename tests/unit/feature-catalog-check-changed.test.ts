// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  type DiffFile,
  isExemptFromFc,
  mergeDiffSources,
  parseDiffNameStatus,
  parseUntrackedFiles,
  runCheckChanged,
} from "../../tools/feature-catalog/check-changed"
import { checkChangedBase } from "../../tools/feature-catalog/cli"
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
  test("tools/ is NOT exempt — including tools/dev, whose exemption's premise went false", () => {
    // This test used to assert `tools/dev/**` WAS exempt, and cited the reason the
    // source gave: "no `tools/dev/` file has ever been in fc evidence". That stopped
    // being true while both the exemption and this assertion sat unchanged —
    // measured 51 of 102 tracked `tools/dev/*.ts` are referenced by `evidence.code`,
    // most of it enrolled by the sep-9/sep-12 verification campaigns. So the test was
    // pinning a premise, not a contract, and the pin is what kept the premise alive.
    //
    // No bulk enrolment follows: `runCheckChanged` blocks on ADDED and only reports
    // MODIFIED, so the 51 uncatalogued files stay quiet and only a NEW one must say
    // what it is.
    expect(isExemptFromFc("tools/dev/cwd-parity-check.ts")).toBe(false)
    expect(isExemptFromFc("tools/dev/typecheck.ts")).toBe(false)
    expect(isExemptFromFc("tools/pm/check.ts")).toBe(false)
    expect(isExemptFromFc("tools/god-code/detect.ts")).toBe(false)
    expect(isExemptFromFc("tools/arch-gen/main.ts")).toBe(false)
    // Paired control — the exemptions that remain, and why each is narrow.
    // `tools/feature-catalog/**` is the gate's own implementation; the trajectory
    // timeline renders recorded bench cassettes for debugging.
    expect(isExemptFromFc("tools/feature-catalog/audit.ts")).toBe(true)
    expect(isExemptFromFc("tools/trajectory-timeline.ts")).toBe(true)
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

/**
 * TVH item 12 — the campaign froze a base and handed the child nothing.
 *
 * `cmdCheckChanged` read the mutable `origin/main` ref on every invocation. The
 * campaign wrapper freezes a base OID and records it in its receipt, but never
 * passed it down — so a `git fetch` landing mid-campaign changed what this gate
 * compared against while the receipt still named the base as of the start. The
 * receipt described a comparison that did not happen.
 */
describe("the comparison base is the one the campaign froze", () => {
  const OID = "a".repeat(40)

  test("an explicit argument always wins", () => {
    // An operator asking about a specific base is not overridden by an ambient
    // one — otherwise `bun fc check-changed some-branch` would silently answer
    // about something else inside a campaign.
    expect(checkChangedBase(["feature/x"], { QUANTA_VERIFICATION_BASE_OID: OID })).toBe("feature/x")
  })

  test("the frozen OID is used when no argument is given", () => {
    expect(checkChangedBase([], { QUANTA_VERIFICATION_BASE_OID: OID })).toBe(OID)
  })

  test("a NON-main base survives the handoff", () => {
    // A PR against a release branch freezes that branch's OID. Nothing here may
    // quietly substitute `origin/main`, which is what a hardcoded default does
    // to every stacked or release-targeted PR.
    const releaseOid = "b".repeat(40)
    expect(checkChangedBase([], { QUANTA_VERIFICATION_BASE_OID: releaseOid })).toBe(releaseOid)
    expect(checkChangedBase([], { QUANTA_VERIFICATION_BASE_OID: releaseOid })).not.toBe(
      "origin/main",
    )
  })

  test("the campaign's <absent> sentinel is not treated as a ref", () => {
    // `<absent>` is how the campaign records "there is no origin/main in this
    // checkout". Handing it to git turns a missing remote into `fatal: bad
    // revision` in the middle of a gate.
    expect(checkChangedBase([], { QUANTA_VERIFICATION_BASE_OID: "<absent>" })).toBe("origin/main")
    for (const junk of ["", "origin/main", "not-a-sha", "A".repeat(40), "a".repeat(39)]) {
      expect({ junk, base: checkChangedBase([], { QUANTA_VERIFICATION_BASE_OID: junk }) }).toEqual({
        junk,
        base: "origin/main",
      })
    }
  })

  test("with nothing set at all it still has a base", () => {
    // ANTI-VACUITY: a resolver that returned undefined would satisfy the arms
    // above and break every local invocation.
    expect(checkChangedBase([], {})).toBe("origin/main")
  })

  test("WIRING — the campaign exports the frozen base and reports it moving", () => {
    const campaign = readFileSync(
      resolve(import.meta.dir, "..", "..", "tools", "dev", "verification-campaign.ts"),
      "utf8",
    )
    expect(campaign).toContain("VERIFICATION_BASE_OID_ENV")
    expect(campaign).toContain("campaignBaseOid === null ? {} :")
    // A base that moved while the campaign waited is printed, not swallowed:
    // it changes which files a diff-scoped gate looks at. Asserted as the live
    // COMPARISON, not the message: a mutant that wrapped the report in
    // `if (false)` left the string in place and this arm green.
    expect(campaign).toContain("if (queuedBaseOid !== campaignBaseOid) {")
    expect(campaign).toContain("BASE MOVED while waiting for the lease")
    const cli = readFileSync(
      resolve(import.meta.dir, "..", "..", "tools", "feature-catalog", "cli.ts"),
      "utf8",
    )
    expect(cli).toContain("checkChangedBase(argv, process.env)")
    expect(cli).not.toContain('const base = argv[0] ?? "origin/main"')
  })
})

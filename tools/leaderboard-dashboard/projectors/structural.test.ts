/**
 * BFND-03 structural rails.
 *
 * These guard the SHAPE of the dashboard after the extraction: suite knowledge
 * lives in `projectors/`, family-view knowledge lives in the one UI registry, and
 * the official metric formula lives in the report builder — nowhere else.
 *
 * Every detector below carries a NON-VACUITY self-check: the same matcher is run
 * against a synthetic snippet that MUST trip it and one that must not, so a
 * silently-broken regex cannot make the rail pass by matching nothing.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const DASHBOARD = join(import.meta.dir, "..")
const PROJECTORS = import.meta.dir

const read = (rel: string): string => readFileSync(join(DASHBOARD, rel), "utf8")

/** Every non-test .ts under the dashboard tree, repo-relative-ish. */
const walk = (dir: string, out: { path: string; text: string }[] = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push({ path: p.slice(DASHBOARD.length + 1), text: readFileSync(p, "utf8") })
    }
  }
  return out
}

/** Strip line- and block-comments so a rail keys on CODE, never on prose. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")

// ---------------------------------------------------------------------------
// Rail 1 — server.ts must not branch on a suite identity.
// ---------------------------------------------------------------------------

/** A literal suite/family comparison, an entry in a label/order map, or a regex
 *  sniff — the three shapes the pre-BFND-03 server.ts actually used. */
const SUITE_BRANCH =
  /(===\s*["'](?:terminal-bench|promax)["'])|(["'](?:terminal-bench|promax)["']\s*[:,\]])|(\[\s*["'](?:terminal-bench|promax)["'])|(\/terminal-bench\/)/

/** The page SHELL — the two files that are supposed to know no suite at all.
 *  `page.ts` holds the HTML/client shell that used to live inside server.ts, so
 *  the rails below must cover BOTH or the extraction would have laundered them. */
const SHELL_FILES = ["server.ts", "page.ts", "page-family-cards.ts"] as const

describe("rail: the page shell branches on no suite identity", () => {
  test("the detector actually detects (non-vacuity)", () => {
    expect(SUITE_BRANCH.test('if (BENCH === "terminal-bench") return renderTbCards();')).toBe(true)
    expect(SUITE_BRANCH.test('const order = ["verified", "pro", "live", "terminal-bench"]')).toBe(
      true,
    )
    expect(SUITE_BRANCH.test('  "terminal-bench": "Terminal-Bench",')).toBe(true)
    expect(SUITE_BRANCH.test("if (/terminal-bench/.test(name)) {")).toBe(true)
    expect(SUITE_BRANCH.test('if (fam === "promax") return null;')).toBe(true)
    expect(SUITE_BRANCH.test("const views = benchmarkViewsOf(seen)")).toBe(false)
  })

  test("no shell file contains a terminal-bench / promax branch", () => {
    for (const file of SHELL_FILES) {
      const offenders = stripComments(read(file))
        .split("\n")
        .map((line, i) => ({ file, line: line.trim(), n: i + 1 }))
        .filter((row) => SUITE_BRANCH.test(row.line))
      expect(offenders).toEqual([])
    }
  })

  test("no shell file mentions `promax` at all (not even in prose)", () => {
    for (const file of SHELL_FILES) expect(read(file)).not.toContain("promax")
  })

  test("the shell owns no suite LABEL (the terminal-as-family carrier)", () => {
    // Non-vacuity: the label really exists — it just lives in the suite's own
    // projector, which is the whole point of the extraction.
    expect(read(join("projectors", "terminal-bench.ts"))).toContain("Terminal-Bench")
    for (const file of SHELL_FILES) expect(read(file)).not.toContain("Terminal-Bench")
  })

  // The old "server.ts delegates" test asserted `src.toContain("projectReport")`
  // — a bare identifier, satisfied by a dead import, and PROVEN green while the
  // entire dispatch was replaced by a hardcoded projection. The behavioural
  // replacement lives in `server.test.ts` ("server.ts dispatches every artifact
  // through the registry"), which injects a spy projector into server.ts's REAL
  // `buildRunFromFile`. What stays here is the LIVE-CALL shape, which the same
  // gutting injection also turns red.
  const LIVE_PROJECT_CALL = /(?<![.\w$])projectReport\s*\(/

  test("the live-call detector distinguishes a CALL from an import (non-vacuity)", () => {
    expect(LIVE_PROJECT_CALL.test("projected = projectReport(report)")).toBe(true)
    expect(LIVE_PROJECT_CALL.test('import { projectReport } from "./projectors/registry"')).toBe(
      false,
    )
    expect(LIVE_PROJECT_CALL.test("type P = ReturnType<typeof projectReport>")).toBe(false)
    expect(LIVE_PROJECT_CALL.test("opts.projectReport(report)")).toBe(false)
  })

  test("server.ts CALLS the registry dispatch, and reaches the registry for its views", () => {
    const src = stripComments(read("server.ts"))
    expect(LIVE_PROJECT_CALL.test(src)).toBe(true)
    expect(/(?<![.\w$])benchmarkViewsOf\s*\(/.test(src)).toBe(true)
    // `...suiteData({…})` — spread, so allow the `...` prefix but not `x.suiteData(`.
    expect(/(?:^|\.\.\.|[^.\w$])suiteData\s*\(/m.test(src)).toBe(true)
    // ...and the page shell calls the registry for the suite client bundles.
    expect(/(?<![.\w$])suiteClientAssets\s*\(\s*\)/.test(stripComments(read("page.ts")))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// MED-C — legacy normalization has ONE owner. Every tool that reads the report
// trove enters through the registry's `decodeReportArtifact`; nothing re-derives
// a suite (or a legacy family) from raw artifact bytes on its own.
// ---------------------------------------------------------------------------

describe("rail: one legacy-normalization boundary for the whole dashboard tree", () => {
  /** The single identity normalizer. TB21-04 removed the LAST legacy-encoding
   *  adapter (Terminal's): the pre-2.1 fold recorded no trial ids, rewards or
   *  task versions, so there is no honest 2.1 reading of it and those artifacts
   *  are quarantined at the identity boundary instead of being re-scored. */
  const DECODE_OWNER = join("projectors", "registry.ts")

  const LIVE_DECODE = /(?<![.\w$])decodeCanonicalReport\s*\(/
  /** Interpreting a `datasetFamily` VALUE as a suite id — i.e. reading the
   *  pre-BFND-02 encoding where Terminal rode the family axis. That reading has
   *  exactly one sanctioned home. */
  const FAMILY_AS_SUITE =
    /datasetFamily[^\n]{0,30}(?:===|!==)[^\n]{0,30}(?:TERMINAL_VIEW_ID|["'](?:terminal-bench|swe-bench)["'])|["'](?:terminal-bench|swe-bench)["'][^\n]{0,30}(?:===|!==)[^\n]{0,30}datasetFamily/
  /** A module declaring or wiring a legacy-encoding adapter. */
  const ADOPT_LEGACY = /\badoptLegacy\b/

  test("the detectors actually detect (non-vacuity)", () => {
    expect(LIVE_DECODE.test("const r = decodeCanonicalReport(raw)")).toBe(true)
    expect(LIVE_DECODE.test('import { decodeCanonicalReport } from "@/runner/batch"')).toBe(false)
    expect(FAMILY_AS_SUITE.test('if (raw.datasetFamily === "terminal-bench") return null')).toBe(
      true,
    )
    expect(FAMILY_AS_SUITE.test("if (raw.datasetFamily !== TERMINAL_VIEW_ID) return null")).toBe(
      true,
    )
    expect(FAMILY_AS_SUITE.test('if ("terminal-bench" === row.datasetFamily) {}')).toBe(true)
    // A family compared to a FAMILY is the SWE axis doing its normal job.
    expect(FAMILY_AS_SUITE.test('if (run.datasetFamily === "pro") return proCard()')).toBe(false)
    expect(ADOPT_LEGACY.test("projector.adoptLegacy?.(body)")).toBe(true)
    expect(ADOPT_LEGACY.test("const adopted = legacyThing(body)")).toBe(false)
  })

  test("exactly ONE dashboard module calls the canonical decode", () => {
    const callers = walk(DASHBOARD)
      .filter(({ text }) => LIVE_DECODE.test(stripComments(text)))
      .map(({ path }) => path)
    expect(callers).toEqual([DECODE_OWNER])
  })

  test("NO dashboard module reads a legacy family as a suite any more", () => {
    // The strongest form of the old rail: with Terminal's adapter gone there is
    // no sanctioned home left, so the count is ZERO rather than one. The
    // non-vacuity probes above prove the detector still fires on the real thing.
    const offenders = walk(DASHBOARD)
      .filter(({ text }) => FAMILY_AS_SUITE.test(stripComments(text)))
      .map(({ path }) => path)
      .sort()
    expect(offenders).toEqual([])
  })

  test("legacy adoption stays a REGISTERED seam, unused (known-item floor)", () => {
    const wired = walk(DASHBOARD)
      .filter(({ text }) => ADOPT_LEGACY.test(stripComments(text)))
      .map(({ path }) => path)
      .sort()
    // Only the contract (types.ts) and the dispatcher that would run it
    // (registry.ts). No projector implements one — a new legacy adapter has to be
    // added deliberately, and this rail is where it shows up.
    expect(wired).toEqual([DECODE_OWNER, join("projectors", "types.ts")].sort())
  })

  test("the trove readers consume the ONE boundary instead of parsing identity", () => {
    // Known-item floor: these are the two modules that scan `*.report.json`.
    for (const consumer of ["server.ts", "leaderboard-sync.ts"]) {
      const src = stripComments(read(consumer))
      expect(/(?<![.\w$])(?:projectReport|decodeReportArtifact)\s*\(/.test(src)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Rail 2 — `datasetFamily === "promax"` never scatters outside the UI registry.
// ---------------------------------------------------------------------------

const FAMILY_PROMAX =
  /datasetFamily[^\n]{0,40}["']promax["']|["']promax["'][^\n]{0,40}datasetFamily/

describe("rail: no scattered promax family branches", () => {
  test("the detector actually detects (non-vacuity)", () => {
    expect(FAMILY_PROMAX.test('if (run.datasetFamily === "promax") return proMaxCard();')).toBe(
      true,
    )
    expect(FAMILY_PROMAX.test('const fam = c.datasetFamily || "verified";')).toBe(false)
  })

  test("no dashboard module branches on the promax family", () => {
    const offenders = walk(DASHBOARD)
      .filter(({ path }) => path !== join("projectors", "swe-bench", "registry.ts"))
      .filter(({ text }) => FAMILY_PROMAX.test(stripComments(text)))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Rail 3 — no projector re-implements the official metric formula.
// ---------------------------------------------------------------------------

/** The OFFICIAL-shaped metric. TB21-04 replaced the folded `resolvedPct`
 *  headline with `accuracy` (a port of the pinned upstream calculator), so the
 *  detector tracks BOTH spellings: a projector that assigns either is a second
 *  scoring authority. Reading a persisted `report.metrics.accuracy` is fine. */
const SECOND_SCORER = /(?:resolvedPct|accuracy)\s*[:=][^=]/

describe("rail: projectors format persisted metrics, never recompute them", () => {
  test("the detector actually detects (non-vacuity)", () => {
    expect(SECOND_SCORER.test("return { total, resolved, resolvedPct: pct }")).toBe(true)
    expect(SECOND_SCORER.test("const resolvedPct = Math.round((resolved / total) * 100)")).toBe(
      true,
    )
    expect(SECOND_SCORER.test("return report.totals.resolvedPct")).toBe(false)
    expect(SECOND_SCORER.test("if (a.resolvedPct === b.resolvedPct) return 0")).toBe(false)
    expect(SECOND_SCORER.test("const accuracy = (100 * successful) / total")).toBe(true)
    expect(SECOND_SCORER.test("return report.metrics.accuracy")).toBe(false)
  })

  test("no projector module computes an official-shaped score", () => {
    const offenders = walk(PROJECTORS)
      .filter(({ text }) => SECOND_SCORER.test(stripComments(text)))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  test("the ONE owner of that formula is the pinned upstream scorer, and it still owns it", () => {
    // TB21-04 moved the official metric out of the report builder and into a
    // verbatim PORT of the upstream leaderboard calculator, proven field-for-field
    // against the vendored `metrics.py` executed as a live oracle.
    const owner = readFileSync(
      join(DASHBOARD, "..", "..", "src", "apps", "bench", "terminal", "scoring.ts"),
      "utf8",
    )
    expect(SECOND_SCORER.test(owner)).toBe(true)
    expect(owner).toContain("leaderboard/src/leaderboard/core/metrics.py")
  })
})

// ---------------------------------------------------------------------------
// Rail 3b (PMX-05) — the official-grade denominator has exactly ONE owner, and
// it is not in the dashboard. A view that can divide is a second score.
// ---------------------------------------------------------------------------

const OG_OWNER = join("..", "..", "src", "runner", "batch", "report-official-grade.ts")

/**
 * Assigning any of the three PMX-05 rates, or dividing by one of their
 * denominators. Reading a persisted `d.coverage` is fine.
 *
 * The member chain is `(?:[\w$]+\s*\.\s*)*` — ARBITRARY depth. An earlier version
 * allowed only one segment and was PROVEN vacuous by injection: a real second
 * scorer written as `run.officialGrade.totals.resolved / run.officialGrade.totals.assigned`
 * sailed straight through it.
 */
const OG_SECOND_SCORER =
  /(?:official_valid_rate|raw_rate)\s*[:=][^=]|coverage\s*[:=][^=\n]*\/|\/\s*(?:[\w$]+\s*\.\s*)*(?:grading_valid|assigned)\b/

/**
 * Comments AND quoted string literals removed, so the rail keys on CODE.
 *
 * TEMPLATE literals are deliberately KEPT: the client bundles are template
 * literals holding real shipped JS, and stripping them would blind this rail to
 * the exact files it exists for. Quoted literals are prose — a card's sub-label
 * reading "grading-valid / assigned" describes a formula, it does not compute one.
 */
const codeOnly = (text: string): string =>
  stripComments(text)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")

describe("rail: the dashboard formats official-grade totals, never derives them", () => {
  test("the detector actually detects (non-vacuity)", () => {
    expect(OG_SECOND_SCORER.test("const official_valid_rate = resolved / grading_valid")).toBe(true)
    expect(OG_SECOND_SCORER.test("return { coverage, raw_rate: resolved / assigned }")).toBe(true)
    expect(OG_SECOND_SCORER.test("var pct = t.resolved / t.assigned;")).toBe(true)
    expect(OG_SECOND_SCORER.test("const coverage = valid / assigned")).toBe(true)
    // `coverage` alone is too generic to key on — the dashboard has an unrelated
    // dataset-coverage concept — so the rail keys on coverage BEING DIVIDED.
    expect(OG_SECOND_SCORER.test("const coverage = coverageOf(dataset, matrix)")).toBe(false)
    // A DEEP member chain — the exact shape that defeated the first version of
    // this regex when it was injected as a live second scorer.
    expect(
      OG_SECOND_SCORER.test(
        "var s = run.officialGrade.totals.resolved / run.officialGrade.totals.assigned;",
      ),
    ).toBe(true)
    // ...and it survives the code-only pass (which must not eat real code).
    expect(OG_SECOND_SCORER.test(codeOnly("var pct = t.resolved / t.assigned;"))).toBe(true)
    // Reading the persisted value, or comparing two of them, is not deriving it.
    expect(OG_SECOND_SCORER.test("cards.push(d.official_valid_rate)")).toBe(false)
    expect(OG_SECOND_SCORER.test("if (a.raw_rate === b.raw_rate) return 0")).toBe(false)
    // A quoted LABEL that merely names the formula is prose, not a second scorer.
    expect(OG_SECOND_SCORER.test(codeOnly('["c", d.coverage, "grading-valid / assigned"]'))).toBe(
      false,
    )
  })

  test("no dashboard module derives an official-grade rate", () => {
    const offenders = walk(DASHBOARD)
      .filter(({ text }) => OG_SECOND_SCORER.test(codeOnly(text)))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  test("the ONE owner is the report aggregator, and it still owns it (known-item floor)", () => {
    // Non-vacuity from the other side: if this came back false the regex would be
    // broken and the emptiness above would mean nothing.
    const owner = read(OG_OWNER)
    expect(OG_SECOND_SCORER.test(codeOnly(owner))).toBe(true)
    expect(owner).toContain("export const aggregateOfficialGrade")
    expect(owner).toContain("export const assertOfficialGradeCoveringPartition")
  })

  test("the SWE projector reaches that owner with a LIVE call, not a dead import", () => {
    const LIVE_FORMAT = /(?<![.\w$])formatOfficialGradeTotals\s*\(/
    expect(LIVE_FORMAT.test("display: formatOfficialGradeTotals(section.totals)")).toBe(true)
    expect(LIVE_FORMAT.test('import { formatOfficialGradeTotals } from "@/x"')).toBe(false)
    const src = stripComments(read(join("projectors", "swe-bench.ts")))
    expect(LIVE_FORMAT.test(src)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rail 4 — the extraction really happened (server.ts shrank at the boundaries).
// ---------------------------------------------------------------------------

describe("rail: the touched boundaries moved out of the shell", () => {
  const TB_RENDER_PATH = [
    "function tbTaskRows",
    "function tbSelectedRun",
    "function renderTbCards",
    "function renderTbMatrix",
    "function drawTbMatrix",
    "function tbScaffolds",
  ] as const

  test("the Terminal render path is no longer defined in any shell file", () => {
    for (const file of SHELL_FILES) {
      for (const moved of TB_RENDER_PATH) expect(read(file)).not.toContain(moved)
    }
  })

  test("it landed in the terminal projector's client bundle instead", () => {
    const client = read(join("projectors", "terminal-bench.client.ts"))
    for (const moved of TB_RENDER_PATH) expect(client).toContain(moved)
  })

  /**
   * LOW-G — an anti-regrowth floor is only a guarantee if it is anchored at the
   * CURRENT measurement. The previous anchor (2373) sat above the committed
   * baseline and 121 lines above HEAD, so "no later edit may re-grow past it"
   * was false: server.ts could have gained a hundred lines silently.
   *
   * Measured 2026-08-22 on this working tree (`wc -l`):
   *   server.ts 1215, page.ts 997.
   * TB21-05 took another 54 lines out: the Terminal per-instance row shaping
   * moved into the suite's own projector (its persisted channel is `trials`,
   * which the shell cannot read anyway), and the SWE preset-label fallback chain
   * — the last suite knowledge left in the shell — moved to
   * `projectors/swe-bench/preset-label.ts`.
   * server.ts was 2251 before the page extraction (2373 pre-BFND-03) and 1350
   * before PMX-05 moved the Run/row SHAPES out to `run-types.ts`. The floor is
   * RE-ANCHORED at each measurement, downward only: PMX-05 added a field to the
   * shell and paid for it by extracting more than it added.
   * A deliberate growth must move these numbers in the same commit.
   */
  const SIZE_FLOOR: Readonly<Record<string, number>> = {
    "server.ts": 1215,
    // C-D re-anchor (downward only): the family cards + the shared
    // `bestCampaignCard` builder moved to `page-family-cards.ts`, so the shell
    // paid for the new builder and 45 lines more.
    "page.ts": 953,
  }

  /** `wc -l` semantics, so the numbers in SIZE_FLOOR are the ones a reader gets
   *  from the shell. */
  const lineCount = (file: string): number => read(file).trimEnd().split("\n").length

  test("no shell file has re-grown past its measured size", () => {
    for (const [file, floor] of Object.entries(SIZE_FLOOR)) {
      const lines = lineCount(file)
      expect({ file, lines }).toEqual({ file, lines: Math.min(lines, floor) })
    }
  })

  /**
   * MED-H — `tests/unit/god-code-ratchet.test.ts` walks `src/` only, so nothing
   * in `tools/` is size-guarded at all. Extending that ratchet to `tools/` today
   * would require grandfathering three PRE-EXISTING god-modules
   * (`tools/feature-catalog/cli.ts` 1471, `tools/swebench-matrix.ts` 1317,
   * `tools/leaderboard-dashboard/server.ts` 1351) — i.e. papering, which the
   * ratchet's own rule forbids. The honest smallest step is this LOCAL floor: the
   * dashboard tree gets a no-amnesty size guard now, and `server.ts` is the ONLY
   * file over the 1000-line threshold, pinned at its exact current size above.
   */
  test("no dashboard module besides the pinned shell crosses the god-module threshold", () => {
    const over = walk(DASHBOARD)
      .map(({ path, text }) => ({ path, lines: text.trimEnd().split("\n").length }))
      .filter((f) => f.lines > 1000)
      .map((f) => f.path)
      .sort()
    // Known-item floor: server.ts IS over, so an empty result would mean the walk
    // silently stopped seeing files.
    expect(over).toEqual(["server.ts"])
  })

  test("the extraction is real: the shell shrank far below the pre-BFND-03 file", () => {
    // Non-vacuity for the floor above — it is not merely a restatement of a huge
    // number. 2373 was the pre-BFND-03 server.ts; 2251 was it after BFND-03.
    expect(lineCount("server.ts")).toBeLessThan(2251)
    // ...and the moved lines really went somewhere, not just deleted.
    expect(lineCount("page.ts")).toBeGreaterThan(500)
  })
})

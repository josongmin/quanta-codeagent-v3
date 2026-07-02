/**
 * XSS-escaping guard for the leaderboard dashboard's CLIENT-SIDE render layer.
 *
 * The dashboard ships its UI as one big client-side `<script>` template inside
 * server.ts. Report-derived strings (model / preset / campaign key / live log
 * tail — `lastInstance` is a regex match over arbitrary log bytes) are
 * interpolated into `.innerHTML`. If any sink is unescaped an attacker who can
 * land a string in a report file or a log gets stored XSS in the dashboard.
 *
 * We can't import server.ts (it calls Bun.serve at import). Instead we read the
 * source, pull the named render functions out of the shipped HTML template, and
 * evaluate them against a hostile DATA payload, asserting the output carries
 * escaped entities and never the raw `<script>`.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, basename as pathBasename } from "node:path"

const SRC = readFileSync(join(import.meta.dir, "server.ts"), "utf8")
// campaignKeyOf was extracted to family-partition.ts (genuinely importable; also
// unit-tested in family-partition.test.ts). The aggregation harness below slices its
// REAL source from there — `indexOf("const campaignKeyOf =")` lands past the `export `,
// so the slice transpiles cleanly inside `new Function`.
const FAMILY_SRC = readFileSync(join(import.meta.dir, "family-partition.ts"), "utf8")

/** Pull a `function name(...) { ... }` body out of the source by brace-matching. */
function extractFn(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`fn ${name} not found`)
  let depth = 0
  let i = SRC.indexOf("{", start)
  for (; i < SRC.length; i++) {
    const c = SRC[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error(`fn ${name} unbalanced`)
}

/** Pull the `esc` arrow/function helper. */
function extractEsc(): string {
  const m = SRC.match(/function esc\([^)]*\)\{[\s\S]*?\n\}/)
  if (m) return m[0]
  // single-line form
  const m2 = SRC.match(/function esc\([^)]*\)\s*\{[^\n]*\}/)
  if (!m2) throw new Error("esc not found")
  return m2[0]
}

const HOSTILE = `</style><script>alert(1)</script>`
const HOSTILE_CHARS = `& < > " '`

/** Evaluate the shipped `esc` helper in isolation. */
function loadEsc(): (s: string) => string {
  const src = `${extractEsc()}\nreturn esc;`
  return new Function(src)() as (s: string) => string
}

describe("dashboard XSS escaping", () => {
  test("esc covers & < > \" ' and escapes & first", () => {
    const esc = loadEsc()
    expect(esc(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;")
    // & must be escaped first so existing entities are not double-broken into
    // raw text, AND a lone & becomes &amp; not corrupt output.
    expect(esc("a&b")).toBe("a&amp;b")
    expect(esc(null as unknown as string)).toBe("")
  })

  test("renderRuns escapes campaign model/preset/key/members", () => {
    const DATA = {
      campaigns: [
        {
          key: HOSTILE,
          model: HOSTILE,
          preset: HOSTILE,
          members: [HOSTILE_CHARS],
          resolved: 1,
          total: 2,
          mtime: 0,
          // RFC jun-29 R4: datasetFamily flows from report JSON → famChip → DOM. A
          // hostile family string MUST be escaped too (it builds a class attr + text).
          datasetFamily: HOSTILE,
        },
      ],
    }
    // renderRuns now depends on the module-global FAM_FILTER + the famChip helper —
    // inject both into the eval scope so we exercise the SHIPPED render path.
    const src = [
      'var FAM_FILTER="";',
      extractEsc(),
      extractFn("famChip"),
      extractFn("renderRuns"),
      "return renderRuns();",
    ].join("\n")
    const out = new Function("DATA", "document", src)(DATA, {}) as string
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
    expect(out).toContain("&amp;")
    expect(out).toContain("&#39;")
  })

  // RFC jun-29 — external SOTA comparison column in renderRuns. External model names
  // come from external JSON; they must be esc()'d at the HTML boundary.
  const renderRunsWith = (DATA: unknown): string => {
    const src = [
      'var FAM_FILTER="";',
      extractEsc(),
      extractFn("famChip"),
      extractFn("extCoordFor"),
      extractFn("extSotaForFamily"),
      extractFn("renderRuns"),
      "return renderRuns();",
    ].join("\n")
    return new Function("DATA", "document", src)(DATA, {}) as string
  }

  test("renderRuns: all-verified + no externalBaselines ⇒ NO external column (byte-identical)", () => {
    const verifiedOnly = {
      campaigns: [
        {
          key: "k",
          model: "m",
          preset: "p",
          members: ["x"],
          resolved: 1,
          total: 2,
          mtime: 0,
          datasetFamily: "verified",
        },
      ],
    }
    const noBaselines = renderRunsWith(verifiedOnly)
    // The legacy header has no "외부 SOTA" column and no ext cell.
    expect(noBaselines).not.toContain("외부 SOTA")
    expect(noBaselines).not.toContain("ext SOTA")
    // Even WITH baselines present, a verified-only view shows no external column (R4).
    const withBaselines = renderRunsWith({
      ...verifiedOnly,
      externalBaselines: {
        models: [
          { name: "X", dataset: "live", set: "verified", total: 10, resolved: 9, rate: 0.9 },
        ],
        liveResolvedBy: {},
      },
    })
    expect(withBaselines).toBe(noBaselines) // byte-identical regardless of baselines
  })

  test("renderRuns: pro campaign shows ext SOTA and ESCAPES the external model name", () => {
    const out = renderRunsWith({
      campaigns: [
        {
          key: "ourpro",
          model: "m",
          preset: "p",
          members: ["x"],
          resolved: 1,
          total: 5,
          mtime: 0,
          datasetFamily: "pro",
        },
      ],
      externalBaselines: {
        models: [
          {
            name: HOSTILE,
            dataset: "pro",
            set: "public-731",
            total: 731,
            resolved: 432,
            rate: 0.591,
          },
        ],
        liveResolvedBy: {},
      },
    })
    expect(out).toContain("외부 SOTA")
    expect(out).toContain("ext SOTA 59%")
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
  })

  test("renderRuns: pro campaign with NO external match ⇒ — (graceful degrade)", () => {
    const out = renderRunsWith({
      campaigns: [
        {
          key: "ourpro",
          model: "m",
          preset: "p",
          members: ["x"],
          resolved: 1,
          total: 5,
          mtime: 0,
          datasetFamily: "pro",
        },
        // a live campaign forces the column on, but pro has no matching baseline model
        {
          key: "ourlive",
          model: "m",
          preset: "p",
          members: ["y"],
          resolved: 2,
          total: 4,
          mtime: 0,
          datasetFamily: "live",
        },
      ],
      externalBaselines: {
        models: [
          { name: "L", dataset: "live", set: "verified", total: 10, resolved: 6, rate: 0.6 },
        ],
        liveResolvedBy: {},
      },
    })
    // column on (live has a match), pro row shows — since no pro baseline exists.
    expect(out).toContain("외부 SOTA")
    expect(out).toContain("ext SOTA 60%")
    expect(out).toContain('<td class="muted">—</td>')
  })

  test("renderScaffolds escapes scaffold key/model", () => {
    const DATA = {
      topScaffolds: [{ key: HOSTILE, model: HOSTILE, resolved: 1, pct: 50 }],
    }
    const src = ['var BENCH="verified";', extractEsc(), extractFn("renderScaffolds"), "return renderScaffolds();"].join("\n")
    const out = new Function("DATA", "document", src)(DATA, {}) as string
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
  })

  test("renderLive escapes dir/log/lastInstance and the log tail", () => {
    const DATA = {
      live: [
        {
          dir: HOSTILE,
          log: HOSTILE,
          lastInstance: HOSTILE,
          lines: 1,
          mtime: 0,
          tail: `${HOSTILE} ${HOSTILE_CHARS}`,
        },
      ],
    }
    const src = [extractEsc(), extractFn("renderLive"), "return renderLive();"].join("\n")
    const out = new Function("DATA", "document", src)(DATA, { Date }) as string
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
    expect(out).toContain("&amp;")
  })

  // RFC jun-29 — per-instance SOLVABILITY markers in drawMatrix.
  const runDrawMatrix = (DATA: unknown): string => {
    let mtableHtml = ""
    const doc = {
      getElementById(id: string) {
        if (id === "mtable") {
          return {
            set innerHTML(v: string) {
              mtableHtml = v
            },
          }
        }
        // #mcount: drawMatrix only assigns .textContent — a plain writable field.
        return { textContent: "" }
      },
      querySelectorAll() {
        return { forEach() {} }
      },
    }
    const src = [
      "var SORT={key:'inst',dir:-1};",
      "var SCAF_SHOW=[];",
      "var SCAF_LABEL={};",
      "var MATRIX_FILTER={q:'',kind:'all',repo:''};",
      extractEsc(),
      extractFn("tierClass"),
      extractFn("fmtDur"),
      extractFn("fmtWhen"),
      extractFn("unifiedRows"),
      extractFn("drawMatrix"),
      "drawMatrix(); return null;",
    ].join("\n")
    new Function("DATA", "document", src)(DATA, doc)
    return mtableHtml
  }

  test("drawMatrix: gold-broken ⇒ verifier-broken marker; ext-resolver ⇒ ext✓ (escaped)", () => {
    const DATA = {
      rows: {},
      dataset: {},
      quanta: {
        "broken-1": {
          passed: false,
          goldBroken: true,
          fail: { reRunnable: false, klass: "x", termination: "t", repro: "", f2p: 1, p2p: 0 },
          attempts: 1,
          passes: 0,
          bestTurns: null,
          failTurns: 1,
          presets: [],
          models: [],
          passedBy: [],
        },
        "extok-2": {
          passed: false,
          goldBroken: false,
          fail: { reRunnable: false, klass: "x", termination: "t", repro: "", f2p: 1, p2p: 0 },
          attempts: 1,
          passes: 0,
          bestTurns: null,
          failTurns: 1,
          presets: [],
          models: [],
          passedBy: [],
        },
      },
      frontierTurns: {},
      externalBaselines: {
        models: [],
        // hostile resolver name → MUST be escaped at the HTML boundary.
        liveResolvedBy: { "extok-2": [HOSTILE, "ModelB"] },
      },
    }
    const html = runDrawMatrix(DATA)
    expect(html).toContain("⚠ verifier-broken")
    expect(html).toContain("ext✓")
    // two resolvers ⇒ count shown
    expect(html).toContain("ext✓ 2")
    // resolver name escaped — no raw script tag leaks into the title attr.
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  test("drawMatrix: no externalBaselines ⇒ no ext✓ / no verifier-broken from baselines (degrade)", () => {
    const DATA = {
      rows: {},
      dataset: {},
      quanta: {
        "plain-1": {
          passed: false,
          fail: { reRunnable: false, klass: "x", termination: "t", repro: "", f2p: 1, p2p: 0 },
          attempts: 1,
          passes: 0,
          bestTurns: null,
          failTurns: 1,
          presets: [],
          models: [],
          passedBy: [],
        },
      },
      frontierTurns: {},
      // externalBaselines absent
    }
    const html = runDrawMatrix(DATA)
    expect(html).not.toContain("ext✓")
    expect(html).not.toContain("⚠ verifier-broken")
    expect(html).toContain("plain-1")
  })

  test("renderCards escapes the best-campaign key", () => {
    const DATA = {
      quanta: {},
      rows: {},
      campaigns: [{ key: HOSTILE, resolved: 1, total: 2 }],
      runs: [],
      live: [],
      coverage: null,
    }
    const src = ['var BENCH="verified";', extractEsc(), extractFn("renderCards"), "renderCards(); return null;"].join("\n")
    const doc = {
      sink: "",
      getElementById() {
        const self = doc
        return {
          set innerHTML(v: string) {
            self.sink = v
          },
        }
      },
    }
    new Function("DATA", "document", src)(DATA, doc)
    expect(doc.sink).not.toContain("<script>")
    expect(doc.sink).toContain("&lt;script&gt;")
  })
})

describe("parseReportFile mtime memo (FIX 3)", () => {
  // We inject a counting `buildRunFromFile` + fresh cache Map so we can prove
  // the memo skips the expensive parse on an unchanged mtime and invalidates
  // (re-parses) the moment the file's mtime moves — i.e. on edit.
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  function loadParseReportFile() {
    // Transpile the TS helper to JS so `new Function` can parse it.
    const tsSrc = extractFn("parseReportFile")
    const src = `${transpiler.transformSync(tsSrc)}\nreturn parseReportFile;`
    let builds = 0
    const RUN_PARSE_CACHE = new Map<string, { mtime: number; run: unknown }>()
    const buildRunFromFile = (f: string, mtime: number) => {
      builds++
      return { file: f, mtime }
    }
    const fn = new Function("RUN_PARSE_CACHE", "buildRunFromFile", src)(
      RUN_PARSE_CACHE,
      buildRunFromFile,
    ) as (f: string, m: number) => unknown
    return { fn, builds: () => builds, cache: RUN_PARSE_CACHE }
  }

  test("unchanged mtime is served from cache (no re-parse)", () => {
    const { fn, builds } = loadParseReportFile()
    fn("/x/a.report.json", 1000)
    fn("/x/a.report.json", 1000)
    fn("/x/a.report.json", 1000)
    expect(builds()).toBe(1)
  })

  test("changed mtime invalidates and re-parses (edit visibility)", () => {
    const { fn, builds } = loadParseReportFile()
    const r1 = fn("/x/a.report.json", 1000) as { mtime: number }
    const r2 = fn("/x/a.report.json", 2000) as { mtime: number }
    expect(builds()).toBe(2)
    expect(r1.mtime).toBe(1000)
    expect(r2.mtime).toBe(2000)
  })

  test("mtime 0 (stat failed) never caches — always parses fresh", () => {
    const { fn, builds, cache } = loadParseReportFile()
    fn("/x/a.report.json", 0)
    fn("/x/a.report.json", 0)
    expect(builds()).toBe(2)
    expect(cache.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// FLAG-B / FLAG-C: re-runnable measurement-holes (throttle / harness / grader
// infra / env-degraded) must be EXCLUDED from the solve-rate denominator and
// from the "real gap" (진짜 격차) card. Genuine misses (wrong-fix, timeout,
// admission gate, empty-patch) must STAY in the denominator. This mirrors the
// markdown leaderboard rule in src/apps/bench/analyze/verdicts.ts.
//
// We assemble a tiny module out of the SERVER's real source slices (asRecord /
// asString / shortId / RE_RUNNABLE_TERMINATIONS / isReRunnableHole /
// classifyFail / instanceIsUnmeasured / campaignKeyOf / addRunToCachedGroups /
// groupRuns) so the test exercises the shipped predicate + aggregation, not a
// copy.
const TRANSPILER = new Bun.Transpiler({ loader: "ts" })

/** Brace-match a BLOCK-bodied declaration starting at `anchor` (a `function …`
 *  or a `const … = (...) => { … }` arrow). We anchor the opening brace at the
 *  function/arrow BODY, not at a `{ … }` object inside a type annotation, by
 *  scanning from the first `=> {` (arrows) or first `) … {` (functions). */
function sliceDecl(anchor: string, src: string = SRC): string {
  const SRC = src
  const start = SRC.indexOf(anchor)
  if (start < 0) throw new Error(`decl not found: ${anchor}`)
  // Body brace = the `{` after `=> ` for block-bodied arrows (robust against
  // `{ … }` object braces in parameter type annotations); else the first `{`
  // for a plain `function`. `anchor` starts with "function" iff no arrow.
  const isArrow = !anchor.startsWith("function")
  const bodyOpen = isArrow ? SRC.indexOf("{", SRC.indexOf("=>", start)) : SRC.indexOf("{", start)
  if (bodyOpen < 0) throw new Error(`no body brace for ${anchor}`)
  let depth = 0
  for (let i = bodyOpen; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++
    else if (SRC[i] === "}") {
      depth--
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced: ${anchor}`)
}

/** Single-statement const (value spans to end of line, no own braces). */
function sliceConst(name: string): string {
  const re = new RegExp(`const ${name}\\b[^\\n]*`)
  const m = SRC.match(re)
  if (!m) throw new Error(`const not found: ${name}`)
  return m[0]
}

/** Expression-bodied arrow const (e.g. `const f = (x): T => expr`) — value spans
 *  multiple lines but has NO body brace. Grab through the next `\n\n` boundary. */
function sliceExprArrow(anchor: string): string {
  const start = SRC.indexOf(anchor)
  if (start < 0) throw new Error(`expr-arrow not found: ${anchor}`)
  const end = SRC.indexOf("\n\n", start)
  return SRC.slice(start, end < 0 ? undefined : end)
}

interface Camp {
  resolved: number
  total: number
  unmeasured: number
  key: string
}
interface AggModule {
  classifyFail: (pi: unknown) => Record<string, unknown> | null
  groupRuns: (runs: unknown[]) => Camp[]
}

/** First rolled-up campaign (tests always pass at least one run → one group). */
function firstCampaign(runs: unknown[]): Camp {
  const c = loadAgg().groupRuns(runs)[0]
  if (!c) throw new Error("expected at least one campaign")
  return c
}

function loadAgg(): AggModule {
  const ts = [
    sliceExprArrow("const asRecord ="),
    sliceConst("asString"),
    sliceDecl("const shortId ="),
    sliceConst("RE_RUNNABLE_TERMINATIONS"),
    sliceDecl("function isReRunnableHole"),
    sliceDecl("function classifyFail"),
    sliceExprArrow("const instanceIsUnmeasured ="),
    sliceDecl("const campaignKeyOf =", FAMILY_SRC),
    sliceDecl("const addRunToCampaign ="),
    sliceDecl("function groupRuns"),
    "return { classifyFail, groupRuns };",
  ].join("\n")
  const js = TRANSPILER.transformSync(ts)
  // campaignKeyOf uses `basename` from node:path — inject it into scope.
  return new Function("basename", js)(pathBasename) as AggModule
}

// A failing perInstance-like report row with a given termination.
const failRow = (
  id: string,
  termination: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  passed: false,
  turns: 1,
  failure: { termination },
  ...extra,
})
const passRow = (id: string): Record<string, unknown> => ({ id, passed: true, turns: 1 })

const makeRun = (
  label: string,
  rows: Record<string, unknown>[],
  datasetFamily = "verified",
): unknown => {
  const { classifyFail } = loadAgg()
  return {
    label,
    file: `/runs/${label}.report.json`,
    model: "m",
    preset: "p",
    mtime: 1,
    datasetFamily,
    perInstance: rows.map((r) => ({
      id: r.id,
      passed: r.passed === true,
      turns: 1,
      fail: classifyFail(r),
    })),
  }
}

// RFC jun-29 R4 — the conflation guard, END-TO-END through the real groupRuns/addRunToCampaign
// slices (not just the campaignKeyOf unit). A pro run and a verified run of the SAME logical
// campaign must yield TWO campaigns with NO instance union — else a Pro resolved-rate would be
// averaged into the Verified leaderboard number.
describe("dataset-family partition — groupRuns does NOT conflate families (R4)", () => {
  test("same label, different family ⇒ two separate campaigns, no instance union", () => {
    const { groupRuns } = loadAgg()
    const verified = makeRun(
      "solver-x",
      [passRow("inst-1"), failRow("inst-2", "timeout")],
      "verified",
    )
    const pro = makeRun("solver-x", [passRow("inst-1"), passRow("inst-2")], "pro")
    const camps = groupRuns([verified, pro]) as { key: string; resolved: number; total: number }[]
    expect(camps).toHaveLength(2)
    const keys = camps.map((c) => c.key).sort()
    expect(keys).toEqual(["[pro] solver-x", "solver-x"])
    // No union: verified campaign measured 2 (1 resolved), pro measured 2 (2 resolved).
    const v = camps.find((c) => c.key === "solver-x")!
    const p = camps.find((c) => c.key === "[pro] solver-x")!
    expect(v.total).toBe(2)
    expect(v.resolved).toBe(1)
    expect(p.total).toBe(2)
    expect(p.resolved).toBe(2)
  })

  test("two verified runs of the same campaign STILL roll up (no spurious split)", () => {
    const { groupRuns } = loadAgg()
    const a = makeRun("solver-y", [passRow("inst-1")], "verified")
    const b = makeRun("solver-y", [passRow("inst-2")], "verified")
    const camps = groupRuns([a, b]) as { key: string }[]
    expect(camps).toHaveLength(1)
    expect(camps[0]!.key).toBe("solver-y")
  })
})

describe("re-runnable classification (FLAG predicate)", () => {
  const { classifyFail } = loadAgg()
  const rr = (term: string, extra: Record<string, unknown> = {}) =>
    classifyFail(failRow("repo-1", term, extra))?.reRunnable

  test("throttle / harness / grader-infra terminations are re-runnable", () => {
    expect(rr("throttled")).toBe(true)
    expect(rr("harness_error")).toBe(true)
    expect(rr("grader_invalid")).toBe(true)
  })

  test("env-degraded rows (envPrepFailed / infra_blocked) are re-runnable", () => {
    expect(rr("completed_unresolved", { envPrepFailed: true })).toBe(true)
    expect(rr("completed_unresolved", { proofState: "infra_blocked" })).toBe(true)
  })

  test("genuine misses STAY real (NOT re-runnable): timeout, admission gate, empty, wrong-fix, regression", () => {
    expect(rr("timeout")).toBe(false) // real miss
    expect(rr("admission_blocked")).toBe(false) // 게이트차단 = real miss
    expect(rr("hung_stream")).toBe(false)
    expect(rr("generation_error")).toBe(false)
    // genuine empty patch
    expect(rr("no_patch")).toBe(false)
    // wrong-fix (graded, FAIL_TO_PASS still red) — even if termination looked infra-ish
    expect(
      classifyFail(failRow("r-1", "harness_error", { gradeBreakdown: { failToPassFailed: 2 } }))
        ?.reRunnable,
    ).toBe(false)
    // regression
    expect(
      classifyFail(failRow("r-1", "throttled", { gradeBreakdown: { passToPassFailed: 1 } }))
        ?.reRunnable,
    ).toBe(false)
  })

  test("admission_blocked maps to 게이트차단 klass AND stays a real miss (no klass/term collision with infra_blocked)", () => {
    const adm = classifyFail(failRow("r-1", "admission_blocked"))
    expect(adm?.klass).toBe("게이트차단")
    expect(adm?.reRunnable).toBe(false)
    // infra_blocked ALSO renders 게이트차단 via /blocked/ regex but IS re-runnable
    const infra = classifyFail(
      failRow("r-1", "completed_unresolved", { proofState: "infra_blocked" }),
    )
    expect(infra?.reRunnable).toBe(true)
  })
})

describe("campaign denominator excludes re-runnable holes (FLAG-B)", () => {
  test("K throttled/infra instances yield the SAME resolved-rate as without them, with unmeasured: K surfaced", () => {
    const solved = [passRow("repo-1"), passRow("repo-2")]
    const realMiss = [
      failRow("repo-3", "completed_unresolved", { gradeBreakdown: { failToPassFailed: 1 } }),
    ]
    const baseRows = [...solved, ...realMiss]
    const holes = [
      failRow("repo-4", "throttled"),
      failRow("repo-5", "harness_error"),
      failRow("repo-6", "completed_unresolved", { envPrepFailed: true }),
    ]

    const without = firstCampaign([makeRun("camp", baseRows)])
    const withHoles = firstCampaign([makeRun("camp", [...baseRows, ...holes])])

    // 2 solved / (2 solved + 1 real miss) in BOTH — holes excluded from total.
    expect(without.resolved).toBe(2)
    expect(without.total).toBe(3)
    expect(withHoles.resolved).toBe(2)
    expect(withHoles.total).toBe(3)
    expect(withHoles.resolved / withHoles.total).toBe(without.resolved / without.total)
    // K=3 surfaced separately.
    expect(withHoles.unmeasured).toBe(3)
    expect(without.unmeasured).toBe(0)
  })

  test("a genuine wrong-fix / timeout / empty-patch STILL counts in total (no inflation)", () => {
    const rows = [
      passRow("repo-1"),
      failRow("repo-2", "completed_unresolved", { gradeBreakdown: { failToPassFailed: 1 } }), // wrong fix
      failRow("repo-3", "timeout"), // timeout
      failRow("repo-4", "no_patch"), // genuine empty patch
    ]
    const c = firstCampaign([makeRun("camp", rows)])
    expect(c.total).toBe(4) // all 4 measured
    expect(c.unmeasured).toBe(0)
    expect(c.resolved).toBe(1)
  })

  test("TEETH: counting unmeasured in the total deflates the rate (proves exclusion matters)", () => {
    const rows = [passRow("repo-1"), failRow("repo-2", "throttled")]
    const c = firstCampaign([makeRun("camp", rows)])
    const realRate = c.resolved / c.total // 1/1 = 1.0
    // What a NAIVE denominator (seen.size, including the hole) would have given:
    const naiveTotal = c.total + c.unmeasured // 1 + 1 = 2
    const naiveRate = c.resolved / naiveTotal // 1/2 = 0.5
    expect(realRate).toBe(1)
    expect(naiveRate).toBeLessThan(realRate) // deflation iff we (wrongly) included it
  })

  test("instance measured in one shard, throttled in another counts as MEASURED (not unmeasured)", () => {
    // Same campaign key via identical dir; two shard files (shard syntax keeps one campaign).
    const shardA = makeRun("camp-shard1", [failRow("repo-1", "throttled")])
    const shardB = makeRun("camp-shard1", [
      failRow("repo-1", "completed_unresolved", { gradeBreakdown: { failToPassFailed: 1 } }),
    ])
    const c = firstCampaign([shardA, shardB])
    expect(c.unmeasured).toBe(0) // measured by shardB → not a hole
    expect(c.total).toBe(1)
    expect(c.resolved).toBe(0)
  })
})

describe("realMiss card excludes re-runnable holes (FLAG-C)", () => {
  // renderCards is client-side; drive its real source against a DATA payload and
  // capture the rendered cards via a fake document, then assert the 진짜 격차
  // value does NOT count a throttled hash>1 instance.
  function runRenderCards(DATA: unknown): string {
    const src = ['var BENCH="verified";', extractEsc(), extractFn("renderCards"), "renderCards(); return null;"].join("\n")
    let sink = ""
    const doc = {
      getElementById() {
        return {
          set innerHTML(v: string) {
            sink = v
          },
        }
      },
    }
    new Function("DATA", "document", src)(DATA, doc)
    return sink
  }

  test("a throttled instance on a frontier-solved (hash>1) problem is NOT counted as 진짜 격차", () => {
    const DATA = {
      quanta: {
        // genuine capability miss: wrong fix on a frontier-solved problem
        "repo-1": { passed: false, fail: { reRunnable: false, klass: "패치햇는데틀림" } },
        // throttled hole on a frontier-solved problem — MUST be excluded
        "repo-2": { passed: false, fail: { reRunnable: true, klass: "채점/실행에러" } },
        "repo-3": { passed: true, fail: null },
      },
      rows: {
        "repo-1": { hash: 50 },
        "repo-2": { hash: 50 },
        "repo-3": { hash: 50 },
      },
      campaigns: [],
      runs: [],
      live: [],
      coverage: null,
    }
    const html = runRenderCards(DATA)
    // 진짜 격차 card shows the realMiss count as its big number. Only repo-1 is a
    // real gap (repo-2 is a re-runnable hole, repo-3 passed).
    expect(html).toContain('<div class="n">1</div><div class="l">진짜 격차</div>')
    // and it advertises that 미측정(1) was excluded.
    expect(html).toContain("미측정(1)")
  })

  test("TEETH: if the throttled instance were a real miss, the gap would read 2 — confirm it does not", () => {
    const DATA = {
      quanta: {
        "repo-1": { passed: false, fail: { reRunnable: false, klass: "패치햇는데틀림" } },
        "repo-2": { passed: false, fail: { reRunnable: true, klass: "채점/실행에러" } },
      },
      rows: { "repo-1": { hash: 50 }, "repo-2": { hash: 50 } },
      campaigns: [],
      runs: [],
      live: [],
      coverage: null,
    }
    const html = runRenderCards(DATA)
    expect(html).not.toContain('<div class="n">2</div><div class="l">진짜 격차</div>')
    expect(html).toContain('<div class="n">1</div><div class="l">진짜 격차</div>')
  })
})

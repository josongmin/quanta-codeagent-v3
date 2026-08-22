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
import { renderDashboardPage } from "./page"
import { suiteClientAssets } from "./projectors/registry"

/**
 * HIGH-F — bind the REAL artifact.
 *
 * The previous harness manufactured `server.ts + suiteClientAssets().script`
 * ITSELF, so nothing asserted that the page actually interpolates a suite bundle:
 * deleting the Terminal client wiring from the served page left every test green.
 * `PAGE` below is the exact byte-string `routeRequest` hands the browser, so a
 * client function is only extractable here because the page really ships it.
 */
const PAGE = renderDashboardPage({ tracePort: 4318 })

/** server.ts still owns the SERVER-side helpers (parse/classify/aggregate); the
 *  client layer lives in the rendered page. Both are the shipped source. */
const SERVER_SRC = readFileSync(join(import.meta.dir, "server.ts"), "utf8")
const SRC = [SERVER_SRC, PAGE].join("\n")
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

/**
 * BFND-03: the SWE render path is now reached through the page's SUITE dispatch
 * (`suiteView()` → a registered suite's hooks, else the default shell). Every
 * harness that evaluates a shell renderer must therefore carry the real dispatch
 * helpers — sliced from the shipped source — plus an EMPTY `SUITE_VIEWS`, which
 * is what "no suite claimed this view" looks like in the browser.
 */
const SUITE_DISPATCH_PRELUDE: readonly string[] = [
  'var BENCH="verified";',
  "var SUITE_VIEWS={};",
  extractEsc(),
  extractFn("suiteOfView"),
  extractFn("suiteView"),
]

const HOSTILE = `</style><script>alert(1)</script>`
const HOSTILE_CHARS = `& < > " '`

// ---------------------------------------------------------------------------
// HIGH-F rail — the served page really ships each REGISTERED suite's client
// bundle. This is the rail the old harness could not have: it compares the page
// the server hands out against what the registry says the suites contributed.
// ---------------------------------------------------------------------------

describe("BFND-03 — the served page interpolates the suite client bundles", () => {
  test("the registry's bundles are present VERBATIM in the shipped page", () => {
    const assets = suiteClientAssets()
    // Known-item floor first: the registry must actually have something to ship,
    // so an empty-registry regression cannot satisfy `toContain("")`.
    expect(assets.script.length).toBeGreaterThan(1000)
    expect(assets.style.length).toBeGreaterThan(50)
    expect(assets.script).toContain("function renderTbCards")
    // ...and the page carries them byte-for-byte.
    expect(PAGE).toContain(assets.script)
    expect(PAGE).toContain(assets.style)
  })

  test("the Terminal suite's real render entry points reach the browser", () => {
    for (const fn of [
      "function tbTaskRows",
      "function tbSelectedRun",
      "function renderTbCards",
      "function renderTbMatrix",
      "function drawTbMatrix",
      "function tbScaffolds",
    ]) {
      expect(PAGE).toContain(fn)
    }
    // TB21-05 — the any-pass fold the cutover REMOVED must not reappear in the
    // shipped bytes: it collapsed a task's k trials into one optimistic boolean
    // across runs AND arms, which is the projection the ticket forbids.
    expect(PAGE).not.toContain("function tbOurResults")
    expect(PAGE).not.toContain("tbBestRun")
    // ...and the shell's suite dispatch that those bundles register into.
    expect(PAGE).toContain("var SUITE_VIEWS = {}")
    expect(PAGE).toContain("function suiteView()")
    expect(PAGE).toContain("SUITE_VIEWS[")
  })

  test("the page is a real document, and its dynamic inputs are interpolated", () => {
    expect(PAGE.startsWith("<!doctype html>")).toBe(true)
    expect(PAGE.trimEnd().endsWith("</html>")).toBe(true)
    // Non-vacuity for the interpolation itself: a distinct port must appear, so a
    // page that had gone static (all `${…}` dropped) fails here.
    expect(renderDashboardPage({ tracePort: 45678 })).toContain("45678")
    expect(PAGE).not.toContain("45678")
  })
})

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
    const src = SUITE_DISPATCH_PRELUDE.concat([
      extractFn("renderScaffolds"),
      "return renderScaffolds();",
    ]).join("\n")
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
    const src = SUITE_DISPATCH_PRELUDE.concat([
      extractFn("renderCards"),
      "renderCards(); return null;",
    ]).join("\n")
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

// ---------------------------------------------------------------------------
// HIGH-F rail — server.ts DELEGATES to the projector registry with a LIVE CALL.
//
// The old rail was `expect(src).toContain("projectReport")` — a bare-identifier
// substring, satisfied by a dead import. Here we run server.ts's REAL
// `buildRunFromFile` with an injected `projectReport` and prove (a) it is called
// with the parsed artifact, (b) every suite-derived field on the Run comes back
// from the projection, and (c) a refusing projector drops the run.
// ---------------------------------------------------------------------------

interface DispatchProbe {
  buildRun: (file: string, mtime: number) => Record<string, unknown> | null
  calls: unknown[]
  quarantined: { file: string; raw: unknown; error: unknown }[]
}

const ARTIFACT = {
  timestamp: "2026-08-22T00:00:00.000Z",
  model: "gpt-5.5",
  knobs: { preset: "raw-knobs-preset" },
  perInstance: [
    { id: "django__django-1", passed: true, turns: 3, durationMs: 10 },
    { id: "django__django-2", passed: false, turns: 4, durationMs: 20 },
  ],
}

function loadDispatch(projection: unknown, artifact: unknown = ARTIFACT): DispatchProbe {
  const ts = [
    sliceExprArrow("const asRecord ="),
    sliceConst("asString"),
    sliceConst("RE_RUNNABLE_TERMINATIONS"),
    sliceDecl("function isReRunnableHole"),
    sliceDecl("function classifyFail"),
    sliceExprArrow("const instanceIsUnmeasured ="),
    sliceExprArrow("const rowBaseOf ="),
    sliceExprArrow("const sweRowsOf ="),
    sliceDecl("const tallyOf ="),
    sliceDecl("function buildRunFromFile"),
    "return buildRunFromFile;",
  ].join("\n")
  const calls: unknown[] = []
  const quarantined: DispatchProbe["quarantined"] = []
  const projectReport = (raw: unknown): unknown => {
    calls.push(raw)
    if (projection === null) throw new Error("unidentifiable artifact")
    return projection
  }
  const recordQuarantine = (file: string, raw: unknown, error: unknown): void => {
    quarantined.push({ file, raw, error })
  }
  const buildRun = new Function(
    "readFileSync",
    "basename",
    "swePresetLabel",
    "projectReport",
    "recordQuarantine",
    TRANSPILER.transformSync(ts),
  )(
    () => JSON.stringify(artifact),
    (p: string) => pathBasename(p),
    () => "SERVER-SIDE-FALLBACK-LABEL",
    projectReport,
    recordQuarantine,
  ) as DispatchProbe["buildRun"]
  return { buildRun, calls, quarantined }
}

describe("BFND-03 — server.ts dispatches every artifact through the registry", () => {
  test("the projector is CALLED with the parsed artifact, and its projection is used", () => {
    const { buildRun, calls } = loadDispatch({
      benchmarkSuite: "terminal-bench",
      instanceRowKind: "trial-receipt",
      viewId: "terminal-bench",
      campaignIdentity: "terminal-bench@2.1 pinned-ref",
      presetLabel: "TB +levers",
      headline: { resolved: 7, total: 9 },
      // TB21-05: a suite that owns its per-instance channel ships the rows itself.
      rows: [
        { id: "trial-1", passed: true, taskId: "org/a", outcome: "graded_pass" },
        { id: "trial-2", passed: false, taskId: "org/a", outcome: "agent_crash" },
      ],
      runPayload: { datasetRef: "pinned-ref", metrics: { accuracy: 50 } },
    })
    const run = buildRun("/runs/x.report.json", 123)
    // (a) the LIVE call happened, with the artifact itself — not a filename sniff.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(ARTIFACT)
    // (b) every suite-derived field is the projection's, including the headline
    //     that overrides the shell's own row count (2 rows, 1 passed).
    expect(run).not.toBeNull()
    expect(run?.benchmarkSuite).toBe("terminal-bench")
    expect(run?.viewId).toBe("terminal-bench")
    expect(run?.campaignIdentity).toBe("terminal-bench@2.1 pinned-ref")
    expect(run?.preset).toBe("TB +levers")
    expect(run?.resolved).toBe(7)
    expect(run?.total).toBe(9)
    expect("datasetFamily" in (run ?? {})).toBe(false)
  })

  test("PAIRED CONTROL: a different projection produces a different Run", () => {
    const { buildRun } = loadDispatch({
      benchmarkSuite: "swe-bench",
      instanceRowKind: "swe-grade",
      viewId: "pro",
      datasetFamily: "pro",
      campaignIdentity: "pro",
    })
    const run = buildRun("/runs/x.report.json", 123)
    expect(run?.benchmarkSuite).toBe("swe-bench")
    expect(run?.viewId).toBe("pro")
    expect(run?.datasetFamily).toBe("pro")
    expect(run?.campaignIdentity).toBe("pro")
    // No projected headline ⇒ the shell counts rows itself (1 of 2 passed).
    expect(run?.resolved).toBe(1)
    expect(run?.total).toBe(2)
    // No suite-owned preset label ⇒ the SWE fingerprint chain runs.
    expect(run?.preset).toBe("SERVER-SIDE-FALLBACK-LABEL")
  })

  test("a REFUSED artifact is dropped, never rendered under a guessed identity", () => {
    const { buildRun, calls } = loadDispatch(null)
    expect(buildRun("/runs/x.report.json", 123)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  // TB21-05 — "dropped silently" is indistinguishable from "never existed", so
  // the drop is RECORDED at the exact point it happens. This binds the LIVE
  // call: the injected port is the one server.ts reaches for.
  test("a REFUSED report artifact is RECORDED for the quarantine diagnostic", () => {
    const { buildRun, quarantined } = loadDispatch(null)
    expect(buildRun("/runs/old-tb.report.json", 123)).toBeNull()
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.file).toBe("/runs/old-tb.report.json")
    // The raw ARTIFACT goes with it, so a projector can claim its own refusals…
    expect(quarantined[0]?.raw).toEqual(ARTIFACT)
    // …and the real reason, not a generic one.
    expect((quarantined[0]?.error as Error).message).toBe("unidentifiable artifact")
  })

  test("PAIRED CONTROL: a SUCCESSFUL projection records no quarantine", () => {
    const { buildRun, quarantined } = loadDispatch({
      benchmarkSuite: "swe-bench",
      instanceRowKind: "swe-grade",
      viewId: "verified",
      campaignIdentity: "",
    })
    expect(buildRun("/runs/x.report.json", 123)).not.toBeNull()
    expect(quarantined).toEqual([])
  })

  test("a non-report JSON is dropped WITHOUT a quarantine line (not every file is a report)", () => {
    // `summary.json` / `closure-*.json` share the trove but are a different
    // schema entirely. Reporting each as "refused" would bury the real ones.
    const { buildRun, quarantined } = loadDispatch(null, { generatedAt: "x", boxes: [] })
    expect(buildRun("/runs/summary.json", 1)).toBeNull()
    expect(quarantined).toEqual([])
  })

  // -------------------------------------------------------------------------
  // MED-D — the consumer shape is split PER SUITE. A Terminal row must not carry
  // the SWE-only `fail` / `goldResolved` channels, and a SWE row must not carry
  // the Terminal-only infra-fault `error` channel. Observed on the rows the
  // server actually puts in the `/api/data` payload.
  // -------------------------------------------------------------------------

  /** One artifact whose rows carry BOTH suites' per-instance vocabularies, so a
   *  broad element type would happily keep every key on every row. */
  const MIXED_ARTIFACT = {
    timestamp: "2026-08-22T00:00:00.000Z",
    model: "gpt-5.5",
    knobs: { preset: "p" },
    perInstance: [
      {
        id: "row-a",
        passed: false,
        turns: 4,
        durationMs: 20,
        goldResolved: false,
        failure: { termination: "throttled" },
        error: { kind: "agent-crash" },
      },
      { id: "row-b", passed: true, turns: 1, durationMs: 5 },
    ],
  }

  const rowsFor = (instanceRowKind: string, viewId: string): Record<string, unknown>[] => {
    const { buildRun } = loadDispatch(
      { benchmarkSuite: "s", instanceRowKind, viewId, campaignIdentity: "id" },
      MIXED_ARTIFACT,
    )
    const run = buildRun("/runs/x.report.json", 1)
    return (run?.perInstance ?? []) as Record<string, unknown>[]
  }

  // TB21-05 — a suite that owns its per-instance channel supplies the rows
  // ITSELF (`ProjectedRun.rows`). The shell carries them verbatim and shapes
  // nothing: it must neither drop a suite field nor add a SWE one.
  test("a suite-owned run carries the PROJECTOR's rows verbatim, and no SWE channel", () => {
    const projectedRows = [
      { id: "trial-1", passed: true, taskId: "org/a", outcome: "graded_pass", costUsd: 0.5 },
      { id: "trial-2", passed: false, taskId: "org/a", outcome: "agent_crash", costUsd: null },
    ]
    const { buildRun } = loadDispatch(
      {
        benchmarkSuite: "terminal-bench",
        instanceRowKind: "trial-receipt",
        viewId: "terminal-bench",
        campaignIdentity: "id",
        rows: projectedRows,
        runPayload: { datasetRef: "pinned", metrics: { accuracy: 50 } },
      },
      // The artifact's OWN `perInstance` carries both suites' vocabularies; a
      // shell that still shaped rows would leak them onto the Terminal run.
      MIXED_ARTIFACT,
    )
    const run = buildRun("/runs/x.report.json", 1)
    expect(run?.perInstance).toEqual(projectedRows)
    for (const row of (run?.perInstance ?? []) as Record<string, unknown>[]) {
      expect("fail" in row).toBe(false)
      expect("goldResolved" in row).toBe(false)
      expect("error" in row).toBe(false)
    }
    // ...and the suite's per-run payload rides along untouched.
    expect(run?.suiteView).toEqual({ datasetRef: "pinned", metrics: { accuracy: 50 } })
  })

  test("a SWE run's rows carry NO Terminal-only infra-fault field", () => {
    const rows = rowsFor("swe-grade", "verified")
    expect(rows).toHaveLength(2)
    for (const row of rows) expect("error" in row).toBe(false)
    // ...while the SWE channels it DOES own survive (non-vacuity).
    expect(rows[0]?.goldResolved).toBe(false)
    expect((rows[0]?.fail as { termination: string } | null)?.termination).toBe("throttled")
    expect(rows[1]?.fail).toBeNull()
  })

  test("PAIRED CONTROL: the D1 denominator rule survives the split on BOTH suites", () => {
    // agent-crash is a re-runnable hole on Terminal (its own `error` channel)…
    const { buildRun: tb } = loadDispatch(
      {
        benchmarkSuite: "terminal-bench",
        instanceRowKind: "trial-receipt",
        viewId: "terminal-bench",
        campaignIdentity: "id",
      },
      MIXED_ARTIFACT,
    )
    const tbRun = tb("/runs/x.report.json", 1)
    expect(tbRun?.unmeasured).toBe(1)
    expect(tbRun?.total).toBe(1)
    // …and `throttled` is one on SWE (its own `fail.reRunnable` channel).
    const { buildRun: swe } = loadDispatch(
      {
        benchmarkSuite: "swe-bench",
        instanceRowKind: "swe-grade",
        viewId: "verified",
        campaignIdentity: "",
      },
      MIXED_ARTIFACT,
    )
    const sweRun = swe("/runs/x.report.json", 1)
    expect(sweRun?.unmeasured).toBe(1)
    expect(sweRun?.total).toBe(1)
  })
})

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
    benchmarkSuite: "swe-bench",
    instanceRowKind: "swe-grade",
    viewId: datasetFamily,
    datasetFamily,
    // BFND-03: what the SWE projector emits for this family — verified ⇒ "" (no
    // prefix, byte-identical legacy key), every other family ⇒ its own space.
    campaignIdentity: datasetFamily === "verified" ? "" : datasetFamily,
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

  // TB21-05 REVERSED the old D1 exclusion for Terminal.
  //
  // The pre-cutover rule dropped an `agent-crash` row from the denominator
  // ("a re-runnable infra hole, not a miss"). TB21-04's scorer does the
  // opposite: an errored trial earns no reward, so it scores ZERO and stays in
  // the official denominator. Keeping the dashboard exclusion made the campaign
  // rollup silently disagree with the artifact it was rendering — so a
  // suite-owned trial row now carries no re-runnable channel at all and every
  // trial counts, exactly as the scorer counted it.
  test("a CRASHED trial STAYS in the campaign denominator, with a PAIRED CONTROL", () => {
    const trialRow = (id: string, outcome: string): unknown => ({
      id,
      passed: outcome === "graded_pass",
      taskId: "org/task",
      outcome,
    })
    const runWith = (rows: unknown[]): unknown => ({
      label: "tb-camp",
      file: "/runs/tb-camp.report.json",
      model: "m",
      preset: "p",
      mtime: 1,
      benchmarkSuite: "terminal-bench",
      instanceRowKind: "trial-receipt",
      viewId: "terminal-bench",
      campaignIdentity: "terminal-bench@2.1 ref",
      perInstance: rows,
    })
    const crashed = firstCampaign([
      runWith([
        trialRow("a", "graded_pass"),
        trialRow("b", "graded_fail"),
        trialRow("c", "agent_crash"),
      ]),
    ])
    expect(crashed.resolved).toBe(1)
    // 3, not 2 — the crash is a scored zero. This is the number TB21-04's
    // `officialShapedTotals` produces for the same trial set.
    expect(crashed.total).toBe(3)
    expect(crashed.unmeasured).toBe(0)

    // CONTROL: an agent-TIMEOUT behaves identically — there is no longer a
    // privileged error class, which is the whole point of the reversal.
    const timedOut = firstCampaign([
      runWith([
        trialRow("a", "graded_pass"),
        trialRow("b", "graded_fail"),
        trialRow("c", "agent_timeout"),
      ]),
    ])
    expect(timedOut.resolved).toBe(1)
    expect(timedOut.total).toBe(3)
    expect(timedOut.unmeasured).toBe(0)

    // PAIRED CONTROL on the OTHER suite: the SWE re-runnable rule is untouched,
    // so this reversal did not quietly delete the FLAG-B hole exclusion.
    const throttled = firstCampaign([
      makeRun("swe-camp", [passRow("repo-1"), failRow("repo-2", "throttled")]),
    ])
    expect(throttled.total).toBe(1)
    expect(throttled.unmeasured).toBe(1)
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
    const src = SUITE_DISPATCH_PRELUDE.concat([
      extractFn("renderCards"),
      "renderCards(); return null;",
    ]).join("\n")
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

// The `tbOurResults` any-pass fold (a task's trials collapsed into one boolean
// across runs and arms, with agent-crash excluded) was DELETED by TB21-05: it is
// the optimistic union the ticket forbids, and its crash exclusion contradicted
// TB21-04's denominator. Its replacement is the per-TRIAL distribution, tested
// against the real shipped bundle in `projectors/terminal-bench.client.test.ts`.

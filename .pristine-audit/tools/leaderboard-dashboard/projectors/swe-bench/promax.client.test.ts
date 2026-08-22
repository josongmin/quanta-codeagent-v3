/**
 * PMX-05 — the ProMax family view, as the browser actually receives it.
 *
 * Everything below evaluates the REAL shipped strings: `renderDashboardPage()`
 * gives the exact bytes the browser gets, and the ProMax bundle is only
 * extractable from them because the page really ships it. Nothing here
 * re-implements a render function.
 *
 * The properties under test are the ticket's dashboard rules:
 *   - the headline cards show `assigned` and `coverage` BESIDE the score;
 *   - the three rates are always rendered together;
 *   - the language table walks the assigned manifest INCLUDING invalid/missing;
 *   - the reason drilldown reaches golden failures, model timeouts, image
 *     failures and human review;
 *   - a filter (or a display bug) CANNOT drop invalid rows from assigned;
 *   - `pro` and `promax` never render as one thing.
 */
import { describe, expect, test } from "bun:test"
import {
  buildOfficialGradeReceipt,
  type OfficialGradeDisposition,
  type OfficialGradeEvaluatorMeta,
  type OfficialGradeReason,
  type OfficialGradeState,
} from "@/runner/batch/eval/official-grade"
import {
  aggregateOfficialGrade,
  formatOfficialGradeTotals,
  OFFICIAL_GRADE_RATE_UNAVAILABLE,
} from "@/runner/batch/report-official-grade"
import { renderDashboardPage } from "../../page"
import { sweBenchProjector } from "../swe-bench"

/** The REAL page bytes the browser receives. */
const PAGE = renderDashboardPage({ tracePort: 4318 })

const slice = (re: RegExp, what: string): string => {
  const m = PAGE.match(re)
  if (!m) throw new Error(`${what} not found in the rendered dashboard page`)
  return m[0]
}

/** Brace-match a `function name(` declaration out of the shipped page. */
const extractFn = (name: string, src: string = PAGE): string => {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`fn ${name} not found in the shipped page`)
  let depth = 0
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1
    else if (src[i] === "}") {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`fn ${name} unbalanced`)
}

const escSource = (): string => slice(/function esc\([^)]*\)\s*\{[^\n]*\}/, "esc")

// ── the canonical fixture, aggregated by the REAL owner ─────────────────────

const hex = (seed: string): string =>
  Array.from(
    { length: 64 },
    (_, i) => "0123456789abcdef"[(seed.charCodeAt(i % seed.length) + i) % 16],
  ).join("")

const EVALUATOR: OfficialGradeEvaluatorMeta = {
  evaluatorId: "swe-bench-promax",
  upstreamCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
  evaluatorPath: "/opt/promax/test_run.py",
  evaluatorSha256: hex("evaluator"),
  argv: ["python", "test_run.py"],
  cwd: "/opt/promax",
  exitCode: 0,
  stdout: "",
  stderr: "",
  outputArtifact: null,
}

const dispose = (
  id: string,
  state: OfficialGradeState,
  reason: OfficialGradeReason,
): OfficialGradeDisposition => ({
  instanceId: id,
  state,
  reason,
  gradingValid: state === "resolved" || state === "model_miss",
  rawArtifact: { path: `/a/${id}.json`, sha256: hex(id), byteLength: 8 },
  evaluator: { passed: state === "resolved", model: null, golden: null },
})

const LANGUAGES = ["C", "C++", "Go", "Java", "Python", "Rust", "TypeScript"] as const

/**
 * 170 assigned. 65 resolved, 100 model_miss (3 of them model timeouts), 2 golden
 * failures, 1 evaluator/image failure, 1 human-review, 1 never graded.
 */
const officialGradeView = (): { totals: unknown; display: unknown } => {
  const ids = Array.from({ length: 170 }, (_, i) => `org__repo-${String(i).padStart(4, "0")}`)
  const plan: (readonly [OfficialGradeState, OfficialGradeReason])[] = []
  for (let i = 0; i < 65; i += 1) plan.push(["resolved", "official_resolved"])
  for (let i = 0; i < 97; i += 1) plan.push(["model_miss", "test_failed"])
  for (let i = 0; i < 3; i += 1) plan.push(["model_miss", "model_eval_timeout"])
  for (let i = 0; i < 2; i += 1) plan.push(["infra_invalid", "golden_apply_failed"])
  plan.push(["infra_invalid", "evaluator_unavailable"])
  plan.push(["ambiguous", "upstream_need_human_review"])
  // plan.length === 169 over a 170-id manifest ⇒ exactly one derived `missing`.
  const built = buildOfficialGradeReceipt({
    assignedInstanceIds: ids,
    dispositions: plan.map(([state, reason], i) => dispose(ids[i] ?? "", state, reason)),
    evaluator: EVALUATOR,
  })
  if (!built.ok) throw new Error(`fixture refused: ${JSON.stringify(built.failures)}`)
  const section = aggregateOfficialGrade({
    receipt: built.receipt,
    instanceMeta: new Map(
      ids.map((id, i) => [id, { language: LANGUAGES[i % LANGUAGES.length] ?? "unknown" }]),
    ),
    campaign: { quantaSha: "abc", quantaDirty: false, provider: "openai", model: "gpt-5.5" },
  })
  return { totals: section.totals, display: formatOfficialGradeTotals(section.totals) }
}

const VIEW = officialGradeView()
const DISPLAY = VIEW.display as ReturnType<typeof formatOfficialGradeTotals>

const promaxRun = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  label: "promax-170",
  file: "/runs/promax-170.report.json",
  model: "gpt-5.5",
  preset: "promax-v1",
  benchmarkSuite: "swe-bench",
  viewId: "promax",
  datasetFamily: "promax",
  mtime: 2,
  resolved: 65,
  total: 170,
  unmeasured: 0,
  officialGrade: VIEW,
  perInstance: [],
  ...over,
})

const proRun = (): Record<string, unknown> => ({
  label: "pro-run",
  file: "/runs/pro-run.report.json",
  model: "gpt-5.5",
  preset: "pro",
  benchmarkSuite: "swe-bench",
  viewId: "pro",
  datasetFamily: "pro",
  mtime: 9,
  resolved: 1,
  total: 2,
  unmeasured: 0,
  perInstance: [{ id: "pro-a", passed: true, turns: 1, durationMs: 1, fail: null }],
})

// ── the harness: run the SHIPPED bundle through the SHELL's dispatch ─────────

interface Sinks {
  cards: string
  pmxtable: string
  pmxcount: string
  famCardsCalled: number
}

/**
 * Build a scope containing the page's real `esc`, the real SWE client bundle
 * (prelude + ProMax), and the page's real `renderCards` — then dispatch through
 * `renderCards()` exactly as the shell does. Nothing is stubbed except the sinks
 * and the OTHER families' fallback renderer, so a broken registration, a broken
 * `famView`, or a shell that stopped dispatching all show up as a failure.
 */
function runShell(bench: string, DATA: unknown, call = "renderCards();"): Sinks {
  const sinks: Sinks = { cards: "", pmxtable: "", pmxcount: "", famCardsCalled: 0 }
  const store: Record<string, string> = {}
  const doc = {
    getElementById(id: string) {
      return {
        set innerHTML(v: string) {
          if (id === "cards") sinks.cards = v
          if (id === "pmxtable") sinks.pmxtable = v
          if (id === "view") store.view = v
          store[id] = v
        },
        set textContent(v: string) {
          if (id === "pmxcount") sinks.pmxcount = v
        },
        get value() {
          return ""
        },
        set onchange(_fn: unknown) {},
      }
    },
    querySelectorAll() {
      return { forEach() {} }
    },
  }
  const src = [
    `var BENCH = ${JSON.stringify(bench)};`,
    "var SUITE_VIEWS = {};",
    escSource(),
    sweBenchProjector.client.script,
    extractFn("suiteOfView"),
    extractFn("suiteView"),
    "function renderFamCards(){ FAM_CARDS.n += 1; }",
    "function renderFamMatrix(v){ FAM_CARDS.m += 1; }",
    extractFn("renderCards"),
    call,
  ].join("\n")
  const famCards = { n: 0, m: 0 }
  new Function("DATA", "document", "FAM_CARDS", src)(DATA, doc, famCards)
  sinks.famCardsCalled = famCards.n
  return sinks
}

const dataWith = (runs: unknown[]): Record<string, unknown> => ({
  runs,
  campaigns: [],
  benchmarks: [
    { id: "verified", label: "SWE-bench Verified", suite: "swe-bench" },
    { id: "pro", label: "SWE-bench Pro", suite: "swe-bench" },
    { id: "promax", label: "SWE-bench ProMax", suite: "swe-bench" },
  ],
})

/** Pull the big number out of the card carrying `label`. */
const cardValue = (html: string, label: string): string => {
  for (const card of html.split('<div class="card">').slice(1)) {
    if (card.includes(`>${label}<`)) {
      const m = card.match(/<div class="n">([\s\S]*?)<\/div>/)
      if (m?.[1] !== undefined) return m[1]
    }
  }
  throw new Error(`card ${label} not found in: ${html.slice(0, 600)}`)
}

// ── wiring: the shell really dispatches to the registered family view ───────

describe("PMX-05 dashboard — ONE family registration, dispatched by the shell", () => {
  test("the page SHIPS the ProMax bundle and the generic family dispatch", () => {
    expect(PAGE).toContain('SWE_FAMILY_VIEWS["promax"]')
    expect(PAGE).toContain("function famView()")
    // ...and the shell itself still names no family (that is the whole point).
    expect(extractFn("renderCards")).not.toContain("promax")
  })

  test("BENCH=promax renders the FAMILY view, not the generic family fold", () => {
    const sinks = runShell("promax", dataWith([promaxRun()]))
    expect(sinks.famCardsCalled).toBe(0)
    expect(sinks.cards).toContain("해결 / 유효채점")
    // CONTROL: an unregistered family falls through to the shell's generic fold,
    // proving the dispatch is a lookup and not "always ProMax".
    const pro = runShell("pro", dataWith([proRun()]))
    expect(pro.famCardsCalled).toBe(1)
    expect(pro.cards).toBe("")
  })

  test("NO external baseline is invented for ProMax", () => {
    // The ticket forbids inventing an external comparison until a compatible
    // official result source is defined. The shell's external-SOTA mapping is
    // pro/live only, and ProMax must fall through it to null.
    const coord = new Function(`${extractFn("extCoordFor")}\nreturn extCoordFor;`)() as (
      fam: string,
    ) => unknown
    expect(coord("promax")).toBeNull()
    expect(coord("verified")).toBeNull()
    // Non-vacuity: the mapping is real for the families that DO have one.
    expect(coord("pro")).not.toBeNull()
    expect(coord("live")).not.toBeNull()
  })

  test("ONE artifact's persisted totals — never a union across runs", () => {
    // The server hands DATA.runs sorted by mtime desc; the view reads the FIRST
    // ProMax artifact and formats it. A union across runs would be a second
    // aggregation with a denominator nobody persisted.
    const older = JSON.parse(JSON.stringify(VIEW)) as { display: Record<string, string> }
    older.display.assigned = "40"
    older.display.score = "9 / 40"
    const sinks = runShell(
      "promax",
      dataWith([promaxRun(), promaxRun({ label: "promax-40", officialGrade: older })]),
    )
    expect(cardValue(sinks.cards, "assigned")).toBe("170")
    expect(cardValue(sinks.cards, "해결 / 유효채점")).toBe(DISPLAY.score)
    // ...and the OTHER order really does select the other artifact (non-vacuity:
    // it is reading position 0, not hardcoding the big one).
    const flipped = runShell(
      "promax",
      dataWith([promaxRun({ label: "promax-40", officialGrade: older }), promaxRun()]),
    )
    expect(cardValue(flipped.cards, "assigned")).toBe("40")
  })

  test("`pro` and `promax` never render together", () => {
    // Both families present; the ProMax view must see ONLY its own artifact.
    const sinks = runShell("promax", dataWith([proRun(), promaxRun()]))
    expect(cardValue(sinks.cards, "assigned")).toBe("170")
    expect(sinks.cards).not.toContain("pro-run")
    // ...and with ONLY a pro run present, the ProMax view says so rather than
    // borrowing pro's numbers.
    const empty = runShell("promax", dataWith([proRun()]))
    expect(empty.cards).toContain("promax 공식채점 리포트 없음")
    expect(empty.cards).not.toContain("170")
  })
})

// ── the headline: assigned + coverage beside the score ─────────────────────

describe("PMX-05 dashboard — headline cards read PERSISTED totals", () => {
  test("assigned and coverage sit beside the score, and all three rates are shown", () => {
    const sinks = runShell("promax", dataWith([promaxRun()]))
    expect(cardValue(sinks.cards, "해결 / 유효채점")).toBe(DISPLAY.score)
    expect(cardValue(sinks.cards, "assigned")).toBe(DISPLAY.assigned)
    expect(cardValue(sinks.cards, "커버리지")).toBe(DISPLAY.coverage)
    expect(cardValue(sinks.cards, "공식 유효 해결률")).toBe(DISPLAY.official_valid_rate)
    expect(cardValue(sinks.cards, "raw 해결률")).toBe(DISPLAY.raw_rate)
    expect(cardValue(sinks.cards, "미채점")).toBe(DISPLAY.missing)
    // The invalid rows are VISIBLE, not folded away.
    expect(cardValue(sinks.cards, "무효/모호")).toBe(
      `${DISPLAY.infra_invalid} / ${DISPLAY.ambiguous}`,
    )
  })

  test("the three rates are ADJACENT in the rendered card strip", () => {
    const sinks = runShell("promax", dataWith([promaxRun()]))
    const labels = [...sinks.cards.matchAll(/<div class="l">([^<]*)<\/div>/g)].map((m) => m[1])
    const valid = labels.indexOf("공식 유효 해결률")
    expect(valid).toBeGreaterThanOrEqual(0)
    expect(labels[valid + 1]).toBe("커버리지")
    expect(labels[valid + 2]).toBe("raw 해결률")
  })

  test("the cards FORMAT the persisted totals — they do not fold rows", () => {
    // A run whose per-instance rows say something completely different. If the
    // view folded rows the assigned count would move.
    const lying = promaxRun({
      perInstance: [{ id: "x", passed: true, turns: 1, durationMs: 1, fail: null }],
      resolved: 999,
      total: 1,
    })
    const sinks = runShell("promax", dataWith([lying]))
    expect(cardValue(sinks.cards, "assigned")).toBe("170")
    expect(cardValue(sinks.cards, "해결 / 유효채점")).toBe(DISPLAY.score)
  })

  test("a zero denominator reads as UNAVAILABLE, never as 0% success", () => {
    const zeroed = JSON.parse(JSON.stringify(VIEW)) as {
      display: Record<string, string>
    }
    zeroed.display.official_valid_rate = `${OFFICIAL_GRADE_RATE_UNAVAILABLE} (0/0)`
    const sinks = runShell("promax", dataWith([promaxRun({ officialGrade: zeroed })]))
    expect(cardValue(sinks.cards, "공식 유효 해결률")).toContain(OFFICIAL_GRADE_RATE_UNAVAILABLE)
    expect(cardValue(sinks.cards, "공식 유효 해결률")).not.toContain("%")
  })
})

// ── the drilldowns, and the filter that must not reach the totals ──────────

describe("PMX-05 dashboard — drilldowns and the filter fence", () => {
  const drawn = (filter: string): Sinks =>
    runShell(
      "promax",
      dataWith([promaxRun()]),
      `PMX_FILTER.state = ${JSON.stringify(filter)}; renderCards(); drawPromaxMatrix();`,
    )

  test("the reason drilldown exposes golden failures, model timeouts, image failures and human review", () => {
    const sinks = drawn("all")
    for (const reason of [
      "golden_apply_failed",
      "model_eval_timeout",
      "evaluator_unavailable",
      "upstream_need_human_review",
    ]) {
      expect(sinks.pmxtable).toContain(reason)
    }
    expect(sinks.pmxcount).toBe("6 reason")
  })

  test("the language table walks the assigned manifest INCLUDING invalid and missing rows", () => {
    const sinks = drawn("all")
    for (const language of LANGUAGES) expect(sinks.pmxtable).toContain(language)
    // Per-language assigned must sum back to the campaign's assigned.
    const rows = DISPLAY.languages
    expect(rows.reduce((a, r) => a + r.assigned, 0)).toBe(170)
    // The invalid / missing columns are rendered, not omitted.
    const withMissing = rows.find((r) => r.missing > 0)
    expect(withMissing).toBeDefined()
    const withInvalid = rows.find((r) => r.infra_invalid > 0)
    expect(withInvalid).toBeDefined()
    expect(sinks.pmxtable).toContain("무효/미채점 포함")
  })

  test("RED-ON-INJECTION: mutating the drilldown filter leaves the persisted totals UNMOVED", () => {
    const all = drawn("all")
    const onlyResolved = drawn("resolved")
    // The filter really bit — the drilldown shrank…
    expect(onlyResolved.pmxcount).toBe("1 reason")
    expect(onlyResolved.pmxtable).not.toContain("golden_apply_failed")
    expect(all.pmxtable).not.toBe(onlyResolved.pmxtable)
    // …and the headline cards are BYTE-IDENTICAL, so no filter can drop an
    // invalid or missing row out of `assigned`.
    expect(onlyResolved.cards).toBe(all.cards)
    expect(cardValue(onlyResolved.cards, "assigned")).toBe("170")
    expect(cardValue(onlyResolved.cards, "무효/모호")).toBe("3 / 1")
    // Every filter value, same invariant.
    for (const f of ["model_miss", "infra_invalid", "ambiguous"]) {
      expect(drawn(f).cards).toBe(all.cards)
    }
  })

  test("the language table is not reachable by the reason filter either", () => {
    // The languages block is rendered from the same persisted display regardless
    // of which reasons the drilldown is showing.
    const all = drawn("all")
    const filtered = drawn("ambiguous")
    const langBlock = (html: string): string => html.slice(html.indexOf("언어별"))
    expect(langBlock(filtered.pmxtable)).toBe(langBlock(all.pmxtable))
  })
})

// ── escaping ────────────────────────────────────────────────────────────────

describe("PMX-05 dashboard — every report-derived string is escaped", () => {
  test("a hostile preset / language cannot break out of innerHTML", () => {
    const hostile = `</style><script>alert(1)</script>`
    const view = JSON.parse(JSON.stringify(VIEW)) as {
      display: { languages: { language: string }[]; reasons: { reason: string }[] }
    }
    const firstLang = view.display.languages[0]
    const firstReason = view.display.reasons[0]
    if (firstLang === undefined || firstReason === undefined) throw new Error("empty display")
    firstLang.language = hostile
    firstReason.reason = hostile
    const sinks = runShell(
      "promax",
      dataWith([promaxRun({ preset: hostile, officialGrade: view })]),
      "renderCards(); drawPromaxMatrix();",
    )
    for (const html of [sinks.cards, sinks.pmxtable]) {
      expect(html).not.toContain("<script>alert(1)</script>")
      expect(html).toContain("&lt;script&gt;")
    }
  })
})

/**
 * TB21-05 — the Terminal-Bench 2.1 CLIENT render layer.
 *
 * These tests evaluate the REAL shipped string (the exact bytes the browser
 * receives out of `page.ts`) against hostile DATA payloads — not a
 * re-implementation.
 *
 * The suite this REPLACES asserted the opposite of the cutover: it pinned an
 * any-pass ✅/❌ fold as the per-task verdict, a `해결 / 실행` union card as the
 * headline, and a TB **2.0** competitor matrix as the comparison column. Every
 * one of those is now a rail in the other direction:
 *
 *  - a pass + a fail on ONE task renders `1/2`, never a check mark;
 *  - a crash trial stays in the denominator and in the cards;
 *  - two profiles stay two independently scored rows;
 *  - the cards read PERSISTED `metrics`, and the browser divides nothing;
 *  - the external per-task column renders `—`, never a stale 2.0 rate.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderDashboardPage } from "../page"
import { terminalBenchProjector } from "./terminal-bench"

/** The REAL page bytes the browser receives (see `page.ts`), so the `esc` helper
 *  sliced below is the shipped one and not a copy of it. */
const PAGE = renderDashboardPage({ tracePort: 4318 })

/** The dashboard's real `esc` helper, sliced from the shipped page. */
const escSource = (): string => {
  const m = PAGE.match(/function esc\([^)]*\)\s*\{[^\n]*\}/)
  if (!m) throw new Error("esc not found in the rendered dashboard page")
  return m[0]
}

const HOSTILE = `</style><script>alert(1)</script>`

interface Sinks {
  cards: string
  tbtable: string
  tbcount: string
  view: string
}

/** A DOM double good enough for the shipped bundle's real render path. */
function fakeDocument(sinks: Sinks) {
  const node = (id: string) => ({
    set innerHTML(v: string) {
      if (id === "cards") sinks.cards = v
      if (id === "tbtable") sinks.tbtable = v
      if (id === "view") sinks.view = v
    },
    set textContent(v: string) {
      if (id === "tbcount") sinks.tbcount = v
    },
    get value() {
      return ""
    },
    set oninput(_: unknown) {},
    set onchange(_: unknown) {},
    set onclick(_: unknown) {},
    querySelectorAll() {
      return { forEach() {} }
    },
  })
  return {
    getElementById: (id: string) => node(id),
    querySelectorAll() {
      return { forEach() {} }
    },
  }
}

/** Run one function out of the shipped Terminal client bundle against `DATA`. */
function runClient(call: string, DATA: unknown): Sinks {
  const sinks: Sinks = { cards: "", tbtable: "", tbcount: "", view: "" }
  const src = [
    "var SUITE_VIEWS = {};",
    escSource(),
    terminalBenchProjector.client.script,
    call,
  ].join("\n")
  new Function("DATA", "document", src)(DATA, fakeDocument(sinks))
  return sinks
}

/** Evaluate an expression inside the shipped bundle's scope. */
function evalClient<T>(expr: string, DATA: unknown): T {
  const sinks: Sinks = { cards: "", tbtable: "", tbcount: "", view: "" }
  const src = [
    "var SUITE_VIEWS = {};",
    escSource(),
    terminalBenchProjector.client.script,
    `return (${expr});`,
  ].join("\n")
  return new Function("DATA", "document", src)(DATA, fakeDocument(sinks)) as T
}

/** Pull the big number out of the card carrying `label`. */
function cardValue(html: string, label: string): string {
  const cards = html.split('<div class="card">').slice(1)
  for (const card of cards) {
    if (card.includes(`>${label}<`)) {
      const m = card.match(/<div class="n">([\s\S]*?)<\/div>/)
      if (m) return m[1]!
    }
  }
  throw new Error(`card ${label} not found in: ${html.slice(0, 600)}`)
}

// ---------------------------------------------------------------------------
// Fixtures — shaped exactly as `server.ts` puts them in `/api/data`.
// ---------------------------------------------------------------------------

const trialRow = (
  taskId: string,
  outcome: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: `${taskId}-${outcome}-${String(over.id ?? "")}`,
  passed: outcome === "graded_pass",
  turns: 0,
  durationMs: 300_000,
  taskId,
  taskName: taskId.split("/")[1],
  outcome,
  reward: outcome === "graded_pass" ? 1 : outcome === "graded_fail" ? 0 : null,
  costUsd: 0.5,
  harborJobId: "job-1",
  trajectoryPath: `/jobs/${taskId}/trajectory.json`,
  ...over,
})

const metrics = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  accuracy: 50,
  accuracyStderr: 12.5,
  displayAccuracy: "**50.0%** ± 12.5%",
  nTrials: 2,
  passAtK: { 2: 0.75, 3: 0.8, 4: 0.85, 5: 0.9 },
  uncachedInputTokens: 1000,
  cachedInputTokens: 100,
  outputTokens: 50,
  totalCostUsd: 1.0,
  displayTotalCostUsd: "$1.00",
  avgTrialDurationSec: 300,
  rewardHacks: 0,
  ...over,
})

const admission = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  verdict: "incomplete",
  complete: false,
  standardConfig: true,
  promotable: false,
  k: 2,
  expectedTaskCount: 89,
  observedTaskCount: 1,
  expectedTrials: 178,
  admittedTrials: 2,
  duplicateTrialIds: [],
  rejections: [],
  reasons: ["tasks:1/89"],
  ...over,
})

const tbRun = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const view = (over.suiteView as Record<string, unknown>) ?? {}
  return {
    label: "tb-run",
    file: "/runs/tb-run.report.json",
    model: "gpt-5.5",
    preset: "terminal-bench-2.1/quanta-full",
    benchmarkSuite: "terminal-bench",
    instanceRowKind: "trial-receipt",
    viewId: "terminal-bench",
    campaignIdentity: "terminal-bench@2.1 sha256:pinned profile=quanta-full",
    arm: "quanta-full",
    mtime: 1000,
    resolved: 1,
    total: 2,
    unmeasured: 0,
    perInstance: [
      trialRow("terminal-bench/task-a", "graded_pass", { id: "1" }),
      trialRow("terminal-bench/task-a", "graded_fail", { id: "2" }),
    ],
    ...over,
    suiteView: {
      benchmarkVersion: "2.1",
      dataset: "terminal-bench/terminal-bench-2-1",
      datasetRef: "sha256:pinned",
      timestamp: "2026-08-22T01:00:00.000Z",
      arm: "quanta-full",
      k: 2,
      profile: "quanta-full",
      provider: "openai",
      reasoningEffort: "xhigh",
      sandbox: "docker",
      model: "gpt-5.5",
      harborVersion: "0.21.0",
      quantaSha: "8cdf4badbe83",
      dirty: false,
      agentVersion: "1.0.025+g8cdf4badbe83",
      concurrency: 4,
      taskSelection: "full",
      admission: admission(),
      metrics: metrics(),
      outcomes: {
        graded_pass: 1,
        graded_fail: 1,
        agent_timeout: 0,
        agent_crash: 0,
        environment_error: 0,
        verifier_error: 0,
        missing_reward: 0,
        malformed_result: 0,
      },
      defects: 0,
      harborJobIds: ["job-1"],
      ...view,
    },
  }
}

const official = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "rawdata", "terminal-bench-official.json"), "utf8"),
) as Record<string, unknown>

const dataWith = (
  runs: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  runs,
  campaigns: [],
  quarantine: [],
  tb: { schemaVersion: "terminal-bench-dashboard/v2", official: null },
  ...extra,
})

// ---------------------------------------------------------------------------

describe("TB21-05 client — registration", () => {
  test("the bundle registers itself under its suite id (a live registration)", () => {
    const views = evalClient<Record<string, Record<string, unknown>>>("SUITE_VIEWS", null)
    expect(Object.keys(views)).toEqual(["terminal-bench"])
    const view = views["terminal-bench"]!
    expect(typeof view.cards).toBe("function")
    expect(typeof view.scaffolds).toBe("function")
    expect(typeof view.matrix).toBe("object")
  })

  test("Terminal runs are selected by SUITE, never by a dataset family", () => {
    const swe = tbRun({
      benchmarkSuite: "swe-bench",
      viewId: "verified",
      datasetFamily: "terminal-bench",
    })
    expect(evalClient<unknown[]>("tbRuns()", dataWith([swe]))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Summary cards — persisted metrics, per run, nothing unioned.
// ---------------------------------------------------------------------------

describe("TB21-05 client — summary cards read PERSISTED metrics", () => {
  const cardsFor = (runs: unknown[], extra: Record<string, unknown> = {}): string =>
    runClient("renderTbCards(); return null;", dataWith(runs, extra)).cards

  test("accuracy ± standard error is the artifact's own display string", () => {
    expect(cardValue(cardsFor([tbRun()]), "정확도")).toBe("**50.0%** ± 12.5%")
  })

  test("CONTROL: flipping raw per-trial verdicts does NOT move the accuracy card", () => {
    const run = tbRun()
    for (const row of run.perInstance as { passed: boolean; outcome: string }[]) {
      row.passed = true
      row.outcome = "graded_pass"
    }
    expect(cardValue(cardsFor([run]), "정확도")).toBe("**50.0%** ± 12.5%")
  })

  test("PAIR: moving the persisted metric DOES move the card (not a frozen literal)", () => {
    const run = tbRun({
      suiteView: { metrics: metrics({ displayAccuracy: "**91.0%** ± 1.0%" }) },
    })
    expect(cardValue(cardsFor([run]), "정확도")).toBe("**91.0%** ± 1.0%")
  })

  test("trials present/expected and task coverage come from the persisted admission", () => {
    const cards = cardsFor([tbRun()])
    expect(cardValue(cards, "trial 수집")).toBe("2 / 178")
    expect(cardValue(cards, "task 커버리지")).toBe("1 / 89")
  })

  test("pass@2..5 is rendered when k supports it, and — when it does not", () => {
    expect(cardValue(cardsFor([tbRun()]), "pass@2..5")).toContain("0.75")
    const k1 = tbRun({ suiteView: { k: 1, admission: admission({ k: 1 }) } })
    expect(cardValue(cardsFor([k1]), "pass@2..5")).toBe("—")
  })

  test("an INCOMPLETE run's pass@k is shown but NOT labelled official", () => {
    // Caught by running the real dashboard: a 1-trial k=5 run persists
    // pass@5 = 0 (five trials do not exist), and the card called it "공식 pass@k".
    const cards = cardsFor([tbRun()])
    expect(cards).toContain("공식 pass@k 아님")
    expect(cards).not.toContain(">공식 pass@k<")
    // PAIRED CONTROL: a COMPLETE run labels the same numbers official.
    const complete = tbRun({
      suiteView: {
        admission: admission({ verdict: "official", complete: true, promotable: true }),
      },
    })
    const completeCards = cardsFor([complete])
    expect(completeCards).toContain(">공식 pass@k<")
    expect(completeCards).not.toContain("공식 pass@k 아님")
  })

  test("graded pass/fail AND error counts come from the eight-class tally", () => {
    const run = tbRun({
      suiteView: {
        outcomes: {
          graded_pass: 3,
          graded_fail: 2,
          agent_timeout: 1,
          agent_crash: 1,
          environment_error: 1,
          verifier_error: 0,
          missing_reward: 1,
          malformed_result: 0,
        },
      },
    })
    const cards = cardsFor([run])
    expect(cardValue(cards, "graded pass / fail")).toBe("3 / 2")
    // Every non-graded class is an error: timeout + crash + env + missing = 4.
    expect(cardValue(cards, "에러 trial")).toBe("4")
  })

  test("cost, tokens and average duration are persisted values", () => {
    const cards = cardsFor([tbRun()])
    expect(cardValue(cards, "총 비용")).toBe("$1.00")
    expect(cardValue(cards, "평균 trial 시간")).toContain("300")
    expect(cards).toContain("1,150")
  })

  test("promotable / complete / standard status is shown from the admission verdict", () => {
    expect(cardValue(cardsFor([tbRun()]), "상태")).toContain("incomplete")
    const official = tbRun({
      suiteView: {
        admission: admission({
          verdict: "official",
          complete: true,
          promotable: true,
          observedTaskCount: 89,
          admittedTrials: 178,
          reasons: [],
        }),
      },
    })
    const cards = cardsFor([official])
    expect(cardValue(cards, "상태")).toContain("official")
    expect(cards).toContain("promotable")
  })

  test("a REJECTED run publishes NO accuracy — never a fabricated zero", () => {
    const rejected = tbRun({
      suiteView: {
        metrics: null,
        admission: admission({ verdict: "rejected", duplicateTrialIds: ["t1"] }),
      },
    })
    expect(cardValue(cardsFor([rejected]), "정확도")).toBe("—")
    expect(cardValue(cardsFor([rejected]), "상태")).toContain("rejected")
  })

  test("no Terminal runs ⇒ graceful — (never a fabricated 0/0 score)", () => {
    const cards = cardsFor([])
    expect(cardValue(cards, "정확도")).toBe("—")
    expect(cards).toContain("terminal-bench 리포트 없음")
  })

  test("the provenance strip shows dataset ref, harbor/agent version, sha, model, effort, sandbox", () => {
    const cards = cardsFor([tbRun()])
    for (const fact of [
      "sha256:pinned",
      "0.21.0",
      "8cdf4badbe83",
      "1.0.025+g8cdf4badbe83",
      "openai/gpt-5.5",
      "xhigh",
      "docker",
      "quanta-full",
    ]) {
      expect(cards).toContain(fact)
    }
  })
})

// ---------------------------------------------------------------------------
// Two profiles stay two rows.
// ---------------------------------------------------------------------------

describe("TB21-05 client — runs are scored INDEPENDENTLY (no baseline ∪ levers)", () => {
  const twoProfiles = (): unknown[] => [
    tbRun({
      label: "tb-control",
      preset: "terminal-bench-2.1/control",
      arm: "control",
      mtime: 2000,
      campaignIdentity: "terminal-bench@2.1 sha256:pinned profile=control",
      suiteView: {
        profile: "control",
        arm: "control",
        metrics: metrics({ displayAccuracy: "**10.0%** ± 3.0%", accuracy: 10 }),
      },
    }),
    tbRun({
      label: "tb-full",
      mtime: 1000,
      suiteView: { metrics: metrics({ displayAccuracy: "**80.0%** ± 4.0%", accuracy: 80 }) },
    }),
  ]

  test("each profile appears as its OWN scored row with its OWN accuracy", () => {
    const { cards } = runClient("renderTbCards(); return null;", dataWith(twoProfiles()))
    expect(cards).toContain("**10.0%** ± 3.0%")
    expect(cards).toContain("**80.0%** ± 4.0%")
    expect(cards).toContain("control")
    expect(cards).toContain("quanta-full")
  })

  test("no card unions the two runs into one number", () => {
    const { cards } = runClient("renderTbCards(); return null;", dataWith(twoProfiles()))
    // A union of 10% and 80% would show up as some third number. The only
    // accuracies on the page are the two persisted ones.
    const shown = [...cards.matchAll(/\*\*([\d.]+)%\*\*/g)].map((m) => m[1])
    expect([...new Set(shown)].sort()).toEqual(["10.0", "80.0"])
  })

  test("runs of DIFFERENT dataset refs are never merged into one row", () => {
    const runs = [
      tbRun({ label: "a", mtime: 2000 }),
      tbRun({
        label: "b",
        mtime: 1000,
        campaignIdentity: "terminal-bench@2.1 sha256:other profile=quanta-full",
        suiteView: { datasetRef: "sha256:other" },
      }),
    ]
    const { cards } = runClient("renderTbCards(); return null;", dataWith(runs))
    expect(cards).toContain("sha256:pinned")
    expect(cards).toContain("sha256:other")
    // ...and each carries its own row, so nothing coalesced.
    expect(evalClient<unknown[]>("tbRuns()", dataWith(runs))).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Per-task matrix — trial distribution, not a check mark.
// ---------------------------------------------------------------------------

describe("TB21-05 client — the per-task matrix shows the trial distribution", () => {
  const matrixFor = (runs: unknown[], extra: Record<string, unknown> = {}): string =>
    runClient("drawTbMatrix(); return null;", dataWith(runs, extra)).tbtable

  test("a pass + a fail on ONE task renders 1/2 (50%), never a check mark", () => {
    const html = matrixFor([tbRun()])
    expect(html).toContain("1/2")
    expect(html).toContain("50%")
    expect(html).not.toContain("✅")
  })

  test("PAIRED CONTROL: two passes render 2/2 (100%)", () => {
    const run = tbRun({
      perInstance: [
        trialRow("terminal-bench/task-a", "graded_pass", { id: "1" }),
        trialRow("terminal-bench/task-a", "graded_pass", { id: "2" }),
      ],
    })
    const html = matrixFor([run])
    expect(html).toContain("2/2")
    expect(html).toContain("100%")
  })

  test("a CRASH trial stays in the task's denominator (it is a zero, not a hole)", () => {
    const run = tbRun({
      perInstance: [
        trialRow("terminal-bench/task-a", "graded_pass", { id: "1" }),
        trialRow("terminal-bench/task-a", "agent_crash", { id: "2", exceptionType: "BoomError" }),
      ],
    })
    const html = matrixFor([run])
    // 1 of 2 — NOT 1 of 1, which is what dropping the crash would give.
    expect(html).toContain("1/2")
    expect(html).not.toContain("1/1")
    // ...and the error class is visible as a diagnostic.
    expect(html).toContain("agent_crash")
  })

  test("trial/error counts, average duration and average cost are rendered per task", () => {
    const html = matrixFor([tbRun()])
    // AVERAGES over the task's own trials: 2 trials of 300s / $0.50 each.
    expect(html).toContain("300s")
    expect(html).toContain("$0.50")
  })

  test("links to job / trajectory are rendered when they exist, — when they do not", () => {
    const html = matrixFor([tbRun()])
    expect(html).toContain("job-1")
    expect(html).toContain("trajectory.json")
  })

  test("any-pass exists only as a clearly SECONDARY diagnostic column", () => {
    const html = matrixFor([tbRun()])
    // Present…
    expect(html).toContain("any-pass")
    // …but the SCORE column is the trial rate, which reads 1/2 for this task.
    expect(html).toContain("1/2")
  })

  test("the external competitor per-task column renders — (never a stale 2.0 rate)", () => {
    const html = matrixFor([tbRun()], {
      tb: { schemaVersion: "terminal-bench-dashboard/v2", official },
    })
    expect(html).toContain("경쟁사")
    expect(html).toContain("—")
    // Nothing from the retired TB2.0 matrix can appear: the payload has no
    // per-task channel at all.
    expect(html).not.toContain("hardCeiling")
  })

  test("filters: pass-rate, error type, missing trials and incomplete coverage", () => {
    const run = tbRun({
      suiteView: { k: 2 },
      perInstance: [
        trialRow("terminal-bench/solved", "graded_pass", { id: "1" }),
        trialRow("terminal-bench/solved", "graded_pass", { id: "2" }),
        trialRow("terminal-bench/partial", "graded_pass", { id: "3" }),
        trialRow("terminal-bench/partial", "graded_fail", { id: "4" }),
        trialRow("terminal-bench/zero", "graded_fail", { id: "5" }),
        trialRow("terminal-bench/zero", "graded_fail", { id: "6" }),
        trialRow("terminal-bench/errored", "agent_crash", { id: "7" }),
        trialRow("terminal-bench/short", "graded_pass", { id: "8" }),
      ],
    })
    const rowsFor = (filter: string): string[] =>
      evalClient<string[]>(
        `(TB_FILTER.f = ${JSON.stringify(filter)}, tbTaskRows(tbSelectedRun()).map(function(t){return t.taskId;}))`,
        dataWith([run]),
      )
    expect(rowsFor("all").sort()).toEqual([
      "terminal-bench/errored",
      "terminal-bench/partial",
      "terminal-bench/short",
      "terminal-bench/solved",
      "terminal-bench/zero",
    ])
    expect(rowsFor("perfect")).toEqual(["terminal-bench/solved"])
    expect(rowsFor("partial")).toEqual(["terminal-bench/partial"])
    expect(rowsFor("zero").sort()).toEqual(["terminal-bench/errored", "terminal-bench/zero"])
    expect(rowsFor("errors").sort()).toEqual(["terminal-bench/errored"])
    // `short` ran 1 trial where k=2; `errored` ran 1 too.
    expect(rowsFor("missing").sort()).toEqual(["terminal-bench/errored", "terminal-bench/short"])
  })

  test("no Terminal runs ⇒ an explicit empty state, never a blank table", () => {
    const html = matrixFor([])
    expect(html).toContain("terminal-bench 리포트 없음")
  })
})

// ---------------------------------------------------------------------------
// Quarantine diagnostics.
// ---------------------------------------------------------------------------

describe("TB21-05 client — refused artifacts get a VISIBLE diagnostic", () => {
  test("a versionless TB2.0 report shows as quarantined and creates NO score", () => {
    const { cards } = runClient(
      "renderTbCards(); return null;",
      dataWith([], {
        quarantine: [
          {
            file: "/runs/tb20.report.json",
            suite: "terminal-bench",
            reason:
              "unsupported terminal schemaVersion undefined (expected terminal-bench-report/v2)",
          },
        ],
      }),
    )
    expect(cards).toContain("격리")
    expect(cards).toContain("tb20.report.json")
    expect(cards).toContain("schemaVersion")
    // ...and it contributed no accuracy at all.
    expect(cardValue(cards, "정확도")).toBe("—")
  })

  test("another suite's refusal is NOT shown in the Terminal view", () => {
    const { cards } = runClient(
      "renderTbCards(); return null;",
      dataWith([tbRun()], {
        quarantine: [{ file: "/runs/swe.report.json", reason: "unknown datasetFamily" }],
      }),
    )
    expect(cards).not.toContain("swe.report.json")
  })

  test("a hostile quarantine reason stays escaped", () => {
    const { cards } = runClient(
      "renderTbCards(); return null;",
      dataWith([], {
        quarantine: [{ file: HOSTILE, suite: "terminal-bench", reason: HOSTILE }],
      }),
    )
    expect(cards).not.toContain("<script>")
    expect(cards).toContain("&lt;script&gt;")
  })
})

// ---------------------------------------------------------------------------
// Official competitor comparison.
// ---------------------------------------------------------------------------

describe("TB21-05 client — the OFFICIAL 2.1 competitor comparison", () => {
  const compare = (tb: unknown): string =>
    evalClient<string>("tbScaffolds()", dataWith([tbRun()], { tb }))

  test("the pinned submission fixture renders its CHECKED-IN accuracy / pass@k / cost", () => {
    const html = compare({ schemaVersion: "terminal-bench-dashboard/v2", official })
    expect(html).toContain("Codex")
    expect(html).toContain("GPT-5.6 Luna")
    expect(html).toContain("max")
    expect(html).toContain("**71.2%** ± 1.4%")
    expect(html).toContain("0.7989")
    expect(html).toContain("0.8876")
    expect(html).toContain("445")
    expect(html).toContain("$218.28")
    expect(html).toContain("422")
    expect(html).toContain("-7.4%")
  })

  test("the reward-hack metric carries its SOURCE LINK, and the row its upstream file", () => {
    const html = compare({ schemaVersion: "terminal-bench-dashboard/v2", official })
    expect(html).toContain("issuecomment-4942210978")
    expect(html).toContain("2026-07-10-gpt-5-6-luna-max-codex.json")
  })

  test("upstream commit/ref and refresh timestamp are shown", () => {
    const html = compare({ schemaVersion: "terminal-bench-dashboard/v2", official })
    expect(html).toContain("7131e4375048a0e408a8fb404b5f499d726b695b")
    expect(html).toContain(String((official as { refreshedAt: string }).refreshedAt))
  })

  test("no official payload ⇒ an explicit refresh hint, never a stale 2.0 table", () => {
    const html = compare({ schemaVersion: "terminal-bench-dashboard/v2", official: null })
    expect(html).toContain("—")
    expect(html).toContain("terminal-bench-official")
    expect(html).not.toContain("LemonHar")
  })

  test("a WRONG-version DATA.tb payload is refused, not rendered as 2.1", () => {
    const html = compare({ schemaVersion: "tb/v1", official })
    expect(html).not.toContain("Codex")
    expect(html).toContain("—")
  })

  test("a hostile external field stays ESCAPED at the HTML boundary", () => {
    const poisoned = {
      ...(official as Record<string, unknown>),
      submissions: [
        {
          ...((official as { submissions: Record<string, unknown>[] }).submissions[0] ?? {}),
          agentLabel: HOSTILE,
          modelLabel: HOSTILE,
          displayAccuracy: HOSTILE,
          reasoningEffort: HOSTILE,
        },
      ],
    }
    const html = compare({ schemaVersion: "terminal-bench-dashboard/v2", official: poisoned })
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  test("a hostile URL that survived into the payload is never emitted as an href", () => {
    const poisoned = {
      ...(official as Record<string, unknown>),
      submissions: [
        {
          ...((official as { submissions: Record<string, unknown>[] }).submissions[0] ?? {}),
          submissionUrl: "javascript:alert(1)",
          rewardHacksUrl: "javascript:alert(1)",
        },
      ],
    }
    const html = compare({ schemaVersion: "terminal-bench-dashboard/v2", official: poisoned })
    expect(html).not.toContain("javascript:")
    // PAIRED CONTROL: an https URL from the real fixture DOES become a link.
    expect(compare({ schemaVersion: "terminal-bench-dashboard/v2", official })).toContain(
      'href="https://github.com/harbor-framework/terminal-bench-2-1/pull/105"',
    )
  })
})

// ---------------------------------------------------------------------------
// Escaping across every Terminal sink.
// ---------------------------------------------------------------------------

describe("TB21-05 client — report-derived text stays escaped", () => {
  test("hostile profile / task / model text is escaped in the cards and the matrix", () => {
    const run = tbRun({
      preset: HOSTILE,
      suiteView: { profile: HOSTILE, model: HOSTILE, datasetRef: HOSTILE, sandbox: HOSTILE },
      perInstance: [trialRow(HOSTILE, "graded_pass", { id: "1" })],
    })
    const sinks = runClient("renderTbCards(); drawTbMatrix(); return null;", dataWith([run]))
    for (const html of [sinks.cards, sinks.tbtable]) {
      expect(html).not.toContain("<script>")
      expect(html).toContain("&lt;script&gt;")
    }
  })
})

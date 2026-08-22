/**
 * BFND-03 — the Terminal projector's SHIPPED client render layer.
 *
 * The dashboard ships its UI as a client-side `<script>`; the Terminal half of it
 * now belongs to the Terminal projector. These tests evaluate the REAL shipped
 * string (the exact bytes the browser receives) against a hostile DATA payload —
 * not a re-implementation — and pin the two properties the ticket cares about:
 * the headline reads PERSISTED metrics, and every external field stays escaped.
 */
import { describe, expect, test } from "bun:test"
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
}

/** Run one function out of the shipped Terminal client bundle against `DATA`. */
function runClient(call: string, DATA: unknown): Sinks {
  const sinks: Sinks = { cards: "", tbtable: "", tbcount: "" }
  const doc = {
    getElementById(id: string) {
      return {
        set innerHTML(v: string) {
          if (id === "cards") sinks.cards = v
          if (id === "tbtable") sinks.tbtable = v
        },
        set textContent(v: string) {
          if (id === "tbcount") sinks.tbcount = v
        },
        get value() {
          return ""
        },
      }
    },
    querySelectorAll() {
      return { forEach() {} }
    },
  }
  const src = [
    "var SUITE_VIEWS = {};",
    escSource(),
    terminalBenchProjector.client.script,
    call,
  ].join("\n")
  new Function("DATA", "document", src)(DATA, doc)
  return sinks
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
  throw new Error(`card ${label} not found in: ${html.slice(0, 400)}`)
}

const tbRun = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  label: "tb-run",
  file: "/runs/tb-run.report.json",
  model: "gpt-5.5",
  preset: "TB +levers",
  benchmarkSuite: "terminal-bench",
  viewId: "terminal-bench",
  arm: "levers",
  mtime: 1,
  // PERSISTED metrics, projected straight off report.totals by the server.
  resolved: 1,
  total: 3,
  unmeasured: 0,
  perInstance: [
    { id: "task-a", passed: true, turns: 0, durationMs: 1, fail: null },
    { id: "task-b", passed: false, turns: 0, durationMs: 2, fail: null },
    {
      id: "task-c",
      passed: false,
      turns: 0,
      durationMs: 3,
      fail: null,
      error: { kind: "agent-crash" },
    },
  ],
  ...over,
})

const dataWith = (runs: unknown[], tasks: unknown[] = []): Record<string, unknown> => ({
  runs,
  campaigns: [],
  tb: { scaffolds: ["sonar", "OH"], tasks },
})

describe("terminal projector client — SUITE_VIEWS registration", () => {
  test("the bundle registers itself under its suite id (a live registration, not a constant)", () => {
    const src = [
      "var SUITE_VIEWS = {};",
      escSource(),
      terminalBenchProjector.client.script,
      "return SUITE_VIEWS;",
    ].join("\n")
    const views = new Function("DATA", "document", src)(null, null) as Record<
      string,
      { cards?: unknown; matrix?: unknown; scaffolds?: unknown }
    >
    expect(Object.keys(views)).toEqual(["terminal-bench"])
    const view = views["terminal-bench"]!
    expect(typeof view.cards).toBe("function")
    expect(typeof view.scaffolds).toBe("function")
    expect(typeof view.matrix).toBe("object")
  })
})

describe("terminal projector client — headline consumes PERSISTED metrics", () => {
  test("the 해결 card shows the run's persisted resolved/total", () => {
    const html = runClient("renderTbCards(); return null;", dataWith([tbRun()])).cards
    expect(cardValue(html, "해결 / 실행")).toBe("1 / 3")
  })

  test("CONTROL: flipping a raw per-trial verdict does NOT move the headline", () => {
    const run = tbRun()
    const rows = run.perInstance as { passed: boolean }[]
    rows[1]!.passed = true
    rows[2]!.passed = true
    const html = runClient("renderTbCards(); return null;", dataWith([run])).cards
    // Three of three rows now "pass" — a client-side any-pass re-fold would read
    // 3/3. The persisted metric is untouched, so the headline must not move.
    expect(cardValue(html, "해결 / 실행")).toBe("1 / 3")
  })

  test("PAIR: moving the persisted metric DOES move the headline (not a frozen literal)", () => {
    const html = runClient(
      "renderTbCards(); return null;",
      dataWith([tbRun({ resolved: 3, total: 3 })]),
    ).cards
    expect(cardValue(html, "해결 / 실행")).toBe("3 / 3")
  })

  test("per-arm cards read each arm's own persisted totals", () => {
    const html = runClient(
      "renderTbCards(); return null;",
      dataWith([
        tbRun({ arm: "baseline", preset: "TB baseline", resolved: 0, total: 4 }),
        tbRun({ arm: "levers", preset: "TB +levers", resolved: 2, total: 4 }),
      ]),
    ).cards
    expect(cardValue(html, "베이스라인")).toBe("0 / 4")
    expect(cardValue(html, "레버 회복")).toBe("2 / 4")
  })

  test("no Terminal runs ⇒ graceful — (never a fabricated 0/0 score)", () => {
    const html = runClient("renderTbCards(); return null;", dataWith([])).cards
    expect(cardValue(html, "해결 / 실행")).toBe("—")
  })

  test("Terminal runs are selected by SUITE, never by a dataset family", () => {
    // A SWE run that (hostilely or by accident) claims the terminal-bench family
    // must not be counted into the Terminal headline.
    const swe = tbRun({
      benchmarkSuite: "swe-bench",
      viewId: "verified",
      datasetFamily: "terminal-bench",
      resolved: 99,
      total: 99,
    })
    const html = runClient("renderTbCards(); return null;", dataWith([swe])).cards
    expect(cardValue(html, "해결 / 실행")).toBe("—")
  })
})

describe("terminal projector client — per-task matrix", () => {
  const tasks = [
    {
      task: "task-a",
      difficulty: "easy",
      category: "c",
      avg: 40,
      scaffolds: { sonar: 40 },
      hardCeiling: false,
    },
    {
      task: "task-b",
      difficulty: "hard",
      category: "c",
      avg: 20,
      scaffolds: {},
      hardCeiling: false,
    },
    { task: "task-z", difficulty: "hard", category: "c", avg: 0, scaffolds: {}, hardCeiling: true },
  ]

  test("per-task marks fold the lossless receipts (a table, not a headline)", () => {
    const { tbtable } = runClient("drawTbMatrix(); return null;", dataWith([tbRun()], tasks))
    expect(tbtable).toContain("task-a")
    expect(tbtable).toContain("task-b")
    expect(tbtable).toContain("✅")
    expect(tbtable).toContain("❌")
  })

  test("an agent-crash trial is excluded from the marks (D1 infra hole)", () => {
    const { tbtable } = runClient("drawTbMatrix(); return null;", dataWith([tbRun()], tasks))
    // task-c only ever crashed ⇒ no verdict row is synthesized for it.
    expect(tbtable).not.toContain("task-c")
  })

  test("hostile task / scaffold text stays escaped at the HTML boundary", () => {
    const { tbtable } = runClient(
      "drawTbMatrix(); return null;",
      dataWith(
        [tbRun({ preset: HOSTILE })],
        [
          {
            task: HOSTILE,
            difficulty: HOSTILE,
            category: HOSTILE,
            avg: 10,
            scaffolds: {},
            hardCeiling: false,
          },
        ],
      ),
    )
    expect(tbtable).not.toContain("<script>")
    expect(tbtable).toContain("&lt;script&gt;")
  })

  test("hostile preset text stays escaped in the cards", () => {
    const { cards } = runClient(
      "renderTbCards(); return null;",
      dataWith([tbRun({ preset: HOSTILE })]),
    )
    expect(cards).not.toContain("<script>")
    expect(cards).toContain("&lt;script&gt;")
  })

  test("scaffold view escapes competitor scaffold names", () => {
    const src = [
      "var SUITE_VIEWS = {};",
      escSource(),
      terminalBenchProjector.client.script,
      "return tbScaffolds();",
    ].join("\n")
    const DATA = {
      runs: [],
      campaigns: [],
      tb: {
        scaffolds: [HOSTILE],
        tasks: [
          {
            task: "t",
            difficulty: "e",
            category: "c",
            avg: 1,
            scaffolds: { [HOSTILE]: 5 },
            hardCeiling: false,
          },
        ],
      },
    }
    const html = new Function("DATA", "document", src)(DATA, null) as string
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })
})

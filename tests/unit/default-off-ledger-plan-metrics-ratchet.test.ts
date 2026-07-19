/**
 * DOF-91 — default-off plan metric truth ratchet.
 *
 * The closure figures in the human-facing default-off plans are easy to leave
 * stale when an always-composed feature is removed from the default-off
 * denominator. Derive their values from the ledger and require every current
 * summary to carry the exact values. The synthetic replacement control proves
 * this check is not a presence-only scan.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadDefaultOffLedger } from "../../tools/feature-catalog/default-off-ledger-checker"

const ROOT = join(import.meta.dir, "..", "..")
const LEDGER_PATH = join(ROOT, "tools/feature-catalog/default-off-ledger.yaml")

const PLAN_PATHS = [
  "docs/plans/jul-16-default-off-sota-plus-plus/00-index.md",
  "docs/plans/jul-16-default-off-sota-plus-plus/backlog-ab-and-held.md",
  "docs/plans/jul-16-default-off-sota-plus-plus/sota-plus-plus-execution-plan.md",
] as const

interface LedgerPlanMetrics {
  readonly rows: number
  readonly wired: number
  readonly percent: string
  readonly measureFirst: number
  readonly enableNow: number
  readonly hold: number
  readonly dormant: number
}

const metricsOf = async (): Promise<LedgerPlanMetrics> => {
  const ledger = await loadDefaultOffLedger(LEDGER_PATH)
  const count = (predicate: (row: (typeof ledger.rows)[number]) => boolean): number =>
    ledger.rows.filter(predicate).length
  const rows = ledger.rows.length
  const wired = count((row) => row.reachability === "wired")
  return {
    rows,
    wired,
    percent: ((wired / rows) * 100).toFixed(1),
    measureFirst: count((row) => row.decision === "measure-first"),
    enableNow: count((row) => row.decision === "enable-now"),
    hold: count((row) => row.decision === "hold"),
    dormant: count((row) => row.reachability !== "wired"),
  }
}

const summaryNeedles = (
  metrics: LedgerPlanMetrics,
): Record<(typeof PLAN_PATHS)[number], readonly string[]> => ({
  "docs/plans/jul-16-default-off-sota-plus-plus/00-index.md": [
    `Closure **${metrics.wired}/${metrics.rows} wired = ${metrics.percent}%**`,
    `decisions {measure-first ${metrics.measureFirst}, enable-now ${metrics.enableNow}, repair-first 0, hold ${metrics.hold}}`,
    `closure **${metrics.wired}/${metrics.rows} wired (${metrics.percent}%)**`,
    `The ${metrics.dormant} dormant rows`,
  ],
  "docs/plans/jul-16-default-off-sota-plus-plus/backlog-ab-and-held.md": [
    `eligible ${metrics.rows}행, **wired ${metrics.wired}/${metrics.rows} = ${metrics.percent}%**`,
    `decisions: measure-first ${metrics.measureFirst} · **enable-now ${metrics.enableNow}** · repair-first 0 · hold ${metrics.hold}.`,
  ],
  "docs/plans/jul-16-default-off-sota-plus-plus/sota-plus-plus-execution-plan.md": [
    `**${metrics.wired}/${metrics.rows} wired (${metrics.percent}%)**`,
    `남은 ${metrics.dormant}건`,
  ],
})

const missingNeedles = (text: string, needles: readonly string[]): string[] =>
  needles.filter((needle) => !text.includes(needle))

describe("DOF-91 default-off plan metric truth", () => {
  test("every current summary agrees with the ledger", async () => {
    const metrics = await metricsOf()
    const expected = summaryNeedles(metrics)
    expect(Object.keys(expected)).toHaveLength(PLAN_PATHS.length)

    for (const path of PLAN_PATHS) {
      const text = await Bun.file(join(ROOT, path)).text()
      expect(missingNeedles(text, expected[path])).toEqual([])
    }
  })

  test("red-on-injection: a stale denominator is rejected", async () => {
    const metrics = await metricsOf()
    const path = "docs/plans/jul-16-default-off-sota-plus-plus/00-index.md" as const
    const text = await Bun.file(join(ROOT, path)).text()
    const expected = summaryNeedles(metrics)[path][0]
    if (expected === undefined) throw new Error("truth needle must exist")
    const injected = text.replace(expected, "Closure **999/999 wired = 100.0%**")
    expect(injected).not.toBe(text)
    expect(missingNeedles(injected, [expected])).toEqual([expected])
  })
})

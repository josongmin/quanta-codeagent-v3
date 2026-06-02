/** RFC-09 (B) hellgate — pre-compaction context warning. Pure predicate:
 *  fires at the ratio, silent below, graceful on empty/degenerate, and (the
 *  load-bearing test) reuses the SAME loop token estimator (no new heuristic). */

import { describe, expect, test } from "bun:test"
import {
  buildUsageBreakdownDefault,
  type PromptAssembledSnapshot,
  snapshotToBreakdownInput,
} from "@/agent/context/usage-breakdown"
import { type ContextWarningView, renderContextWarning, toWarningView } from "../context-warning"
import { createContextUsageHolder } from "../repl/context-usage-snapshot"

const view = (usedTokens: number, max: number, compactThreshold: number): ContextWarningView => ({
  usedTokens,
  max,
  compactThreshold,
})

describe("RFC-09 B — renderContextWarning thresholds", () => {
  test("window 80% (below compaction 90%) ⇒ window-fullness message", () => {
    const s = renderContextWarning(view(96_000, 120_000, 120_000))
    expect(s).not.toBe("")
    expect(s).toContain("윈도우가 차고 있습니다")
    expect(s).not.toContain("곧 자동 요약")
    expect(s).toContain("esc esc(/rewind)")
  })

  test("compaction 91% ⇒ compaction-first message + rewind affordance", () => {
    const s = renderContextWarning(view(110_000, 200_000, 120_000))
    expect(s).toContain("곧 자동 요약됩니다")
    expect(s).toContain("/compact")
    expect(s).toContain("esc esc(/rewind)")
  })

  test("below both ratios ⇒ empty string (no noise)", () => {
    expect(renderContextWarning(view(50_000, 120_000, 120_000))).toBe("")
  })

  test("exactly at the window ratio (80%) fires (>=)", () => {
    expect(renderContextWarning(view(96_000, 120_000, 1_000_000))).not.toBe("")
  })

  test("custom ratios are honored", () => {
    expect(renderContextWarning(view(60_000, 120_000, 120_000), { windowWarnRatio: 0.4 })).not.toBe(
      "",
    )
    expect(renderContextWarning(view(96_000, 120_000, 120_000), { windowWarnRatio: 0.99 })).toBe("")
  })
})

describe("RFC-09 B — graceful degenerate handling", () => {
  test("undefined view (no snapshot yet) ⇒ empty string", () => {
    expect(renderContextWarning(undefined)).toBe("")
  })

  test("max <= 0 ⇒ empty string (no NaN/Infinity text)", () => {
    expect(renderContextWarning(view(99_999, 0, 120_000))).toBe("")
    expect(renderContextWarning(view(99_999, -5, 120_000))).toBe("")
  })

  test("compactThreshold 0 ⇒ no compaction branch, falls back to window", () => {
    const s = renderContextWarning(view(110_000, 120_000, 0))
    // compactPct=0 (no division), winPct=92 ⇒ window message
    expect(s).toContain("윈도우가 차고 있습니다")
  })

  test("toWarningView(undefined, _) ⇒ undefined", () => {
    expect(toWarningView(undefined, 120_000)).toBeUndefined()
  })
})

describe("RFC-09 B — reuses the REAL loop token count (no new heuristic)", () => {
  test("warning usedTokens === holder.view().total === loop estimator total", () => {
    const snap: PromptAssembledSnapshot = {
      system: [{ type: "text", text: "x".repeat(40_000) }],
      layout: "single_block",
      repoRulesPresent: false,
      sessionCtxPresent: false,
      userAppendPresent: false,
      max: 200_000,
      model: "gpt-5",
    }
    // The holder maps the snapshot through the loop's OWN estimator.
    const holder = createContextUsageHolder()
    holder.sink(snap)
    const holderView = holder.view()
    expect(holderView).toBeDefined()

    // Independently compute the SAME breakdown the holder uses.
    const direct = buildUsageBreakdownDefault(snapshotToBreakdownInput(snap))

    const wv = toWarningView(holderView, 120_000)
    expect(wv).toBeDefined()
    // B's usedTokens is byte-for-byte the loop estimator's total — no second
    // token heuristic anywhere in the warning path.
    expect(wv?.usedTokens).toBe(holderView?.total ?? -1)
    expect(wv?.usedTokens).toBe(direct.total)
    expect(wv?.max).toBe(200_000)
  })

  test("before first snapshot, holder.view() undefined ⇒ warning empty", () => {
    const holder = createContextUsageHolder()
    expect(renderContextWarning(toWarningView(holder.view(), 120_000))).toBe("")
  })
})

/**
 * ★ HELLGATE — M3/S3 (jun-7 FINAL): the CLI context-% warning is MODEL-AWARE.
 *
 * Before this fix, `notify-and-warning.ts` hardcoded a model-blind 120k
 * threshold (`COMPACT_DEFAULT_THRESHOLD`), so on a 1M-context session the CLI
 * warning fired at 120k while the REAL compaction threshold was ~923k — a
 * 7.7x disagreement. M3 routes the display through the SAME SSOT the compaction
 * wire uses (`resolveCompactionLimitTokens`, which applies the D4 model-window
 * derivation: `window − maxOutput − 13000`). S3 makes that resolver the single
 * source both paths consume, so they can NEVER disagree for a given model.
 *
 * Red-on-injection: revert the factory to `?? 120_000` ⇒ the 1M-model case
 * below resolves 120_000 and the assertions on ~923k fail.
 */
import { describe, expect, test } from "bun:test"
import { resolveCompactionLimitTokens } from "@/agent"
import { renderContextWarning, toWarningView } from "../context-warning"
import type { SegmentedUsageView } from "../status-line"

const segView = (total: number, max: number, model: string): SegmentedUsageView => ({
  segments: [{ id: "conversation", tokens: total }],
  total,
  max,
  model,
})

describe("M3/S3 — context warning uses the model-derived threshold (SSOT)", () => {
  test("1M-context model ⇒ threshold ~923k, NOT the 120k legacy constant", () => {
    // `claude-sonnet-4-6-1m`: 1_000_000 − 64_000 (maxOutput) − 13_000 (margin).
    const t = resolveCompactionLimitTokens(undefined, "claude-sonnet-4-6-1m")
    expect(t).toBe(923_000)
    expect(t).not.toBe(120_000)
  })

  test("200k opus model ⇒ 200_000 − 32_000 − 13_000 = 155_000 (model-derived, not 120k)", () => {
    const t = resolveCompactionLimitTokens(undefined, "claude-opus-4-8")
    expect(t).toBe(155_000)
    expect(t).not.toBe(120_000)
  })

  test("unknown / un-tabled model ⇒ falls back to 120k legacy (byte-identical)", () => {
    expect(resolveCompactionLimitTokens(undefined, "totally-unknown-model")).toBe(120_000)
    expect(resolveCompactionLimitTokens(undefined, undefined)).toBe(120_000)
  })

  test("end-to-end: a 1M-model session at 130k used does NOT warn (130k < 90% of 923k)", () => {
    // The display threading: view.model → resolveCompactionLimitTokens → warning.
    const view = segView(130_000, 1_000_000, "claude-sonnet-4-6-1m")
    const threshold = resolveCompactionLimitTokens(undefined, view.model)
    const out = renderContextWarning(toWarningView(view, threshold))
    // With the OLD model-blind 120k the same 130k used would scream "곧 자동
    // 요약" (108% of 120k). With the model-aware ~923k it stays silent.
    expect(out).toBe("")
  })

  test("end-to-end: same 1M-model session at 870k used DOES warn (≥90% of 923k)", () => {
    const view = segView(870_000, 1_000_000, "claude-sonnet-4-6-1m")
    const threshold = resolveCompactionLimitTokens(undefined, view.model)
    const out = renderContextWarning(toWarningView(view, threshold))
    expect(out).toContain("곧 자동 요약됩니다")
  })
})

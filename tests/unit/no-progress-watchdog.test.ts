/**
 * jun-27 no-progress watchdog (the third leg of hang detection). The jun-27
 * full-remote hang made a box churn LLM calls for 77min with ZERO completed
 * turns — empty-stream-breaker saw non-empty streams, run-health never ran (the
 * instance never returned). The watchdog formalizes the "newest-activity-age"
 * signal: a budget that RESETS on each progress event and trips once it elapses.
 * Pinned with an injected clock so the timing is deterministic (no real sleeps).
 */
import { describe, expect, test } from "bun:test"
import {
  makeNoProgressWatchdog,
  resolveNoProgressBudgetMs,
} from "../../src/runner/batch/eval/no-progress-watchdog"

describe("makeNoProgressWatchdog", () => {
  test("not stalled within budget; stalled once the budget elapses with no progress", () => {
    let t = 0
    const w = makeNoProgressWatchdog({ budgetMs: 1000, now: () => t })
    expect(w.stalled()).toBe(false)
    t = 999
    expect(w.stalled()).toBe(false)
    t = 1000
    expect(w.stalled()).toBe(true)
    expect(w.idleMs()).toBe(1000)
  })

  test("progress() resets the idle clock (a working box never trips)", () => {
    let t = 0
    const w = makeNoProgressWatchdog({ budgetMs: 1000, now: () => t })
    t = 900
    w.progress() // forward progress at 900 — idle clock restarts
    t = 1800
    expect(w.idleMs()).toBe(900) // 900ms since the last progress, not since t=0
    expect(w.stalled()).toBe(false)
    t = 1900
    expect(w.stalled()).toBe(true) // 1000ms since progress at 900
  })

  test("repeated progress keeps a long-but-active run alive indefinitely", () => {
    let t = 0
    const w = makeNoProgressWatchdog({ budgetMs: 1000, now: () => t })
    for (let i = 0; i < 100; i += 1) {
      t += 500 // a turn every 500ms < 1000ms budget
      w.progress()
      expect(w.stalled()).toBe(false)
    }
  })

  test("non-positive / NaN budget ⇒ NEVER stalls (opt-in-safe; a misconfig can't kill every box)", () => {
    let t = 0
    const now = () => t
    const zero = makeNoProgressWatchdog({ budgetMs: 0, now })
    const nan = makeNoProgressWatchdog({ budgetMs: Number.NaN, now })
    t = 1_000_000_000
    expect(zero.stalled()).toBe(false)
    expect(nan.stalled()).toBe(false)
  })

  test("idleMs never negative even if the clock goes backwards", () => {
    let t = 1000
    const w = makeNoProgressWatchdog({ budgetMs: 1000, now: () => t })
    t = 500 // clock skew backwards
    expect(w.idleMs()).toBe(0)
    expect(w.stalled()).toBe(false)
  })

  test("reason names the instance id, idle seconds, and budget", () => {
    let t = 0
    const w = makeNoProgressWatchdog({ budgetMs: 1000, now: () => t })
    t = 1500
    const r = w.reason("django__django-11141")
    expect(r).toContain("django__django-11141")
    expect(r).toContain("2s") // 1500ms idle ≈ 2s (rounded)
    expect(r).toContain("budget 1s")
  })
})

describe("resolveNoProgressBudgetMs (env)", () => {
  test("unset / empty ⇒ Infinity (default-OFF — abort is an explicit opt-in)", () => {
    expect(resolveNoProgressBudgetMs({})).toBe(Number.POSITIVE_INFINITY)
    expect(resolveNoProgressBudgetMs({ QUANTA_BENCH_NO_PROGRESS_ABORT_S: "" })).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(resolveNoProgressBudgetMs({ QUANTA_BENCH_NO_PROGRESS_ABORT_S: "   " })).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  test("positive seconds ⇒ ms", () => {
    expect(resolveNoProgressBudgetMs({ QUANTA_BENCH_NO_PROGRESS_ABORT_S: "1800" })).toBe(1_800_000)
    expect(resolveNoProgressBudgetMs({ QUANTA_BENCH_NO_PROGRESS_ABORT_S: "30" })).toBe(30_000)
  })

  test("zero / negative / garbage ⇒ Infinity (never an instant-kill)", () => {
    expect(resolveNoProgressBudgetMs({ QUANTA_BENCH_NO_PROGRESS_ABORT_S: "0" })).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(resolveNoProgressBudgetMs({ QUANTA_BENCH_NO_PROGRESS_ABORT_S: "-5" })).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(resolveNoProgressBudgetMs({ QUANTA_BENCH_NO_PROGRESS_ABORT_S: "abc" })).toBe(
      Number.POSITIVE_INFINITY,
    )
  })
})

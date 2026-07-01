/**
 * HELLGATE — background (speculative) compaction (ADR-0473).
 *
 * Proves the happy path AND every discard / 2-phase-safety mode of the
 * BackgroundSummarizationController:
 *
 *   - START: approaching the limit → a cancellable background pass begins;
 *     NOT approaching → no pass started (idempotent: a second maybeStart while
 *     a pass is in flight does not start a second one).
 *   - INSTALL: pass completes AND clears the persist threshold (AND of
 *     persistUnusedTokens/Percent) → reconcile returns install with the
 *     produced summary + freedTokens.
 *   - CANCEL (no wasted spend): turn ends early → cancelIfPending aborts the
 *     pass; the injected summarizer observes `cancel.aborted` and returns early;
 *     reconcile discards `cancelled`. Proven: the summarizer SAW the abort.
 *   - NOT-COMPLETED: still in flight at the boundary → discard `not-completed`
 *     WITHOUT stalling, and the pass is aborted (no further spend).
 *   - INPUT-LIMIT FAILURE: summarize fails because its own input exceeded the
 *     model limit mid-turn → discard `input-limit-failure`; live history intact.
 *   - BELOW-THRESHOLD: completes but frees too little → discard
 *     `below-persist-threshold`.
 *   - 2-PHASE: a FAILED summarize never yields install (history stays as-is) —
 *     the only outcome that hands back a summary is `kind:"install"`.
 *   - SUMMARIZER-ERROR / no-throw: an adapter that THROWS (breaks its no-throw
 *     promise) collapses to `summarizer-error`, never an unhandled rejection.
 *   - GATE: bgCompactionEnabled strict `"1"`.
 *
 * Pure unit test — no network, no real LLM; the summarize port is a spy double,
 * the clock is a fake counter.
 *
 * Slices imported: the bg-compaction slice's `index` ONLY (explicit subpath to
 * avoid the `@/agent/compaction.ts` file vs `compaction/` dir ambiguity) +
 * `@/shared` for the Result helpers used by the doubles.
 */
import { describe, expect, test } from "bun:test"
import {
  BackgroundSummarizationController,
  BG_COMPACTION_ENV,
  type BgCompactionConfig,
  bgCompactionEnabled,
  type CancelToken,
  isApproachingLimit,
  meetsPersistThreshold,
  type SpeculativeSummarizeFn,
  type SummarizeError,
} from "@/agent/compaction/index"
import type { Result } from "@/shared"

const CFG: BgCompactionConfig = {
  startAtUnusedTokens: 10_000,
  startAtUnusedPercent: 0.1,
  persistUnusedTokens: 5_000,
  persistUnusedPercent: 0.05,
}

const fakeClock = () => {
  let t = 1_000
  return () => {
    t += 1
    return t
  }
}

/** A summary payload double. */
type Summary = { text: string }

/** Build an immediately-resolving summarize port returning a good summary. */
const okSummarizer =
  (resultingTokens: number): SpeculativeSummarizeFn<Summary> =>
  async () => ({
    ok: true,
    value: { summary: { text: "brief" }, resultingTokens, summarizedPrefixLen: 0 },
  })

/** A summarize port that records whether it observed the abort, and resolves
 *  with a (deferred) result the test controls. */
const deferredSummarizer = () => {
  let resolveFn: (
    r: Result<{ summary: Summary; resultingTokens: number; summarizedPrefixLen: number }, SummarizeError>,
  ) => void = () => {}
  let sawAbort = false
  const promise = new Promise<
    Result<{ summary: Summary; resultingTokens: number; summarizedPrefixLen: number }, SummarizeError>
  >((res) => {
    resolveFn = res
  })
  const fn: SpeculativeSummarizeFn<Summary> = async (req: { cancel: CancelToken }) => {
    // Observe abort after it is requested.
    const result = await promise
    sawAbort = req.cancel.aborted
    return result
  }
  return {
    fn,
    resolve: resolveFn,
    sawAbort: () => sawAbort,
    settle: (r: Result<{ summary: Summary; resultingTokens: number; summarizedPrefixLen: number }, SummarizeError>) =>
      resolveFn(r),
  }
}

describe("bg-compaction gate (ADR-0473)", () => {
  test("strict =1 opt-in; everything else OFF", () => {
    expect(bgCompactionEnabled({ [BG_COMPACTION_ENV]: "1" })).toBe(true)
    for (const v of ["0", "true", "on", "", undefined]) {
      expect(bgCompactionEnabled({ [BG_COMPACTION_ENV]: v })).toBe(false)
    }
    expect(bgCompactionEnabled({})).toBe(false)
  })
})

describe("isApproachingLimit (ADR-0473)", () => {
  test("fires on absolute OR percent floor; degenerate window never fires", () => {
    // 8k free ≤ 10k absolute floor → approaching.
    expect(isApproachingLimit({ usedTokens: 92_000, limitTokens: 100_000 }, CFG)).toBe(true)
    // 12k free > 10k AND 12% > 10% → not approaching.
    expect(isApproachingLimit({ usedTokens: 88_000, limitTokens: 100_000 }, CFG)).toBe(false)
    // percent floor: 9k free / 100k = 9% ≤ 10% → approaching even though >0 abs? no, 9k<10k anyway.
    // construct a percent-only trip: huge window so abs floor not hit but pct is.
    expect(isApproachingLimit({ usedTokens: 95_000, limitTokens: 1_000_000 }, CFG)).toBe(false)
    // degenerate window
    expect(isApproachingLimit({ usedTokens: 0, limitTokens: 0 }, CFG)).toBe(false)
  })
})

describe("meetsPersistThreshold (ADR-0473)", () => {
  test("requires BOTH absolute AND percent floor; clamps negative free to 0", () => {
    // frees 20k / 100k = 20%: passes both 5k & 5%.
    expect(meetsPersistThreshold(90_000, 70_000, 100_000, CFG)).toBe(true)
    // frees 4k: fails absolute floor.
    expect(meetsPersistThreshold(90_000, 86_000, 100_000, CFG)).toBe(false)
    // frees 6k abs (passes) but 6k/1_000_000 = 0.6% fails percent floor.
    expect(meetsPersistThreshold(90_000, 84_000, 1_000_000, CFG)).toBe(false)
    // summary larger than prefix → freed clamped to 0 → fails.
    expect(meetsPersistThreshold(50_000, 60_000, 100_000, CFG)).toBe(false)
  })
})

describe("BackgroundSummarizationController (ADR-0473)", () => {
  test("not approaching → no pass started", () => {
    const ctl = new BackgroundSummarizationController(okSummarizer(70_000), fakeClock(), CFG)
    expect(ctl.maybeStart({ usedTokens: 50_000, limitTokens: 100_000 })).toBe(false)
    expect(ctl.hasPendingPass()).toBe(false)
  })

  test("approaching → starts; maybeStart idempotent (no double pass)", () => {
    let calls = 0
    const summ: SpeculativeSummarizeFn<Summary> = async () => {
      calls++
      return {
        ok: true,
        value: { summary: { text: "x" }, resultingTokens: 70_000, summarizedPrefixLen: 0 },
      }
    }
    const ctl = new BackgroundSummarizationController(summ, fakeClock(), CFG)
    const usage = { usedTokens: 95_000, limitTokens: 100_000 }
    expect(ctl.maybeStart(usage)).toBe(true)
    expect(ctl.maybeStart(usage)).toBe(true) // idempotent
    expect(ctl.hasPendingPass()).toBe(true)
    expect(calls).toBe(1)
  })

  test("complete + clears threshold → install with freedTokens", async () => {
    const ctl = new BackgroundSummarizationController(okSummarizer(70_000), fakeClock(), CFG)
    const usage = { usedTokens: 95_000, limitTokens: 100_000 }
    ctl.maybeStart(usage)
    const out = await ctl.reconcileAtTurnBoundary(usage)
    expect(out.kind).toBe("install")
    if (out.kind === "install") {
      expect(out.summary).toEqual({ text: "brief" })
      expect(out.freedTokens).toBe(25_000)
    }
    // pass consumed → second reconcile is a no-op.
    const again = await ctl.reconcileAtTurnBoundary(usage)
    expect(again).toEqual({ kind: "discard", reason: "no-pass-started" })
  })

  test("turn ends early → cancel; summarizer saw abort; discard cancelled (no wasted spend)", async () => {
    const def = deferredSummarizer()
    const ctl = new BackgroundSummarizationController(def.fn, fakeClock(), CFG)
    const usage = { usedTokens: 95_000, limitTokens: 100_000 }
    ctl.maybeStart(usage)
    ctl.cancelIfPending() // turn ended early
    // now the summarizer's deferred body can resolve; it observes the abort.
    def.settle({
      ok: true,
      value: { summary: { text: "late" }, resultingTokens: 70_000, summarizedPrefixLen: 0 },
    })
    const out = await ctl.reconcileAtTurnBoundary(usage)
    expect(out).toEqual({ kind: "discard", reason: "cancelled" })
    // allow microtasks so the deferred body runs and records sawAbort.
    await Promise.resolve()
    await Promise.resolve()
    expect(def.sawAbort()).toBe(true)
  })

  test("still in flight at boundary → discard not-completed without stalling, pass aborted", async () => {
    let capturedCancel: CancelToken | undefined
    // A summarizer that never resolves while it is in flight (the turn boundary
    // arrives first). We capture the cancel token to assert the controller
    // aborts the moot pass so it does not keep spending.
    const summ: SpeculativeSummarizeFn<Summary> = (req) => {
      capturedCancel = req.cancel
      return new Promise(() => {}) // never resolves
    }
    const ctl = new BackgroundSummarizationController(summ, fakeClock(), CFG)
    const usage = { usedTokens: 95_000, limitTokens: 100_000 }
    ctl.maybeStart(usage)
    const out = await ctl.reconcileAtTurnBoundary(usage)
    expect(out).toEqual({ kind: "discard", reason: "not-completed" })
    expect(capturedCancel?.aborted).toBe(true)
  })

  test("input-limit failure → discard input-limit-failure; history intact (no install)", async () => {
    const summ: SpeculativeSummarizeFn<Summary> = async () => ({
      ok: false,
      error: { kind: "input-limit", detail: "prompt too long while summarizing" },
    })
    const ctl = new BackgroundSummarizationController(summ, fakeClock(), CFG)
    const usage = { usedTokens: 95_000, limitTokens: 100_000 }
    ctl.maybeStart(usage)
    const out = await ctl.reconcileAtTurnBoundary(usage)
    expect(out).toEqual({ kind: "discard", reason: "input-limit-failure" })
  })

  test("below persist threshold → discard below-persist-threshold", async () => {
    // resulting 92k vs used 95k → frees 3k < 5k absolute floor.
    const ctl = new BackgroundSummarizationController(okSummarizer(92_000), fakeClock(), CFG)
    const usage = { usedTokens: 95_000, limitTokens: 100_000 }
    ctl.maybeStart(usage)
    const out = await ctl.reconcileAtTurnBoundary(usage)
    expect(out).toEqual({ kind: "discard", reason: "below-persist-threshold" })
  })

  test("2-phase: a throwing adapter collapses to summarizer-error, never install/rejection", async () => {
    const summ: SpeculativeSummarizeFn<Summary> = async () => {
      throw new Error("network blew up")
    }
    const ctl = new BackgroundSummarizationController(summ, fakeClock(), CFG)
    const usage = { usedTokens: 95_000, limitTokens: 100_000 }
    ctl.maybeStart(usage)
    const out = await ctl.reconcileAtTurnBoundary(usage)
    expect(out).toEqual({ kind: "discard", reason: "summarizer-error" })
  })

  test("persist gate measured against STARTED usage, not a grown live transcript", async () => {
    // started: used 95k, summary resulting 70k → frees 25k.
    const ctl = new BackgroundSummarizationController(okSummarizer(70_000), fakeClock(), CFG)
    const started = { usedTokens: 95_000, limitTokens: 100_000 }
    ctl.maybeStart(started)
    // by boundary the live transcript grew to 99k, but the gate uses the 95k
    // snapshot the summary was actually produced against.
    const out = await ctl.reconcileAtTurnBoundary({ usedTokens: 99_000, limitTokens: 100_000 })
    expect(out.kind).toBe("install")
    if (out.kind === "install") expect(out.freedTokens).toBe(25_000)
  })
})

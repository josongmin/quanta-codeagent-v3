/**
 * HELLGATE E2E (RFC-06 A4.3) — the `usage_limited` PRODUCER, driven by a FAKE
 * LLM raising a real 429 (rate-limit) through the REAL agent loop (`runAgent`).
 *
 * THE GAP this pins: the objective 6-state machine has
 * `markUsageLimited(threadId, untilEpochMs)` but ZERO production callers — so
 * the measured 429 rate-limit signal (`LLMError.retryAfterMs`, parsed at the
 * `fromSdkError` boundary from `retry-after`) never reached the objective. This
 * e2e wires a 429 through the loop's same-turn recovery seam and asserts:
 *
 *   1. GATE ON (`QUANTA_OBJECTIVE_BUDGET_ENFORCE=1`, store `enforceBudget:true`):
 *      a 429 carrying `retryAfterMs` transitions the ACTIVE objective to
 *      `usage_limited` until `now + retryAfterMs`; advancing the injected clock
 *      PAST that epoch re-derives the status back to `active` (auto-reset, no
 *      sticky flag). The 429-turn still recovers (backoff → re-stream → done).
 *   2. NO DOUBLE-COUNT: the host-settled token ledger (GOAL-01 `settleAttempt`,
 *      the replacement for the retired `recordUsage` self-report) is untouched
 *      by the 429 wire — `budget.tokensUsed` is unchanged.
 *   3. DEFAULT-OFF (gate unset, informational store): the SAME 429 causes NO
 *      objective mutation — `usageLimitedUntil` is never set, the status stays
 *      `active` throughout, byte-identical to today.
 *
 * The 429 is thrown DIRECTLY from the scripted LLM step (the loop is not wrapped
 * in `RetryingLLM` here — that decorator lives in the runner composition), so it
 * surfaces at `streamConsume` → `resolveTurnAction` (`rate_limit` ⇒ retryable ⇒
 * same-turn `backoff`) → `applyNonSuccessRecoveryAction` where the measured
 * signal is fed to the objective machine.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { createObjectiveStore, type ObjectivePort } from "@/objective"
import { __resetRuntimeConfig, LLMError } from "@/shared"
import { settleUsage } from "../unit/objective/v2-helpers"
import { cfg, ev, ScriptedLLM, text, thr, withTimeout } from "./_harness"

/** Wrap a store counting `markUsageLimited` invocations — the capturing-sink for
 *  the default-OFF byte-identical proof (the wire must NEVER call it when the
 *  gate is unset). Every other method delegates verbatim. */
const countingStore = (inner: ObjectivePort): { store: ObjectivePort; marks: () => number } => {
  let marks = 0
  const store: ObjectivePort = {
    ...inner,
    create: inner.create.bind(inner),
    replace: inner.replace.bind(inner),
    clear: inner.clear.bind(inner),
    get: inner.get.bind(inner),
    setExplicitStatus: inner.setExplicitStatus.bind(inner),
    amendBudget: inner.amendBudget.bind(inner),
    addBlocker: inner.addBlocker.bind(inner),
    clearBlocker: inner.clearBlocker.bind(inner),
    setNextActions: inner.setNextActions.bind(inner),
    markCriterion: inner.markCriterion.bind(inner),
    list: inner.list.bind(inner),
    toSnapshot: inner.toSnapshot.bind(inner),
    fromSnapshot: inner.fromSnapshot.bind(inner),
    markUsageLimited: (threadId, until) => {
      marks += 1
      return inner.markUsageLimited(threadId, until)
    },
  }
  return { store, marks: () => marks }
}

const TID = "thread-429-e2e"

/** A 429 `LLMError` shaped exactly as `LLMError.fromSdkError` mints it for a
 *  rate-limit response with a `retry-after` header: kind `rate_limit`, status
 *  429, and a server-instructed `retryAfterMs` DELTA (ms until capacity). */
const rateLimit429 = (retryAfterMs: number): LLMError =>
  new LLMError("openai request failed: 429 rate limit", {
    kind: "rate_limit",
    statusCode: 429,
    provider: "openai",
    retryAfterMs,
  })

const RETRY_AFTER_MS = 30_000

beforeEach(() => __resetRuntimeConfig())
afterEach(() => {
  delete process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE
  __resetRuntimeConfig()
})

describe("HELLGATE E2E [RFC-06 A4.3] — 429 retry-after ⇒ objective usage_limited (real loop)", () => {
  test("GATE ON: 429 ⇒ usage_limited until epoch; clock past epoch ⇒ active", async () => {
    process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE = "1"
    __resetRuntimeConfig()

    // The store derives its usage window against `clock`. The loop's 429 wire
    // stamps the epoch from `Date.now()` (prod: store + wire share the wall
    // clock), so we START `clock` at real wall-time so the two agree, then read
    // the ACTUAL epoch the wire wrote and drive `clock` RELATIVE to it — no
    // divergence, no real sleep.
    let clock = Date.now()
    const inner = createObjectiveStore({ now: () => clock, enforceBudget: true })
    const { store, marks } = countingStore(inner)
    store.create(TID, { goal: "ship the feature", budget: { maxTokens: 1_000 } })
    // Host-settled accounting BEFORE the 429 — must survive untouched.
    settleUsage(inner, TID, { tokens: 42 })
    expect(store.get(TID)?.budget.tokensUsed).toBe(42)
    expect(store.get(TID)?.status).toBe("active")

    // Turn 1 throws a 429 (same-turn backoff), then the re-stream succeeds.
    const llm = new ScriptedLLM([thr(rateLimit429(RETRY_AFTER_MS)), ev(text("done"))])

    const out = await withTimeout(
      runAgent(cfg({ llm, sessionId: TID, objective: store, maxTurns: 4 })),
      20_000,
      "usage-limited-429",
    )
    expect(out.reason).toBe("completed")

    // The wire actually fired (non-vacuous — proves the seam was reached).
    expect(marks()).toBeGreaterThanOrEqual(1)

    // (1) The measured 429 marked the objective usage_limited until the epoch.
    //     Read AT a clock BEFORE the epoch: status is usage_limited.
    expect(store.get(TID)?.status).toBe("usage_limited")

    // Recover the exact epoch the wire stamped (Date.now()+retryAfterMs).
    const limitedEntry = store.toSnapshot().objectives.find((o) => o.threadId === TID) as
      | { usageLimitedUntil?: number }
      | undefined
    const epoch = limitedEntry?.usageLimitedUntil
    expect(typeof epoch).toBe("number")
    // The window ends ~retryAfterMs in the future of the wire's stamp; with the
    // store clock still at/around `Date.now()` we are BEFORE the epoch.
    expect(epoch as number).toBeGreaterThan(clock)

    // (2) NO DOUBLE-COUNT: the 429 wire touched ONLY the usage window, not the
    //     host-settled token ledger.
    expect(store.get(TID)?.budget.tokensUsed).toBe(42)

    // Just BEFORE the epoch it is still usage_limited (non-vacuous boundary).
    clock = (epoch as number) - 1
    expect(store.get(TID)?.status).toBe("usage_limited")

    // (3) TRANSITION BACK: advance the store clock PAST the epoch → the window
    //     elapses → status auto-re-derives to `active` (no sticky flag).
    clock = (epoch as number) + 1
    expect(store.get(TID)?.status).toBe("active")
  })

  test("DEFAULT-OFF (gate unset, informational store): 429 ⇒ NO objective mutation", async () => {
    // Gate unset — the informational store never derives usage_limited AND the
    // wire never calls markUsageLimited (byte-identical to today).
    __resetRuntimeConfig()

    let clock = 2_000_000
    const inner = createObjectiveStore({ now: () => clock })
    const { store, marks } = countingStore(inner)
    store.create(TID, { goal: "ship", budget: { maxTokens: 1_000 } })
    settleUsage(inner, TID, { tokens: 7 })

    // Capture the pre-run snapshot including the private usage window (via the
    // serializable snapshot — `usageLimitedUntil` surfaces there when set).
    const before = store.toSnapshot()

    const llm = new ScriptedLLM([thr(rateLimit429(RETRY_AFTER_MS)), ev(text("done"))])
    const out = await withTimeout(
      runAgent(cfg({ llm, sessionId: TID, objective: store, maxTurns: 4 })),
      20_000,
      "usage-limited-429-off",
    )
    expect(out.reason).toBe("completed")

    // CAPTURING-SINK PROOF: with the gate unset the wire returns BEFORE the port,
    // so markUsageLimited was NEVER invoked (call count == 0) — byte-identical.
    expect(marks()).toBe(0)

    // No usage window was ever set (the snapshot entry omits usageLimitedUntil),
    // the status stayed active, and tokens are unchanged.
    const after = store.toSnapshot()
    const entry = after.objectives.find((o) => o.threadId === TID) as
      | { status: string; usageLimitedUntil?: number; budget: { tokensUsed: number } }
      | undefined
    expect(entry?.status).toBe("active")
    expect(entry?.usageLimitedUntil).toBeUndefined()
    expect(entry?.budget.tokensUsed).toBe(7)
    // The snapshot is structurally unchanged across the run (no mutation).
    expect(after).toEqual(before)
    // Even advancing the clock cannot conjure a window that was never set.
    clock += RETRY_AFTER_MS + 1
    expect(store.get(TID)?.status).toBe("active")
  })

  test("GATE ON + NON-ACTIVE objective (paused): 429 must NOT resurrect it", async () => {
    process.env.QUANTA_OBJECTIVE_BUDGET_ENFORCE = "1"
    __resetRuntimeConfig()

    let clock = Date.now()
    const { store, marks } = countingStore(
      createObjectiveStore({ now: () => clock, enforceBudget: true }),
    )
    store.create(TID, { goal: "ship" })
    // Explicitly PAUSE the goal (user suspended it) BEFORE the 429.
    store.setExplicitStatus(TID, "paused")
    expect(store.get(TID)?.status).toBe("paused")

    const llm = new ScriptedLLM([thr(rateLimit429(RETRY_AFTER_MS)), ev(text("done"))])
    const out = await withTimeout(
      runAgent(cfg({ llm, sessionId: TID, objective: store, maxTurns: 4 })),
      20_000,
      "usage-limited-429-noresurrect",
    )
    expect(out.reason).toBe("completed")

    // NO-RESURRECT: the wire's guard returned before markUsageLimited (call
    // count 0) — a transient rate limit never overrides a user-paused goal.
    // (Derive priority puts usage_limited OVER paused, so WITHOUT the guard this
    // would flip to usage_limited — hence a real, non-vacuous regression fence.)
    expect(marks()).toBe(0)
    expect(store.get(TID)?.status).toBe("paused")
    // And no latent window: advancing the clock still shows paused.
    clock += RETRY_AFTER_MS + 1
    expect(store.get(TID)?.status).toBe("paused")
  })
})

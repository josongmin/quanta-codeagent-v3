/**
 * Background (speculative) compaction controller — ADR-0473.
 *
 * WHAT: when the live transcript is APPROACHING (not at) the context-window
 * ceiling, start a CANCELLABLE summarize() as a background promise while the
 * turn keeps running. At the turn boundary, install the produced summary ONLY
 * if it (a) completed successfully AND (b) frees enough headroom (the AND of
 * the two REQUIRED persist thresholds). Otherwise discard under a closed
 * {@link DiscardReason} — so a failed/aborted/too-small summarize NEVER
 * corrupts live history (2-phase install: old context stays until a good
 * summary actually lands).
 *
 * ADR: 0473.
 *
 * Slices imported: `@/shared` (logger/errMessage for NO-THROW side-channel) +
 * this slice's own `./types`. NO `@/llm`: the summarize primitive arrives as the
 * INJECTED {@link SpeculativeSummarizeFn} (port inversion, mirrors
 * @/permission ClassifierPort). The clock is the INJECTED {@link Clock}.
 *
 * NO-THROW contract: every method returns a value. The injected summarizer is
 * Result-shaped; this module additionally wraps its invocation in try/catch so
 * an adapter that breaks its no-throw promise still degrades to a typed discard
 * instead of an unhandled rejection.
 *
 * DEFAULT-OFF: the host constructs this controller ONLY when the gate
 * (QUANTA_BG_COMPACTION === "1") is on. The OFF path never references it ⇒
 * byte-identical to the existing synchronous reactiveCompact / compactIfNeeded
 * flow.
 */

import { errMessage, gateOnStrict, logger, type Result } from "@/shared"
import {
  BG_COMPACTION_ENV,
  type BgCompactionConfig,
  type CancelToken,
  type Clock,
  type DiscardReason,
  type ReconcileOutcome,
  type SpeculativeSummarizeFn,
  type SummarizeError,
  type UsageSnapshot,
} from "./types"

/** Pure gate check. `true` ⇒ background compaction is opted in for this
 *  deployment. Reads ONLY the injected env record (never `process.env` — slice
 *  boundary). Strict `=== "1"`. */
export const bgCompactionEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  gateOnStrict(env, BG_COMPACTION_ENV)

/**
 * "Approaching the limit" predicate. We begin a speculative summarize when free
 * headroom has dropped to/below EITHER configured start floor (OR — start
 * early/eagerly; the persist gate is the conservative side). Pure arithmetic;
 * no magic numbers (both floors are required config).
 *
 * A degenerate `limitTokens <= 0` (no meaningful window) ⇒ never start (we have
 * no gap to reason about); returns `false` rather than dividing by zero.
 */
export const isApproachingLimit = (usage: UsageSnapshot, cfg: BgCompactionConfig): boolean => {
  if (usage.limitTokens <= 0) return false
  const unusedTokens = usage.limitTokens - usage.usedTokens
  const unusedPercent = unusedTokens / usage.limitTokens
  return unusedTokens <= cfg.startAtUnusedTokens || unusedPercent <= cfg.startAtUnusedPercent
}

/**
 * Does a completed summary free ENOUGH to be worth installing? Both required
 * persist floors must hold (AND). `resultingTokens` is the summarizer's
 * estimate of the post-install transcript footprint; `freed = used - resulting`
 * (clamped non-negative — a summary larger than the prefix it replaced frees 0,
 * never a negative). Pure; no magic numbers.
 */
export const meetsPersistThreshold = (
  usedTokens: number,
  resultingTokens: number,
  limitTokens: number,
  cfg: BgCompactionConfig,
): boolean => {
  const freed = Math.max(usedTokens - resultingTokens, 0)
  const freedPercent = limitTokens > 0 ? freed / limitTokens : 0
  return freed >= cfg.persistUnusedTokens && freedPercent >= cfg.persistUnusedPercent
}

/** A minimal cancel token (no AbortController dependency — env-free slice). */
const makeCancelToken = (): CancelToken => {
  let aborted = false
  return {
    get aborted() {
      return aborted
    },
    abort() {
      aborted = true
    },
  }
}

/** Internal in-flight state for the single active background pass. */
interface PassState<S> {
  /** The background summarize promise. Never rejects (wrapped). */
  readonly promise: Promise<Result<SummarizeOk<S>, SummarizeError>>
  readonly cancel: CancelToken
  /** The usage snapshot captured when the pass started — the persist gate at
   *  the boundary compares the produced summary against THIS used-tokens count
   *  (the transcript we speculatively summarized), not a later mutated value. */
  readonly startedUsage: UsageSnapshot
  /** Wall time the pass started (ms) — for the side-channel log only. */
  readonly startedAt: number
  /** Mutable settlement record — `undefined` while in flight, set by the
   *  `invokeSafely` `.then` when the wrapped promise resolves. The reconcile
   *  path reads THIS (after flushing the microtask queue) instead of racing the
   *  promise against a same-tick sentinel: an `async` summarizer that "returns
   *  immediately" still resolves one microtask later, so a naive race would
   *  always lose to a synchronously-resolved sentinel and mis-report a finished
   *  pass as not-completed. */
  settled?: Result<SummarizeOk<S>, SummarizeError>
}

interface SummarizeOk<S> {
  summary: S
  resultingTokens: number
}

/** How many microtask turns reconcile yields before reading the settlement
 *  flag. The host calls reconcile only AFTER the model turn fully resolved, so a
 *  completed background summarize has already settled its promise; this bounded
 *  drain just lets the `.then` that records the settlement run. NOT a timing
 *  heuristic on the summarizer (a still-running pass stays unsettled across any
 *  number of microtask flushes) — it only flushes the already-queued resolution
 *  callbacks. Two passes covers the `await summarize() → .then record` chain. */
const SETTLEMENT_DRAIN_MICROTASKS = 2

/**
 * Controller over the EXISTING summarize primitive (injected) + injected Clock.
 *
 * Lifecycle per turn:
 *   1. `maybeStart(usage)` — idempotent; begins a background pass iff we are
 *      approaching the limit AND no pass is already in flight. Returns whether
 *      a pass is now active.
 *   2. `cancelIfPending()` — the host calls this when the turn ends EARLY
 *      (before the boundary needs the summary) so a moot pass stops spending.
 *   3. `reconcileAtTurnBoundary(currentUsage)` — install | discard(reason).
 *      Non-blocking: if the pass has not yet completed it is discarded as
 *      `not-completed` (we never stall the turn boundary waiting on speculation)
 *      and cancelled so it does not keep spending.
 *
 * Generic over the installed-summary payload `S` (e.g. the host's Message[]).
 */
export class BackgroundSummarizationController<S> {
  private pass: PassState<S> | undefined

  constructor(
    private readonly summarize: SpeculativeSummarizeFn<S>,
    private readonly clock: Clock,
    private readonly cfg: BgCompactionConfig,
  ) {}

  /** `true` iff a background pass is currently in flight. */
  hasPendingPass(): boolean {
    return this.pass !== undefined
  }

  /**
   * Begin a speculative summarize iff approaching the limit and none in flight.
   * Idempotent: a second call while a pass is active is a no-op (returns the
   * already-active state). Returns `true` iff a pass is active after this call.
   * NO-THROW.
   */
  maybeStart(usage: UsageSnapshot): boolean {
    if (this.pass !== undefined) return true
    if (!isApproachingLimit(usage, this.cfg)) return false
    const cancel = makeCancelToken()
    const startedAt = this.clock()
    // Wrap the injected summarizer so even a misbehaving adapter that rejects
    // (breaking its no-throw promise) collapses to a typed `other` error — the
    // controller never propagates an unhandled rejection.
    const promise = this.invokeSafely(cancel)
    const pass: PassState<S> = { promise, cancel, startedUsage: usage, startedAt }
    // Record settlement when the wrapped promise resolves so reconcile can read
    // a flag (after a bounded microtask drain) rather than race the promise.
    void promise.then((r) => {
      pass.settled = r
    })
    this.pass = pass
    return true
  }

  /** Wrap the injected summarizer: convert a thrown/rejected adapter into a
   *  typed `{ok:false}` so the in-flight promise NEVER rejects. NO-THROW. */
  private async invokeSafely(cancel: CancelToken): Promise<Result<SummarizeOk<S>, SummarizeError>> {
    try {
      return await this.summarize({ cancel })
    } catch (e) {
      return {
        ok: false,
        error: { kind: "other", detail: errMessage(e) },
      }
    }
  }

  /**
   * Cancel a pending pass (turn ended early ⇒ the speculation is moot). The
   * injected summarizer observes `cancel.aborted` and stops; the next
   * `reconcileAtTurnBoundary` will see the (now-cancelled) pass. Idempotent;
   * no-op when nothing is pending. NO-THROW.
   */
  cancelIfPending(): void {
    if (this.pass === undefined) return
    try {
      this.pass.cancel.abort()
    } catch (e) {
      // side-channel — abort must never perturb the turn. log + swallow.
      logger.warn(`bg-compaction.cancelIfPending: ${errMessage(e)}`)
    }
  }

  /**
   * Reconcile at the turn boundary. The 2-phase install crux: we ONLY return
   * `install` when the pass completed successfully AND cleared the persist
   * threshold AND was not cancelled. Every other path returns `discard` with a
   * closed reason and leaves live history untouched (the host applies the
   * install ONLY on `kind:"install"`).
   *
   * `currentUsage` is the live usage at the boundary; the persist gate compares
   * the produced summary's `resultingTokens` against the usage captured WHEN THE
   * PASS STARTED (the transcript that was actually summarized) — using the live
   * value would mis-judge a summary against a transcript that grew after the
   * speculative snapshot.
   *
   * Non-blocking: we do NOT await indefinitely. The host should only call this
   * once the model turn has fully resolved; by then the background summarize has
   * had the entire turn to finish. We race the settled promise against an
   * already-resolved sentinel so a still-in-flight pass returns `not-completed`
   * rather than stalling the boundary. The pass is consumed (cleared) either
   * way. NO-THROW.
   */
  async reconcileAtTurnBoundary(currentUsage: UsageSnapshot): Promise<ReconcileOutcome<S>> {
    const pass = this.pass
    if (pass === undefined) {
      return { kind: "discard", reason: "no-pass-started" }
    }
    // Pass wall-duration (injected clock) for the side-channel log only — never
    // a control-flow input (no timing heuristic). Lets an operator see how long
    // a speculative pass ran before it installed/discarded.
    const elapsedMs = Math.max(this.clock() - pass.startedAt, 0)
    // Consume the pass up front — a single reconcile resolves it regardless of
    // branch, and we never want a second reconcile to double-install.
    this.pass = undefined

    // If the turn ended early and we already aborted, the result is moot even
    // if the underlying promise happens to have settled — discard as cancelled.
    if (pass.cancel.aborted) {
      void this.drain(pass.promise)
      return { kind: "discard", reason: "cancelled" }
    }

    // Flush the already-queued resolution callbacks (incl. the settlement
    // recorder) WITHOUT awaiting the promise itself — so a still-in-flight pass
    // stays `undefined` and is reported not-completed instead of stalling.
    for (let i = 0; i < SETTLEMENT_DRAIN_MICROTASKS; i++) {
      await Promise.resolve()
    }
    const settled = pass.settled
    if (settled === undefined) {
      // Still in flight at the boundary: do not stall. Cancel so it stops
      // spending and discard. This is the "turn ended before the summary was
      // ready" case (no wasted spend beyond what already ran).
      pass.cancel.abort()
      void this.drain(pass.promise)
      return { kind: "discard", reason: "not-completed" }
    }

    if (!settled.ok) {
      // Failed summarize MUST NOT corrupt history. Map an input-limit failure to
      // its dedicated reason; everything else is a generic summarizer error.
      const reason: DiscardReason =
        settled.error.kind === "input-limit" ? "input-limit-failure" : "summarizer-error"
      logger.debug(
        `bg-compaction.reconcile: discard ${reason} after ${elapsedMs}ms (${settled.error.detail})`,
      )
      return { kind: "discard", reason }
    }

    // Completed successfully — apply the persist gate against the snapshot we
    // speculatively summarized (startedUsage), using the live window ceiling.
    const used = pass.startedUsage.usedTokens
    const limit = currentUsage.limitTokens
    if (!meetsPersistThreshold(used, settled.value.resultingTokens, limit, this.cfg)) {
      logger.debug(`bg-compaction.reconcile: discard below-persist-threshold after ${elapsedMs}ms`)
      return { kind: "discard", reason: "below-persist-threshold" }
    }
    const freedTokens = Math.max(used - settled.value.resultingTokens, 0)
    logger.debug(
      `bg-compaction.reconcile: install freed ${freedTokens} tokens after ${elapsedMs}ms`,
    )
    return { kind: "install", summary: settled.value.summary, freedTokens }
  }

  /** Swallow the result of an abandoned promise so an aborted/late summarize
   *  does not surface as an unhandled rejection. NO-THROW. */
  private drain(promise: Promise<unknown>): Promise<void> {
    return promise.then(
      () => undefined,
      (e) => {
        logger.debug(`bg-compaction.drain: ${errMessage(e)}`)
      },
    )
  }
}

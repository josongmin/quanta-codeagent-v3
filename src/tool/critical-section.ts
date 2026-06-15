/**
 * jun-6 tool-interrupt-behavior — the PURE per-call interrupt-routing state
 * machine that the dispatch abort-router (`@/agent`) wraps for a tool that
 * declares `interruptBehavior(): "block"`. This file is a `@/tool` slice LEAF:
 * it imports nothing from `@/agent`, takes every collaborator by injection
 * (closed-port DI), and contains NO `Date.now` / `Math.random` / ambient state.
 *
 * Model (RFC §4.3). A `"block"` tool runs over a SUPPRESSIBLE derived signal
 * that normally mirrors the upstream turn signal (`config.signal`). The dispatch
 * router threads `derived` into `ctx.signal` and hands the tool a
 * {@link CriticalSectionSeam} backed by this router:
 *
 *   - Outside a section, an upstream abort propagates to `derived` IMMEDIATELY
 *     (byte-identical to the uniform cancel path).
 *   - `begin()` opens a withhold window: while it is open an upstream abort is
 *     CAPTURED but NOT propagated to `derived`, so the tool's atomic FS-mutating
 *     window (rename/flush) finishes whole.
 *   - `end()` closes the window and, if an abort arrived while withheld,
 *     force-delivers it to `derived` SYNCHRONOUSLY (the tool's very next
 *     `signal.aborted` check post-rename sees `true`). Idempotent.
 *   - A WATCHDOG cap force-delivers a withheld abort after a bounded
 *     `maxMs` even if the tool never calls `end()` — `block` can DEFER a cancel
 *     across one bounded window, it can NEVER swallow it.
 *
 * The watchdog timer is INJECTED (a `schedule` port) so the helper stays pure
 * and tests are deterministic; the dispatch composition root supplies a real
 * `setTimeout`-backed scheduler, hellgate tests supply a fake clock+scheduler.
 */

/** Injected one-shot timer. `schedule(ms, cb)` arms a timer that fires `cb`
 *  after `ms`; the returned thunk cancels it (idempotent). The dispatch root
 *  wires this to `setTimeout`/`clearTimeout`; tests wire a deterministic fake.
 *  NO ambient timer is used inside this slice. */
export interface CriticalSectionScheduler {
  schedule(ms: number, cb: () => void): () => void
}

/** Observer for the operator-facing StatusBar line (RFC §5). The dispatch root
 *  adapts these onto the existing event stream; absent ⇒ no events (no-op). All
 *  callbacks are NO-THROW by contract. `reason: "deferred"` when an upstream
 *  abort is withheld because a section is open; `"watchdog"` when the cap
 *  force-delivered it. */
export interface InterruptRouterObserver {
  /** An upstream abort was WITHHELD because a critical section is open. */
  onDeferred?(): void
  /** The withheld abort was honored — either at `end()` (`reason:"end"`) or by
   *  the watchdog cap (`reason:"watchdog"`). */
  onHonored?(reason: "end" | "watchdog"): void
}

export interface MakeInterruptRouterArgs {
  /** The upstream turn signal (`config.signal`). */
  readonly source: AbortSignal
  /** The suppressible derived controller whose `signal` is threaded into
   *  `ctx.signal`. The router aborts it (mirroring `source`) EXCEPT while a
   *  section withholds. The caller owns construction so the same controller can
   *  be threaded into the ToolContext. */
  readonly derived: AbortController
  /** Injected monotonic clock (ms). NO `Date.now` in this slice. */
  readonly now: () => number
  /** Watchdog cap: the maximum time a section may withhold an abort before it is
   *  force-delivered. Must be a finite, non-negative number. */
  readonly maxMs: number
  /** Injected one-shot timer for the watchdog. */
  readonly scheduler: CriticalSectionScheduler
  /** Optional StatusBar observer (RFC §5). Absent ⇒ no events. */
  readonly observer?: InterruptRouterObserver
}

/** The router handed to the dispatch root. `seam` is threaded onto
 *  `ctx.criticalSection`; `dispose()` MUST be called when the tool's `execute`
 *  settles (success OR throw) so the upstream listener and any armed watchdog
 *  are released. */
export interface InterruptRouter {
  readonly seam: CriticalSectionSeam
  /** Release the upstream listener + any armed watchdog. Idempotent. */
  dispose(): void
}

// Local mirror of the seam shape (kept duck-typed; the canonical type lives in
// ./types and is what the ToolContext field is typed as). Re-declared as the
// public return contract so this file does not depend on import ordering.
interface CriticalSectionSeam {
  begin(): { end(): void }
}

/**
 * Build the per-call interrupt router for a `"block"` tool. PURE: deterministic
 * given the injected `source` / `now` / `scheduler`.
 *
 * Lifecycle: construct ONE per tool dispatch, thread `derived.signal` into
 * `ctx.signal` and `router.seam` into `ctx.criticalSection`, then `dispose()`
 * when `execute` settles.
 *
 * Invariants:
 *   - At most one withhold window is open at a time (the seam is per-call; a
 *     re-`begin()` while open is treated as a nested no-op that shares the
 *     window — `write`/`edit` open exactly one).
 *   - An abort is NEVER lost: if `source` aborts while open it is captured and
 *     re-delivered on `end()` (sync) or by the watchdog (bounded), whichever is
 *     first; if `source` aborts while CLOSED it propagates immediately.
 *   - `end()` is idempotent and NO-THROW.
 */
export const makeInterruptRouter = (args: MakeInterruptRouterArgs): InterruptRouter => {
  const { source, derived, now, maxMs, scheduler, observer } = args

  // Depth of nested begin() calls. >0 ⇒ a withhold window is open.
  let openDepth = 0
  // An upstream abort observed while withholding, not yet delivered to derived.
  let pendingAbort = false
  // Already aborted derived (or disposed) ⇒ all further work is a no-op.
  let settled = false
  // Cancels the armed watchdog (undefined ⇒ none armed).
  let cancelWatchdog: (() => void) | undefined
  // Wall-clock deadline for the OPEN window (set on the outermost begin()).
  let deadlineAt = 0

  const clearWatchdog = (): void => {
    if (cancelWatchdog !== undefined) {
      cancelWatchdog()
      cancelWatchdog = undefined
    }
  }

  // Force-deliver a captured abort to the derived signal. `via` distinguishes a
  // normal end() handoff from a watchdog force-delivery for the observer.
  const deliver = (via: "end" | "watchdog" | "immediate"): void => {
    if (settled) return
    settled = true
    clearWatchdog()
    openDepth = 0
    pendingAbort = false
    if (via !== "immediate") observer?.onHonored?.(via)
    if (!derived.signal.aborted) derived.abort(source.reason)
  }

  // Upstream abort listener. The single source of truth for "an interrupt
  // happened". Routes immediately when closed, captures when withholding.
  const onSourceAbort = (): void => {
    if (settled) return
    if (openDepth > 0) {
      // Withholding: capture, surface the deferred line ONCE, let the section
      // (or the watchdog) deliver it.
      if (!pendingAbort) {
        pendingAbort = true
        observer?.onDeferred?.()
        // Always re-arm from CAPTURE time so the watchdog bounds the WITHHELD
        // duration from when the abort was captured, never from window-open.
        // Case A: the window-open watchdog already expired abort-free → no
        //   live timer; `clearWatchdog()` is a no-op; fresh arm starts now.
        // Case B: the window-open watchdog is still live → cancel it (it would
        //   fire too early) and replace it with a capture-relative deadline.
        clearWatchdog()
        deadlineAt = now() + Math.max(0, Number.isFinite(maxMs) ? maxMs : 0)
        armWatchdog()
      }
      return
    }
    // Closed: propagate now — byte-identical to the uniform cancel path.
    deliver("immediate")
  }

  // If the source ALREADY aborted before we attached, mirror it eagerly so a
  // tool that opened no section is byte-identical to today.
  if (source.aborted) {
    deliver("immediate")
  } else {
    source.addEventListener("abort", onSourceAbort, { once: true })
  }

  const onWatchdogExpiry = (): void => {
    cancelWatchdog = undefined
    // Only force-deliver if there is actually a captured abort being withheld.
    // A long-but-abort-free section is fine; the cap only bounds a WITHHELD
    // cancel, it does not interrupt an un-aborted tool.
    if (openDepth > 0 && pendingAbort) deliver("watchdog")
  }

  const armWatchdog = (): void => {
    // Re-arm against the deadline computed at window open. A non-finite or
    // negative cap collapses to 0 (deliver on next tick) — fail-safe, never a
    // permanent hold.
    const remaining = Math.max(0, deadlineAt - now())
    cancelWatchdog = scheduler.schedule(remaining, onWatchdogExpiry)
  }

  const seam: CriticalSectionSeam = {
    begin() {
      // A re-begin while already open shares the existing window (nested
      // sections collapse). Only the OUTERMOST begin sets the deadline + arms
      // the watchdog.
      openDepth += 1
      if (openDepth === 1 && !settled) {
        deadlineAt = now() + Math.max(0, Number.isFinite(maxMs) ? maxMs : 0)
        armWatchdog()
        // Edge: source aborted in the same tick between attach and begin — the
        // listener already captured it; the watchdog (or end) will deliver.
      }
      let ended = false
      return {
        end() {
          if (ended) return // idempotent
          ended = true
          if (settled) return
          openDepth = Math.max(0, openDepth - 1)
          if (openDepth > 0) return // inner section closed; window still open
          clearWatchdog()
          if (pendingAbort) {
            // Honor the withheld abort SYNCHRONOUSLY so the tool's next
            // signal.aborted check (post-rename) sees true.
            deliver("end")
          }
        },
      }
    },
  }

  return {
    seam,
    dispose() {
      if (settled) {
        clearWatchdog()
        return
      }
      settled = true
      clearWatchdog()
      source.removeEventListener("abort", onSourceAbort)
    },
  }
}

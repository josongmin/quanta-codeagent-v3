import type { StreamPort } from "@/stream"
import type { LifecyclePills } from "../lifecycle-pills"
import type { StatusBar } from "../status-bar"
import type { TurnIndicator } from "../turn-indicator"
import type { TurnSummaryCollector } from "../turn-summary"
import { installTurnCancel } from "./turn-cancel-install"

/** Tag the outcome of a single REPL turn. `result === undefined` means the
 *  turn was either soft-aborted (Esc-Esc) or threw a NON-abort error that the
 *  driver displayed inline (REPL survived). The host should consult the
 *  caller-passed handler for the side effects (history reassignment, follow-up
 *  pills flush) — those are the responsibility of the host, NOT the runner. */
export interface RunOneTurnResult<R> {
  readonly result: R | undefined
  /** Wall-clock duration of the turn body. Surface-only signal — the runner
   *  does NOT consume it; the host can use it for /work or /stats output. */
  readonly durationMs: number
  /** True iff the turn body was aborted via the turn-scoped (Esc-Esc) signal
   *  AND the outer abort was NOT also fired. Use this to distinguish "user
   *  cancelled this turn" from "the whole REPL is shutting down". */
  readonly turnAborted: boolean
}

/** Renderers + sinks the per-turn wrapper invokes. Each is OPTIONAL — when
 *  the surface didn't build it, the wrapper short-circuits with NO writes
 *  (byte-identical default-OFF mirrors the prior inline `if (metrics)` /
 *  `if (summary !== "")` gates). */
export interface RunOneTurnSinks<R> {
  /** Fold the per-turn cost+cache dashboard after `result` resolves. Caller
   *  owns the metrics snapshot + cost panel state — the runner just invokes
   *  the closure when present. */
  readonly onAfterResult?: (result: R) => void
  /** Convert a thrown NON-abort error into surface output (status bar +
   *  stderr line). Called from the catch branch ONLY when the abort signal
   *  was NOT the cause; abort flow swallows silently. */
  readonly onError?: (err: unknown) => void
}

/** Dependencies bag for {@link runOneTurn}. Every dep is explicit so the
 *  runner owns ZERO closure captures over the surface state — the host
 *  passes the same deps verbatim from the two call sites (one-shot + each
 *  interactive turn) and the runner cannot drift out of sync with the
 *  surface's indicator/summary/pills lifecycle. */
export interface RunOneTurnDeps<R> {
  /** Outer surface-wide AbortController (Ctrl+C, SIGINT). */
  readonly outerAbort: AbortController
  readonly statusBar: StatusBar
  /** Live turn indicator (spinner + elapsed + tokens). `start()`/`stop()` are
   *  no-ops when the indicator is disabled (non-TTY / `QUANTA_SPINNER=0`) so
   *  the runner can always call them without a gate. */
  readonly turnIndicator: TurnIndicator
  /** Per-turn signal collector. `reset()` is called BOTH after a successful
   *  `render(...)` and in the `finally` (defensive — idempotent on fresh
   *  collector). */
  readonly turnSummary: TurnSummaryCollector
  /** Esc-Esc cancellation window (ms). The host passes the same constant
   *  the prior inline code used (2000 ms); param-driven so tests can shrink
   *  it without hitting the keypress FSM directly. */
  readonly escWindowMs: number
  /** The turn body. Receives the composite signal that fires on EITHER
   *  outer-abort or turn-abort (Esc-Esc). One-shot path: `runOnce({...deps,
   *  signal})`. Interactive path: `run({...deps, signal})` where `run` is
   *  the lambda passed by `runInteractive`'s `wrapTurn`. */
  readonly body: (turnSignal: AbortSignal) => Promise<R>
  /** Optional surface-stream side-channel — currently unused by the wrapper
   *  itself (the indicator already tees via `TeeStream`), kept for forward
   *  compat with future per-turn renderers (e.g. progress audit). */
  readonly stream?: StreamPort
  /** Lifecycle pills handle — present for parity with the inline turn(),
   *  but the runner does NOT flush here (the host's `onAfterResult` /
   *  `onTurnEnd` owns the flush). Kept on the deps bag so future runners
   *  can render a per-turn pill summary without changing the call sites. */
  readonly lifecyclePills?: LifecyclePills
}

/** Run ONE REPL turn with the standard surface wrappers:
 *
 *   1. Build per-turn `AbortController` ⇒ composite `turnSignal` =
 *      `AbortSignal.any([outerAbort.signal, turnAbort.signal])`.
 *   2. Install Esc-Esc / Ctrl+C keypress FSM (via {@link installTurnCancel}).
 *   3. Start the turn indicator. Register a `once: true` abort listener that
 *      tears down the indicator the moment the abort fires (so the spinner
 *      vanishes on Esc-Esc without waiting for the LLM stream to unwind).
 *   4. Run `body(turnSignal)`. On success ⇒ invoke `onAfterResult`.
 *   5. On error: a turn-scoped-only abort returns silently (REPL alive); any
 *      other error invokes `onError` (surface error display).
 *   6. `finally` clears: abort listener, indicator, cancel dispose, summary
 *      reset (safety net).
 *
 *  This is the SINGLE module that replaces the prior `turn` closure
 *  (one-shot, repl.ts:1335-1428) AND `wrapTurn` (interactive, repl.ts:
 *  1508-1544) — the DRY win the SOLID split spec calls for. The two call
 *  sites supply DIFFERENT `body` lambdas (one calls `runOnce` with the
 *  prompt + seedImages, the other forwards the driver-supplied `run`) but
 *  the wrapper around them is identical. */
export const runOneTurn = async <R>(
  deps: RunOneTurnDeps<R>,
  sinks: RunOneTurnSinks<R>,
): Promise<RunOneTurnResult<R>> => {
  const { outerAbort, statusBar, turnIndicator, turnSummary, escWindowMs, body } = deps
  const turnAbort = new AbortController()
  const turnSignal = AbortSignal.any([outerAbort.signal, turnAbort.signal])
  const cancel = installTurnCancel({
    statusBar,
    escWindowMs,
    onCancel: () => turnAbort.abort(),
    onAbort: () => outerAbort.abort(),
  })
  turnIndicator.start()
  const onAbortStopIndicator = (): void => turnIndicator.stop()
  turnSignal.addEventListener("abort", onAbortStopIndicator, { once: true })

  const startMs = Date.now()
  let result: R | undefined
  let turnAborted = false
  try {
    result = await body(turnSignal)
    sinks.onAfterResult?.(result)
  } catch (e) {
    // A turn-scoped abort is the user's intent; swallow the error.
    // Stop the indicator BEFORE the error transient so the status bar
    // doesn't paint over the message a moment later.
    turnIndicator.stop()
    if (turnAbort.signal.aborted && !outerAbort.signal.aborted) {
      turnAborted = true
    } else {
      sinks.onError?.(e)
    }
    result = undefined
  } finally {
    turnSignal.removeEventListener("abort", onAbortStopIndicator)
    turnIndicator.stop()
    cancel.dispose()
    // Safety net: the happy path resets immediately after render; this
    // catches the error/abort path. Idempotent on a fresh collector.
    turnSummary.reset()
  }
  return { result, durationMs: Date.now() - startMs, turnAborted }
}

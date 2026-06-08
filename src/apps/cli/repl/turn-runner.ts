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
  /** Ticket 18 (V1) — true iff the user pressed Ctrl+B and the turn was MOVED to
   *  the background. When set: `result` is `undefined`, `onAfterResult` was NOT
   *  fired, the body was NOT cancelled (it keeps running, handed to the portal
   *  via `onMovedToBackground`), and the host should `continue` the loop to a
   *  fresh prompt (NOT fold history). Absent ⇒ the legacy synchronous turn path
   *  ran (byte-identical default-OFF). */
  readonly backgrounded?: boolean
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
  /** Ticket 18 (V1) — Ctrl+B detach handler. When wired, the runner installs a
   *  `onBackground` sink on the cancel FSM and races the body against a
   *  background-signal. If Ctrl+B wins, the runner hands the host the STILL-LIVE
   *  body promise + the turn's AbortController (so the portal can observe/cancel
   *  it) and returns `{ backgrounded:true, result:undefined }` WITHOUT firing
   *  `onAfterResult` and WITHOUT aborting the body. Absent ⇒ no Ctrl+B sink is
   *  wired and the turn runs the legacy synchronous path (byte-identical). */
  readonly onMovedToBackground?: (handle: {
    readonly body: Promise<R>
    readonly turnAbort: AbortController
  }) => void
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
  // Ticket 18 (V1) — background-signal promise. Resolves (with the sentinel)
  // ONLY when the user presses Ctrl+B AND the host wired `onMovedToBackground`.
  // When the handler is absent, `onBackground` is never installed on the FSM
  // (so the Ctrl+B branch is skipped, byte-identical) and this promise never
  // resolves — the race below degrades to a single `body(...)` await.
  const BG = Symbol("backgrounded")
  let signalBackground: (() => void) | undefined
  const bgSignal = new Promise<typeof BG>((res) => {
    signalBackground = () => res(BG)
  })
  const cancel = installTurnCancel({
    statusBar,
    escWindowMs,
    onCancel: () => turnAbort.abort(),
    onAbort: () => outerAbort.abort(),
    // Only wire the Ctrl+B sink when the host opted in; absent ⇒ FSM byte-identical.
    ...(deps.onMovedToBackground !== undefined
      ? { onBackground: () => signalBackground?.() }
      : {}),
  })
  turnIndicator.start()
  const onAbortStopIndicator = (): void => turnIndicator.stop()
  turnSignal.addEventListener("abort", onAbortStopIndicator, { once: true })

  const startMs = Date.now()
  let result: R | undefined
  let turnAborted = false
  let backgrounded = false
  try {
    // Capture the live body promise ONCE so a Ctrl+B win can hand the SAME
    // (still-running) promise to the portal without re-invoking `body`.
    const bodyPromise = body(turnSignal)
    const raced =
      deps.onMovedToBackground !== undefined
        ? await Promise.race([bodyPromise.then((r) => ({ r })), bgSignal])
        : { r: await bodyPromise }
    if (raced === BG) {
      // Ctrl+B won the race: hand the LIVE body promise + the turn's abort
      // controller to the host (portal). Do NOT await the body again, do NOT
      // abort it (it keeps running), and do NOT fire onAfterResult.
      backgrounded = true
      result = undefined
      deps.onMovedToBackground?.({ body: bodyPromise, turnAbort })
    } else {
      result = raced.r
      sinks.onAfterResult?.(result)
    }
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
  return {
    result,
    durationMs: Date.now() - startMs,
    turnAborted,
    // Spread-by-presence: omit the flag entirely on the legacy path so the
    // result shape is byte-identical when Ctrl+B was never wired/pressed.
    ...(backgrounded ? { backgrounded: true } : {}),
  }
}

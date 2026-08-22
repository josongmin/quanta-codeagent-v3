/**
 * Default focus-chain tracker implementation (ADR-0219).
 *
 * In-memory state machine: holds a frozen snapshot of the current todos +
 * three monotonic counters (current turn / last injection turn / last
 * activity turn). Pure data structures + the injector + drift detector
 * compose the public surface.
 *
 * Default-OFF posture: the host MUST construct + thread this tracker
 * explicitly. When absent, the loop's prompt assembly is byte-identical.
 *
 * Concurrency: not thread-safe (Node is single-threaded for our purposes,
 * but background subagents may invoke the same tracker concurrently if
 * the host shares it across forks — DO NOT). Each session should own ONE
 * tracker, mirroring the BG scheduler pattern.
 */

import { formatDriftWarning } from "./drift-detector"
import type { FocusChainPort, FocusTodo } from "./port"
import { renderTodos, sanitizeTodo } from "./todo-injector"

export interface DefaultTrackerOpts {
  /** Re-inject every N turns. Default 6 (Cline operational value).
   *  Values ≤ 0 or non-finite ⇒ injection is disabled (always returns
   *  null) but tickTurn / setTodos / markDone still mutate state. */
  readonly reinjectEveryN?: number
  /** Drift window — N turns of zero todo activity ⇒ drift warning. Default
   *  5 (Cline operational value). Same null-on-bad-input rule as above. */
  readonly driftWindowTurns?: number
}

const DEFAULT_REINJECT_EVERY_N = 6
const DEFAULT_DRIFT_WINDOW = 5

/** Coerce a user-supplied number. Treats `0` as an EXPLICIT "disable" signal
 *  (returns 0, callers branch). Negative / NaN / Infinity ⇒ fallback default
 *  (operator typo defends to safe behaviour). `undefined` ⇒ fallback default. */
const coerce = (n: number | undefined, fallback: number): number => {
  if (n === undefined) return fallback
  if (!Number.isFinite(n)) return fallback
  if (n < 0) return fallback
  return Math.floor(n)
}

export const defaultFocusChainTracker = (opts: DefaultTrackerOpts = {}): FocusChainPort => {
  const reinjectEveryN = coerce(opts.reinjectEveryN, DEFAULT_REINJECT_EVERY_N)
  const driftWindowTurns = coerce(opts.driftWindowTurns, DEFAULT_DRIFT_WINDOW)

  let todos: readonly FocusTodo[] = Object.freeze([])
  let currentTurn = 0
  // Sentinel: 0 means "not yet injected". The first inject lands on turn
  // reinjectEveryN, subsequent ones at every Nth turn thereafter. We do
  // NOT inject on turn 0 (model just saw the todos elsewhere); we wait
  // for one full cycle.
  let lastInjectionTurn = 0
  // Activity tracking — set to currentTurn on every setTodos / markDone.
  // Initial value is 0 so a tracker that gets ticked without ever being
  // given todos doesn't trigger spurious drift (currentTurn - 0 starts
  // small and only grows; once it crosses the window the model's already
  // in trouble for another reason).
  let lastActivityTurn = 0

  const recordActivity = (): void => {
    lastActivityTurn = currentTurn
  }

  return {
    setTodos(input) {
      const sanitized: FocusTodo[] = []
      for (const raw of input) {
        const ok = sanitizeTodo(raw)
        if (ok !== null) sanitized.push(ok)
      }
      todos = Object.freeze(sanitized.map((t) => Object.freeze({ ...t })))
      recordActivity()
    },

    tickTurn() {
      if (!Number.isFinite(currentTurn)) return
      currentTurn += 1
    },

    getInjection() {
      const text = computeInjection()
      if (text === null) return null
      // Mark injected so a second call in the same turn returns null.
      lastInjectionTurn = currentTurn
      return text
    },

    peekInjection() {
      return computeInjection()
    },

    getDriftWarning() {
      // Only warn when we have todos — drift on an empty todo list is not
      // actionable.
      if (todos.length === 0) return null
      return formatDriftWarning({
        currentTurn,
        lastActivityTurn,
        windowTurns: driftWindowTurns,
      })
    },

    markDone(index) {
      if (!Number.isInteger(index)) return
      if (index < 0 || index >= todos.length) return
      const next = todos.map(
        (t, i): FocusTodo => (i === index ? Object.freeze({ ...t, state: "done" as const }) : t),
      )
      todos = Object.freeze(next)
      recordActivity()
    },

    snapshotTodos() {
      // Already frozen; expose as-is. Caller cannot mutate (frozen) and
      // even array-level mutation (push) is rejected.
      return todos
    },

    currentTurn() {
      return currentTurn
    },
  }

  function computeInjection(): string | null {
    if (reinjectEveryN <= 0) return null
    if (todos.length === 0) return null
    // Never inject on turn 0 — model just saw the todos at session start.
    if (currentTurn <= 0) return null
    // Inject when N turns have elapsed since the last injection (or since
    // session start, with lastInjectionTurn=0). Strictly >= so turn N is
    // the FIRST eligible turn after a fresh cycle.
    const since = currentTurn - lastInjectionTurn
    if (since < reinjectEveryN) return null
    return renderTodos(todos)
  }
}

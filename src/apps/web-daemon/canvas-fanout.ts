/**
 * DOF-40 — canvas fan-out fail-closed helper (web-daemon side).
 *
 * The canvas `*-source.ts` sources each fan a captured payload out to a
 * `Set` of subscribers (one per connected WS). Historically the fan-out
 * loop swallowed a throwing subscriber with a BARE `catch {}` so a dead /
 * throwing socket could not poison siblings or the producing tool. That
 * isolation is correct — but the swallow was SILENT: a live connection
 * whose `send` throws (not a graceful close) was starved with ZERO signal,
 * so an operator could not tell the sink had gone offline.
 *
 * This helper keeps the isolation (one throwing subscriber never aborts the
 * loop over the others) AND makes the failure OBSERVABLE via an optional
 * `onSubscriberError` seam. Default-OFF byte-identical: with no observer
 * injected the behavior is exactly the legacy swallow (continue to siblings,
 * no new emission) — the DIFFERENCE is that the failure is now ROUTABLE, not
 * unconditionally dropped.
 *
 * Slice fence: leaf module. Imports ONLY `@/shared` leaf utils (`errMessage`
 * for the surfaced message shape). NEVER `@/agent/loop`, `@/agent/dispatch`,
 * NEVER `@/apps/cli`.
 */

import { errMessage } from "@/shared"

/**
 * A surfaced subscriber-fan-out failure. Carries the thrown error, the
 * flattened message (for log lines), and the zero-based index of the
 * failing subscriber within the fan-out snapshot so an operator can
 * correlate WHICH connection went offline.
 */
export interface FanoutError {
  readonly error: unknown
  readonly message: string
  /** Index of the failing subscriber within the (snapshotted) fan-out set. */
  readonly subscriberIndex: number
}

/**
 * Optional error-observer seam. When provided, EACH throwing subscriber is
 * routed here (isolation preserved — the loop continues). When absent the
 * throw is swallowed exactly as the legacy bare `catch {}` did.
 */
export type FanoutErrorObserver = (err: FanoutError) => void

/** Shared construction options for the canvas `*-source.ts` fan-out sources. */
export interface CanvasSourceOptions {
  /** Optional fail-closed observer — a throwing subscriber routes here
   *  (isolation preserved) instead of being silently swallowed. Absent ⇒
   *  legacy swallow (default-OFF byte-identical). */
  readonly onSubscriberError?: FanoutErrorObserver
}

/**
 * Fan a value out to every subscriber, isolating throws so one failing
 * subscriber never starves the siblings. A throwing subscriber is routed to
 * `onError` (if present) and otherwise swallowed.
 *
 * Snapshot semantics: the subscriber set is copied BEFORE iteration so a
 * subscriber that unsubscribes mid-fan-out (e.g. a transport that closes on
 * send) does not perturb the loop.
 *
 * Returns the number of subscribers whose delivery THREW — a caller may
 * expose this as a health counter. Zero means every live subscriber was
 * fed.
 */
export const fanOutIsolated = <T>(
  subscribers: Iterable<(value: T) => void>,
  value: T,
  onError: FanoutErrorObserver | undefined,
): number => {
  let failures = 0
  const snapshot = [...subscribers]
  for (let i = 0; i < snapshot.length; i++) {
    try {
      snapshot[i]?.(value)
    } catch (error) {
      failures += 1
      if (onError !== undefined) {
        // Surface — but the OBSERVER itself must never break the fan-out. A
        // hostile / throwing observer is swallowed here (defense-in-depth):
        // isolation of siblings is the load-bearing invariant.
        try {
          onError({ error, message: errMessage(error), subscriberIndex: i })
        } catch {
          // observer threw — swallow; siblings still get fed below.
        }
      }
      // else: legacy silent swallow (byte-identical default-OFF).
    }
  }
  return failures
}

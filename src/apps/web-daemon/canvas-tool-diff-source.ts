/**
 * ADR-0440 wire-finish — canvas tool-diff source (web-daemon side).
 *
 * The agent's dispatch seam surfaces an optional {@link ToolDiffSink} onto the
 * `ToolContext`; a file-mutating tool (`write`/`edit`) calls `capture(...)` with
 * the full pre/post file text it ALREADY has after a successful mutation. This
 * source is the daemon-side concrete sink: the composition root wires its
 * `sink` into `AgentConfig.onToolDiff`, and every WS connection subscribes so
 * its per-connection canvas emitter forwards a `tool.diff` frame via
 * `feedToolDiff(...)`.
 *
 * NO recompute: the captured before/after strings are fanned out VERBATIM; the
 * line-diff math + caps + binary probe run ONCE per connection inside
 * `feedToolDiff` (the emitter), never here. There is NO `latest()`
 * snapshot-on-connect for diffs (unlike usage): a diff is a point-in-time
 * mutation event — a fresh connection renders diffs from the next mutation
 * forward, it does not replay history.
 *
 * Default-OFF: the composition root only constructs this when
 * `QUANTA_WEB_CANVAS=1`. Absent that, `onToolDiff` is never wired ⇒ no tool
 * captures anything ⇒ no `tool.diff` frame ⇒ chat UI unchanged, byte-identical.
 *
 * Slice fence: this module lives in `@/apps/web-daemon` and only references the
 * duck-typed capture shape (mirrored from `@/tool`'s `ToolDiffSink`); it never
 * imports `@/agent/loop` or `@/apps/cli`. The `@/tool` slice never imports this
 * — the composition root is the only bridge.
 *
 * DOF-40 — fail-closed: a throwing subscriber is ISOLATED (siblings still
 * fed) but the failure is now OBSERVABLE via the optional `onSubscriberError`
 * seam, not silently starved. Default-OFF byte-identical: no observer ⇒
 * legacy swallow.
 */

import { type CanvasSourceOptions, fanOutIsolated } from "./canvas-fanout"

/** A captured tool mutation: the full pre/post file text + correlation id. */
export interface CapturedToolDiff {
  readonly toolCallId: string
  readonly before: string
  readonly after: string
  readonly path?: string
}

export interface CanvasToolDiffSourceHandle {
  /** Wire into `AgentConfig.onToolDiff`. Fans the capture out to subscribers. */
  readonly sink: { capture(input: CapturedToolDiff): void }
  /** Subscribe to subsequent captures. Returns an unsubscribe closure. */
  readonly subscribe: (handler: (diff: CapturedToolDiff) => void) => () => void
  /** Cumulative count of subscriber deliveries that THREW (health signal). */
  readonly failureCount: () => number
}

/** Create a fresh canvas tool-diff source. One per daemon (shared across the
 *  daemon's connections, like the shared session + usage source). */
export const createCanvasToolDiffSource = (
  opts: CanvasSourceOptions = {},
): CanvasToolDiffSourceHandle => {
  const subscribers = new Set<(diff: CapturedToolDiff) => void>()
  let failures = 0
  return {
    sink: {
      capture: (input) => {
        // Isolate throws (siblings + the already-written file are safe) AND
        // surface them via the optional observer. Absent observer ⇒ legacy
        // swallow (byte-identical).
        failures += fanOutIsolated(subscribers, input, opts.onSubscriberError)
      },
    },
    subscribe: (handler) => {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },
    failureCount: () => failures,
  }
}

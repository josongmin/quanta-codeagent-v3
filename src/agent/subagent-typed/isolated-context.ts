/**
 * Parent-context isolation primitives (ADR-0218).
 *
 * The whole point of mode-typed delegation is that the PARENT never sees the
 * CHILD's intermediate state. This module provides the two helpers the
 * delegation router uses to enforce that boundary at the request shape +
 * cancellation level:
 *
 *   1. {@link chainParentSignal} — fans a parent abort signal into a
 *      child-owned AbortController so the child observes ONE signal
 *      regardless of how many parents/timers/etc are in play. The child
 *      never receives the parent's controller itself; only the signal.
 *   2. {@link makeChildCorrelation} — deep-clones the caller's correlation
 *      map into a fresh frozen object so the child registry cannot mutate
 *      the parent's state.
 *
 * Pure: no IO, no clock, no fetch — entirely structural helpers.
 */

/** Fan-in helper: returns a fresh {@link AbortController} that aborts when
 *  EITHER the supplied parent signal aborts OR the caller aborts the
 *  returned controller directly. Idempotent — once aborted, the listener is
 *  removed (no leak). When `parentSignal` is `undefined` the returned
 *  controller is unattached (only the caller can abort).
 *
 *  Why we don't just hand the parent signal to the child: the child may
 *  also have its OWN abort sources (timeout, internal cap-exceeded). By
 *  combining them through a child-owned controller, the child code reads
 *  ONE signal and never has to compose multiple AbortSignals at the
 *  consumption site. */
export const chainParentSignal = (parentSignal?: AbortSignal): AbortController => {
  const child = new AbortController()
  if (parentSignal === undefined) return child
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason)
    return child
  }
  const onParentAbort = (): void => {
    parentSignal.removeEventListener("abort", onParentAbort)
    if (!child.signal.aborted) child.abort(parentSignal.reason)
  }
  parentSignal.addEventListener("abort", onParentAbort, { once: true })
  return child
}

/** Deep-freeze + shallow-clone a correlation map. The child's environment
 *  thus cannot mutate the parent's correlation object — even via a stray
 *  pointer reference through a tool. Absent input ⇒ empty frozen object. */
export const makeChildCorrelation = (
  input?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  if (input === undefined) return Object.freeze({})
  // Filter to plain string values; reject Symbol/proto keys defensively
  // (`Object.entries` already skips non-enumerable, but be explicit).
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== "string") continue
    if (typeof v !== "string") continue
    out[k] = v
  }
  return Object.freeze(out)
}

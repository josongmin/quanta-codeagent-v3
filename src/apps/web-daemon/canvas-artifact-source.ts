/**
 * A2 wire-finish — canvas artifact source (web-daemon side).
 *
 * The Canvas companion to the session `artifact.ready` event. The kernel
 * scheduler already emits an `artifact.ready` SESSION event per drained
 * `ArtifactRef` (the SAME producer drain — `base.artifactRegistry` →
 * `result.artifacts` → `readyEvents`). A server-boot bridge subscribes to the
 * shared session's events and feeds every `artifact.ready` ref into THIS
 * source's `capture(...)`; each WS connection subscribes so its per-connection
 * canvas emitter forwards an `artifact.ready` CANVAS frame via
 * `feedArtifactReady(...)`.
 *
 * NO fork: this does NOT introduce a second artifact producer. It rides the
 * EXISTING session `artifact.ready` event (the registry SSOT's drain) onto the
 * Canvas transport — the same copy-not-recompute pattern the tool-diff source
 * uses for `tool.diff`. There is NO `latest()` snapshot-on-connect: an
 * `artifact.ready` is a point-in-time event (a fresh connection renders
 * artifacts from the next ready forward, exactly like `tool.diff`; a reloaded
 * client hydrates historical artifacts from the persisted session event log).
 *
 * Default-OFF: the composition root only constructs this when
 * `QUANTA_WEB_CANVAS=1`. Absent that, no facade port ⇒ the server attaches no
 * canvas sink AND wires no artifact-event bridge ⇒ no `artifact.ready` Canvas
 * frame (byte-identical; the session `artifact.ready` event is itself gated on
 * `QUANTA_ARTIFACT_STORE`).
 *
 * Slice fence: lives in `@/apps/web-daemon` and references only the protocol
 * `ArtifactRef` shape; it never imports `@/agent/loop` or `@/apps/cli`.
 *
 * DOF-40 — fail-closed: a throwing subscriber is ISOLATED (siblings + the
 * session-event bridge stay live) but the failure is OBSERVABLE via the
 * optional `onSubscriberError` seam. Default-OFF byte-identical.
 */

import type { ArtifactRef } from "@/protocol/session"
import { type CanvasSourceOptions, fanOutIsolated } from "./canvas-fanout"

export interface CanvasArtifactSourceHandle {
  /** Feed a ready artifact ref (the bridge calls this per session
   *  `artifact.ready` event). Fans it out to every subscriber. */
  readonly sink: { capture(ref: ArtifactRef): void }
  /** Subscribe to subsequent artifact-ready refs. Returns an unsubscribe. */
  readonly subscribe: (handler: (ref: ArtifactRef) => void) => () => void
  /** Cumulative count of subscriber deliveries that THREW (health signal). */
  readonly failureCount: () => number
}

/** Create a fresh canvas artifact source. One per daemon (shared across the
 *  daemon's connections, like the tool-diff + usage sources). */
export const createCanvasArtifactSource = (
  opts: CanvasSourceOptions = {},
): CanvasArtifactSourceHandle => {
  const subscribers = new Set<(ref: ArtifactRef) => void>()
  let failures = 0
  return {
    sink: {
      capture: (ref) => {
        failures += fanOutIsolated(subscribers, ref, opts.onSubscriberError)
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

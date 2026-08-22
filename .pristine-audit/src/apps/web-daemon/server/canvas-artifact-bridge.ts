/**
 * `@/apps/web-daemon/server/canvas-artifact-bridge` — the server-boot bridge
 * that pumps every session `artifact.ready` event into the Canvas artifact
 * source.
 *
 * The kernel scheduler emits an `artifact.ready` SESSION event per drained
 * `ArtifactRef` (the registry SSOT's producer drain). This bridge subscribes to
 * the shared session's event stream and, for each `artifact.ready` event, calls
 * `feed.capture(event.artifact)` so the per-connection Canvas emitters forward
 * an `artifact.ready` CANVAS frame ALONGSIDE the session event on the SAME WS.
 *
 * NO fork: this reuses the EXISTING session `artifact.ready` event (the
 * ArtifactRegistry SSOT drain) — it does not introduce a second producer. Same
 * shape as `setupThreadPersistence` (subscribe every event, act on a subset).
 *
 * Default-OFF: `feed === null` (gate `QUANTA_WEB_CANVAS` off ⇒ no canvas
 * artifact source ⇒ index.ts passes no feed) ⇒ this returns a null unsubscribe
 * and never subscribes (byte-identical). The session `artifact.ready` event is
 * itself gated on `QUANTA_ARTIFACT_STORE`, so even with the bridge live an
 * unset store yields zero events ⇒ zero Canvas artifact frames.
 *
 * NO-THROW: a throwing `feed.capture` is swallowed so a bad Canvas fan-out can
 * never break the session-event subscription (persistence + follower-approval
 * ride the SAME stream).
 */

import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage, logger } from "@/shared"

/** The write side of the Canvas artifact source (`canvas-artifact-source.ts`'s
 *  `sink`). Structural mirror so this module never imports the source slice. */
export interface CanvasArtifactFeed {
  capture(ref: import("@/protocol/session").ArtifactRef): void
}

export const setupCanvasArtifactBridge = (
  sharedSession: RuntimeSession,
  feed: CanvasArtifactFeed | null,
): { readonly unsub: (() => void) | null } => {
  if (feed === null) return { unsub: null }
  const unsub = sharedSession.subscribe((event) => {
    if (event.type !== "artifact.ready") return
    try {
      feed.capture(event.artifact)
    } catch (error) {
      // A throwing Canvas fan-out must never break the session-event stream that
      // persistence + follower-approval also ride.
      logger.warn("web-daemon: canvas artifact feed failed", { error: errMessage(error) })
    }
  })
  return { unsub }
}

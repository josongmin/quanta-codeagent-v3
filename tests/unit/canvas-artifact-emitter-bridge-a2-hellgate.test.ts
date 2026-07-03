/**
 * A2 wire-finish Hellgate — the DAEMON Canvas `artifact.ready` producer chain:
 *
 *     session `artifact.ready` event (registry SSOT drain)
 *       └─ setupCanvasArtifactBridge (server-boot subscription)
 *            └─ CanvasArtifactSource.sink.capture(ref)
 *                 └─ per-connection emitter.feedArtifactReady(ref)
 *                      └─ ws.send(encodeCanvasFrame({kind:"artifact.ready", …}))
 *
 * These UNIT hellgates pin the three pure/leaf links in isolation (the full
 * daemon→WS e2e is the sibling integration test). Mutation targets:
 *   - drop `feedArtifactReady` mapping ⇒ no `artifact.ready` frame (RED)
 *   - drop the bridge's `event.type === "artifact.ready"` guard ⇒ a non-artifact
 *     event would be captured (RED — the guard's negative is asserted)
 *   - null feed ⇒ NO subscription (byte-identical default-OFF; RED if it ever
 *     subscribed)
 */

import { describe, expect, test } from "bun:test"
import { createCanvasArtifactSource } from "@/apps/web-daemon/canvas-artifact-source"
import { createCanvasEmitter } from "@/apps/web-daemon/canvas-emitter"
import { setupCanvasArtifactBridge } from "@/apps/web-daemon/server/canvas-artifact-bridge"
import { type CanvasMessage, decodeCanvasFrame } from "@/protocol/canvas"
import type { ArtifactRef } from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"

const REF: ArtifactRef = {
  artifactId: "art-7",
  kind: "image",
  mimeType: "image/png",
  name: "chart.png",
  locator: "quanta-artifact://art-7",
  createdAt: "1970-01-01T00:00:00.000Z",
}

/* ------------------------------------------------------------------ */
/* Emitter — feedArtifactReady maps ArtifactRef → artifact.ready frame */
/* ------------------------------------------------------------------ */

describe("A2 emitter — feedArtifactReady", () => {
  test("maps an ArtifactRef to an artifact.ready Canvas frame (opaque locator, no fs path)", () => {
    const frames: string[] = []
    const emitter = createCanvasEmitter({ ws: { send: (f) => frames.push(f) }, now: () => 42 })

    emitter.feedArtifactReady(REF)

    expect(frames).toHaveLength(1)
    const msg = decodeCanvasFrame(frames[0] ?? "") as CanvasMessage | null
    expect(msg).not.toBeNull()
    if (msg === null || msg.kind !== "artifact.ready") throw new Error("expected artifact.ready")
    expect(msg.artifactId).toBe("art-7")
    expect(msg.artifactKind).toBe("image")
    expect(msg.mimeType).toBe("image/png")
    expect(msg.name).toBe("chart.png")
    // Load-bearing: the OPAQUE locator is carried verbatim — never an fs path.
    expect(msg.locator).toBe("quanta-artifact://art-7")
    expect(msg.locator.startsWith("quanta-artifact://")).toBe(true)
    expect(msg.emittedAt).toBe(42)
  })

  test("omits name when absent (exactOptionalPropertyTypes)", () => {
    const frames: string[] = []
    const emitter = createCanvasEmitter({ ws: { send: (f) => frames.push(f) }, now: () => 1 })
    const { name: _n, ...noName } = REF
    void _n
    emitter.feedArtifactReady(noName)
    const msg = decodeCanvasFrame(frames[0] ?? "")
    if (msg === null || msg.kind !== "artifact.ready") throw new Error("narrow")
    expect("name" in msg).toBe(false)
  })

  test("after stop() feedArtifactReady is a no-op (dead-socket safety)", () => {
    const frames: string[] = []
    const emitter = createCanvasEmitter({ ws: { send: (f) => frames.push(f) } })
    emitter.stop()
    emitter.feedArtifactReady(REF)
    expect(frames).toHaveLength(0)
  })

  test("a throwing ws.send is swallowed (never breaks the turn)", () => {
    const emitter = createCanvasEmitter({
      ws: {
        send: () => {
          throw new Error("dead socket")
        },
      },
    })
    expect(() => emitter.feedArtifactReady(REF)).not.toThrow()
  })
})

/* ------------------------------------------------------------------ */
/* Source — fan-out + unsubscribe                                      */
/* ------------------------------------------------------------------ */

describe("A2 artifact source — fan-out", () => {
  test("capture fans a ref out to every subscriber; unsubscribe stops it", () => {
    const source = createCanvasArtifactSource()
    const seen: ArtifactRef[] = []
    const unsub = source.subscribe((r) => seen.push(r))
    source.sink.capture(REF)
    expect(seen).toEqual([REF])
    unsub()
    source.sink.capture(REF)
    expect(seen).toHaveLength(1) // no more after unsubscribe
  })

  test("a throwing subscriber never breaks the fan-out to siblings", () => {
    const source = createCanvasArtifactSource()
    const seen: string[] = []
    source.subscribe(() => {
      throw new Error("bad subscriber")
    })
    source.subscribe((r) => seen.push(r.artifactId))
    expect(() => source.sink.capture(REF)).not.toThrow()
    expect(seen).toEqual(["art-7"])
  })
})

/* ------------------------------------------------------------------ */
/* Bridge — session artifact.ready → sink.capture (subset guard)       */
/* ------------------------------------------------------------------ */

/** Minimal fake session: only `subscribe` is exercised by the bridge. */
const fakeSession = (): {
  session: RuntimeSession
  emit: (event: unknown) => void
  subscriberCount: () => number
} => {
  const listeners = new Set<(event: never) => void>()
  const session = {
    subscribe: (listener: (event: never) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as RuntimeSession
  return {
    session,
    emit: (event) => {
      for (const l of listeners) (l as (e: unknown) => void)(event)
    },
    subscriberCount: () => listeners.size,
  }
}

describe("A2 canvas artifact bridge", () => {
  test("pumps ONLY artifact.ready events into the feed (the type guard's negative)", () => {
    const { session, emit } = fakeSession()
    const captured: ArtifactRef[] = []
    setupCanvasArtifactBridge(session, { capture: (r) => captured.push(r) })

    // A non-artifact event MUST be ignored (guard negative — mutating the guard
    // out would capture this and fail the length assertion below).
    emit({ type: "turn.completed", outcomeReason: "completed" })
    expect(captured).toHaveLength(0)

    // The artifact.ready event IS forwarded, carrying its `artifact` ref.
    emit({ type: "artifact.ready", artifact: REF })
    expect(captured).toEqual([REF])
  })

  test("null feed (gate OFF) ⇒ NO subscription, null unsub (byte-identical)", () => {
    const { session, subscriberCount } = fakeSession()
    const { unsub } = setupCanvasArtifactBridge(session, null)
    expect(unsub).toBeNull()
    expect(subscriberCount()).toBe(0)
  })

  test("unsub detaches the bridge from the session stream", () => {
    const { session, emit, subscriberCount } = fakeSession()
    const captured: ArtifactRef[] = []
    const { unsub } = setupCanvasArtifactBridge(session, { capture: (r) => captured.push(r) })
    expect(subscriberCount()).toBe(1)
    unsub?.()
    expect(subscriberCount()).toBe(0)
    emit({ type: "artifact.ready", artifact: REF })
    expect(captured).toHaveLength(0)
  })

  test("a throwing feed.capture is swallowed (never breaks the session-event stream)", () => {
    const { session, emit } = fakeSession()
    setupCanvasArtifactBridge(session, {
      capture: () => {
        throw new Error("bad feed")
      },
    })
    expect(() => emit({ type: "artifact.ready", artifact: REF })).not.toThrow()
  })
})

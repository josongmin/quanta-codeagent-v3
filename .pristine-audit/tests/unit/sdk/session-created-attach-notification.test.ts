/**
 * Per-attach `session.created` = IN-PROC NOTIFICATION ONLY; the wire carrier
 * is the connect/resume SNAPSHOT — permanent pins for fix B of
 * docs/tickets/jul-16-session-created-tail-filter-drop.md.
 *
 * Pre-fix, `attachSessionTransport` (sdk/runtime/session/engine.ts) published
 * the synthesized `session.created` to the transport bridge too. Runtime
 * evidence (ticket): that publish could NEVER reach the client it was attached
 * FOR — the event is minted at `seq = state.seq` (current tip; attach is a
 * read), so the bridge tail filter (`seq > snapshot.seq`) drops it from the
 * connect replay and the live fan-out `peer.connected` gate excludes the
 * still-mid-handshake target peer. Its ONLY wire effect was dup-seq NOISE
 * fanned out to the OTHER, already-connected peers. Fix B removes the bridge
 * publish and keeps the in-proc hub publish (real consumers: e.g. web-daemon
 * SQLite thread persistence archives every SessionEvent; HTTP hydration
 * replays it to web clients).
 *
 * Pins (real stack: `createRuntimeSession` → real `attachSessionTransport` →
 * real `createSessionTransportBridge`, in-memory duplex transports, daemon
 * ordering: attach completes BEFORE the client's `connect` frame arrives):
 *   (a) a freshly-attached client's wire = snapshot (with capabilities +
 *       modelSlug) and ZERO `session.created` frames;
 *   (b) an already-connected peer no longer receives `session.created` noise
 *       from ANOTHER client's attach;
 *   (c) in-proc subscribers still receive the per-attach `session.created`
 *       (manifest + model payload, one per attach);
 *   (d) RED-ON-INJECTION control: replaying the exact removed line
 *       (`transportBridge.publishEvents([created])`) DOES deliver to the
 *       already-connected peer — the channel pin (b) watches is live, so
 *       re-adding the bridge publish in `attachSessionTransport` turns (b)
 *       red (non-vacuous absence assertion).
 */
import { describe, expect, test } from "bun:test"
import type { SessionTransport, SessionTransportMessage } from "@/ipc/session"
import type { KernelClock, KernelEventLogPort, SessionHost } from "@/kernel/session"
import { createKernelSessionState } from "@/kernel/session"
import type { SessionEvent } from "@/protocol/session"
import { createRuntimeSession } from "@/sdk/runtime/session"
import {
  attachSessionTransport as engineAttachSessionTransport,
  type SessionEngineDeps,
  type SessionRuntimeState,
} from "@/sdk/runtime/session/engine"
import { SessionSubscriptionHub } from "@/sdk/runtime/subscription"
import { capabilitiesFor } from "../../support/session-fixtures"

/* ------------------------------------------------------------------------- */
/* Harness (mirrors the ticket's runtime-repro + the W1-B e2e transport pair) */
/* ------------------------------------------------------------------------- */

/** In-memory duplex SessionTransport pair. `send` AWAITS the remote handlers,
 *  so awaiting a `connect` frame observes the bridge's full replay reply —
 *  deterministic sequencing, no sleeps. */
const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const build = (
    local: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(m: SessionTransportMessage) => void | Promise<void>>,
  ): SessionTransport => ({
    async send(message) {
      for (const handler of [...remote]) await handler(message)
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      local.clear()
    },
  })
  return {
    client: build(clientHandlers, serverHandlers),
    server: build(serverHandlers, clientHandlers),
  }
}

const tapFrames = (transport: SessionTransport): SessionTransportMessage[] => {
  const frames: SessionTransportMessage[] = []
  transport.onMessage((message) => {
    frames.push(message)
  })
  return frames
}

const wireEventsOfType = (
  frames: readonly SessionTransportMessage[],
  type: SessionEvent["type"],
): SessionEvent[] =>
  frames.flatMap((m) => (m.kind === "event" && m.event.type === type ? [m.event] : []))

const PIN_MODEL = "pin-model-slug"
const PIN_SESSION_ID = "session-created-pin"

/** Minimal real SessionHost — `describe()` is the only method the attach +
 *  `input.append` paths touch; `runTurn` throwing proves no turn sneaks in. */
const makeHost = (): SessionHost => ({
  describe: () => ({
    sessionId: PIN_SESSION_ID,
    permissionMode: "default",
    capabilityManifest: capabilitiesFor({
      approvals: "operator",
      transport: "websocket",
      serverAutoContinues: true,
    }),
    modelSlug: PIN_MODEL,
  }),
  runTurn: async () => {
    throw new Error("runTurn must not be reached by these pins")
  },
  close: async () => undefined,
})

const kernelDeps = (): { clock: KernelClock; eventLog: KernelEventLogPort } => ({
  clock: { now: () => new Date("2026-07-16T00:00:00.000Z") },
  eventLog: { append: () => undefined, list: () => [] },
})

const makeSession = () => createRuntimeSession({ hostSession: makeHost(), kernel: kernelDeps() })

describe("per-attach session.created: in-proc only, snapshot is the wire carrier (ticket jul-16 fix B)", () => {
  test("PIN (a): a freshly-attached client's wire = snapshot with capabilities+model, ZERO session.created", async () => {
    const session = makeSession()
    const pair = createTransportPair()
    const frames = tapFrames(pair.client)

    // Daemon ordering: attach completes first, the client's connect frame
    // arrives after (buildRegisteredSession attaches on socket open).
    const connected = await session.attachSessionTransport(pair.server)
    // Pre-handshake the target peer received NOTHING (not even the synth event).
    expect(frames).toEqual([])
    await pair.client.send({ kind: "connect", sessionId: session.sessionId })

    // Exactly one snapshot frame; it IS the carrier of capabilities + model.
    const snapshots = frames.filter(
      (m): m is SessionTransportMessage & { kind: "snapshot" } => m.kind === "snapshot",
    )
    expect(snapshots.length).toBe(1)
    expect(snapshots[0]?.snapshot.capabilities.serverAutoContinues).toBe(true)
    expect(snapshots[0]?.snapshot.capabilities.transport).toBe("websocket")
    expect(snapshots[0]?.snapshot.state.modelSlug).toBe(PIN_MODEL)

    // And the wire carries NO session.created — delivery is NOT guaranteed nor
    // attempted; snapshot is authoritative (fix B).
    expect(wireEventsOfType(frames, "session.created")).toEqual([])

    await connected.close()
    await session.close()
  })

  test("PIN (b): an already-connected peer gets NO session.created noise from another client's attach", async () => {
    const session = makeSession()

    // Peer A: attach + complete handshake (connected).
    const pairA = createTransportPair()
    const framesA = tapFrames(pairA.client)
    const connectedA = await session.attachSessionTransport(pairA.server)
    await pairA.client.send({ kind: "connect", sessionId: session.sessionId })

    // Raise the tip to seq=1 (ticket scenario 2): A sees the live state echo.
    await session.input.append("hello")
    expect(wireEventsOfType(framesA, "session.state.updated").length).toBeGreaterThan(0)
    const framesABeforeAttachB = framesA.length

    // Peer B attaches (mid-handshake — exactly when the pre-fix noise fired).
    const pairB = createTransportPair()
    const framesB = tapFrames(pairB.client)
    const connectedB = await session.attachSessionTransport(pairB.server)

    // THE pin: A received NOTHING from B's attach — pre-fix it received the
    // dup-seq `session.created(seq=1)` here (same seq as the state echo it
    // already holds). Re-adding the bridge publish turns this red — see the
    // PIN (d) injection control proving this exact channel delivers.
    expect(framesA.length).toBe(framesABeforeAttachB)
    expect(wireEventsOfType(framesA, "session.created")).toEqual([])

    // B (the attach TARGET) completes its handshake: snapshot-only, tip seq.
    expect(framesB).toEqual([])
    await pairB.client.send({ kind: "connect", sessionId: session.sessionId })
    const snapshotsB = framesB.filter(
      (m): m is SessionTransportMessage & { kind: "snapshot" } => m.kind === "snapshot",
    )
    expect(snapshotsB.length).toBe(1)
    expect(snapshotsB[0]?.snapshot.seq).toBe(1)
    expect(snapshotsB[0]?.snapshot.state.draftInput).toBe("hello")
    expect(wireEventsOfType(framesB, "session.created")).toEqual([])

    await connectedB.close()
    await connectedA.close()
    await session.close()
  })

  test("PIN (c): in-proc subscribers STILL receive one session.created per attach (manifest + model)", async () => {
    const session = makeSession()
    const created: Array<Extract<SessionEvent, { type: "session.created" }>> = []
    const unsub = session.subscribe((event) => {
      if (event.type === "session.created") created.push(event)
    })

    // Attach A (in-proc notification fires regardless of any handshake).
    const pairA = createTransportPair()
    const connectedA = await session.attachSessionTransport(pairA.server)
    expect(created.length).toBe(1)
    expect(created[0]?.seq).toBe(0)

    // Raise the tip, then attach B — per-attach semantics: a SECOND event.
    await pairA.client.send({ kind: "connect", sessionId: session.sessionId })
    await session.input.append("hello")
    const pairB = createTransportPair()
    const connectedB = await session.attachSessionTransport(pairB.server)
    expect(created.length).toBe(2)
    expect(created[1]?.seq).toBe(1)
    expect(created[0]?.eventId).not.toBe(created[1]?.eventId)

    // Payload contract: the manifest + model ride the in-proc notification
    // (the same data the wire snapshot carries — consumers like the SQLite
    // thread archive persist THIS event).
    for (const event of created) {
      expect(event.capabilityManifest.serverAutoContinues).toBe(true)
      expect(event.model).toBe(PIN_MODEL)
    }

    unsub()
    await connectedB.close()
    await connectedA.close()
    await session.close()
  })

  test("PIN (d) RED-ON-INJECTION control: replaying the removed bridge publish DOES deliver the noise pin (b) forbids", async () => {
    // Same real engine stack, constructed with explicit deps so the test can
    // reach the transport bridge — `createRuntimeSession`'s exact wiring.
    const hostSession = makeHost()
    const box: SessionRuntimeState = {
      closed: false,
      state: createKernelSessionState(hostSession.describe()),
      transportBridge: undefined,
      transportDispatchQueue: Promise.resolve(),
      activeDispatch: Promise.resolve(),
    }
    const deps: SessionEngineDeps = {
      box,
      sessionId: box.state.sessionId,
      subscriptions: new SessionSubscriptionHub(),
      hostSession,
      kernel: kernelDeps(),
    }

    // Peer A: real attach + handshake (connected). Peer B: real attach.
    const pairA = createTransportPair()
    const framesA = tapFrames(pairA.client)
    const connectedA = await engineAttachSessionTransport(deps, pairA.server)
    await pairA.client.send({ kind: "connect", sessionId: deps.sessionId })
    const pairB = createTransportPair()
    const connectedB = await engineAttachSessionTransport(deps, pairB.server)

    // Paired control, arm 1 — post-fix attach: NO noise reached A.
    expect(wireEventsOfType(framesA, "session.created")).toEqual([])

    // Arm 2 — INJECT the exact removed line (the pre-fix tail of
    // `attachSessionTransport`): publish a synthesized session.created to the
    // transport bridge.
    const injected: SessionEvent = {
      type: "session.created",
      eventId: crypto.randomUUID(),
      seq: box.state.seq,
      revision: box.state.revision,
      emittedAt: deps.kernel.clock.now().toISOString(),
      capabilityManifest: box.state.capabilityManifest,
      ...(box.state.modelSlug !== undefined ? { model: box.state.modelSlug } : {}),
    }
    await box.transportBridge?.publishEvents([injected])

    // The already-connected peer DID receive it — the fan-out channel pin (b)
    // watches is live, so re-adding the publish in attachSessionTransport
    // reproduces exactly the delivery pin (b) asserts never happens.
    const noise = wireEventsOfType(framesA, "session.created")
    expect(noise.length).toBe(1)
    expect(noise[0]?.seq).toBe(box.state.seq)

    await connectedB.close()
    await connectedA.close()
  })
})

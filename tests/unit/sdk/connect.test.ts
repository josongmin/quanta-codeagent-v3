/**
 * S2c unit coverage — `connect()` over a scripted transport spec
 * (jul-16 SDK ticket 01). The real-daemon round-trips live in
 * `tests/integration/sdk-connect-session-handle-e2e.test.ts`; THIS file pins
 * the connect()-owned composition contracts a scripted wire can isolate:
 *
 *   - ATOMIC cursor handover (R2 F9) at the CONNECT level: tail events that
 *     stream during the handshake window are reflected in the handle's
 *     `lastSeq()` the moment connect() resolves — AND delivered (M-2): they
 *     re-play to pre-live subscribers instead of being silently swallowed;
 *   - handshake-stage transport death ⇒ connect() REJECTS TYPED
 *     (`SessionHandleClosedError`, no forever-pending promise) and the
 *     transport is torn down;
 *   - S5b version-skew connect reject ⇒ typed `SessionProtocolVersionError`;
 *   - `onConnectionState` receives the current `connected` state on resolve;
 *   - resume is UNSUPPORTED at this door (jul-16 audit KILL — descope pin):
 *     no `ConnectOptions.resumeFromSeq`, bare handshake connect frames;
 *   - the approval seams: M-1 (respond send failure settles the chain typed),
 *     M-3 (an already-parked snapshot approval is seeded to `onApproval`),
 *     M-2 (a single-chunk stdio snapshot+event dispatch loses neither the
 *     window approval nor the tail event).
 */

import { describe, expect, test } from "bun:test"
import type {
  SessionTransport,
  SessionTransportCloseInfo,
  SessionTransportMessage,
  StdioReader,
} from "@/ipc/session"
import {
  createSessionStdioTransport,
  decodeSessionTransportMessage,
  encodeSessionTransportMessage,
  SessionHandleClosedError,
  SessionTurnCorrelationLostError,
} from "@/ipc/session"
import type { SessionEvent } from "@/protocol/session"
import { SessionProtocolVersionError } from "@/protocol/session"
import { type ConnectOptions, connect, type SessionTransportSpec, transports } from "@/sdk"
import { makeSnapshot, makeStateUpdatedEvent } from "../ipc/session-transport-conformance-fixtures"

/** Scripted transport + spec: reacts to outbound frames, can die on command. */
const makeScriptedSpec = (
  react: (message: SessionTransportMessage, deliver: (m: SessionTransportMessage) => void) => void,
) => {
  const handlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const closeHandlers = new Set<(info: SessionTransportCloseInfo) => void>()
  const sent: SessionTransportMessage[] = []
  let closed = false
  // Honors the SessionTransport.onClose CONTRACT (types.ts): once-latch +
  // a handler subscribed AFTER death is invoked immediately — connect()'s
  // death guard may subscribe after the die() raced ahead of create().
  let terminal: SessionTransportCloseInfo | undefined
  const deliver = (message: SessionTransportMessage): void => {
    for (const handler of [...handlers]) void handler(message)
  }
  const transport: SessionTransport = {
    async send(message) {
      sent.push(message)
      react(message, deliver)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    onClose(handler) {
      if (terminal !== undefined) {
        handler(terminal)
        return () => undefined
      }
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
    async close() {
      closed = true
    },
  }
  const die = (reason: string): void => {
    if (terminal !== undefined) return
    terminal = { reason }
    for (const handler of [...closeHandlers]) handler({ reason })
    closeHandlers.clear()
  }
  const spec: SessionTransportSpec = {
    kind: "ws",
    async create() {
      return transport
    },
  }
  return { spec, sent, deliver, die, isClosed: () => closed }
}

/** The standard discovery→adopt→snapshot handshake script. */
const handshakeScript =
  (opts?: { tailSeqs?: readonly number[] }) =>
  (message: SessionTransportMessage, send: (m: SessionTransportMessage) => void): void => {
    if (message.kind !== "connect") return
    if (message.sessionId === "ui-session") {
      send({
        kind: "rejected",
        sessionId: "session-1",
        target: "connect",
        reason: "session_id_mismatch",
      })
      return
    }
    send({ kind: "snapshot", snapshot: makeSnapshot("websocket", { seq: 10 }) })
    for (const seq of opts?.tailSeqs ?? []) {
      send({ kind: "event", event: makeStateUpdatedEvent({ eventId: `tail-${seq}`, seq }) })
    }
  }

describe("connect() — composition contracts", () => {
  test("resolves a handle with the canonical id, the snapshot cache, and a NON-LAGGING lastSeq (R2 F9: handshake-window tail included) — and the tail is DELIVERED, not swallowed (M-2)", async () => {
    const wire = makeScriptedSpec(handshakeScript({ tailSeqs: [11, 12] }))
    const handle = await connect({ transport: wire.spec })
    expect(handle.sessionId).toBe("session-1")
    const snap = await handle.snapshot()
    expect(snap?.snapshot.seq).toBe(10)
    // THE atomic-handover assertion: events observed DURING the handshake are
    // already in the cursor — a snapshot.seq-seeded handle would report 10 and
    // a manual reconnect would re-replay 11..12.
    expect(handle.lastSeq()).toBe(12)
    // M-2 (jul-16 audit) — the tail is not merely counted, it is DELIVERED:
    // a pre-live subscriber receives the handshake-window events the handshake
    // listener consumed before the handle existed. (The old pin here treated
    // the swallowing as intended by asserting the cursor alone.)
    const replayed: number[] = []
    handle.subscribe((event) => {
      replayed.push(event.seq)
    })
    expect(replayed).toEqual([11, 12])
    // And live frames continue AFTER the replay, in order, without re-replay.
    wire.deliver({ kind: "event", event: makeStateUpdatedEvent({ eventId: "live-13", seq: 13 }) })
    expect(replayed).toEqual([11, 12, 13])
    const late: number[] = []
    handle.subscribe((event) => {
      late.push(event.seq)
    })
    expect(late).toEqual([]) // post-live subscriber: normal stream semantics
    await handle.close()
  })

  test("transport death DURING the handshake rejects connect() typed and closes the transport (no forever-pending connect)", async () => {
    // A script that never answers — the handshake would park forever without
    // the death guard.
    const wire = makeScriptedSpec(() => undefined)
    const pending = connect({ transport: wire.spec })
    wire.die("socket_error (connection refused)")
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionHandleClosedError)
    expect((err as SessionHandleClosedError).reason).toBe("socket_error (connection refused)")
    expect(wire.isClosed()).toBe(true)
  })

  test("an S5b version-skew connect reject fails connect() with SessionProtocolVersionError", async () => {
    const wire = makeScriptedSpec((message, send) => {
      if (message.kind !== "connect") return
      send({
        kind: "rejected",
        sessionId: "session-1",
        target: "connect",
        reason: "protocol_validation",
        issue: "bad_version",
      })
    })
    const err = await connect({ transport: wire.spec }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionProtocolVersionError)
    expect(wire.isClosed()).toBe(true)
  })

  test("onConnectionState observes the live `connected` state at resolve time", async () => {
    const wire = makeScriptedSpec(handshakeScript())
    const states: string[] = []
    const handle = await connect({
      transport: wire.spec,
      onConnectionState: (state) => {
        states.push(state.status)
      },
    })
    expect(states).toEqual(["connected"])
    await handle.close()
  })

  test("UNSUPPORTED pin (jul-16 audit KILL): resume is NOT part of this door — no ConnectOptions.resumeFromSeq, bare handshake connect frames", async () => {
    // WHY (both attackers repro'd the hang): the handshake's `ready` settles
    // only on a SNAPSHOT frame, but the bridge answers a servable cursor with
    // events-only — ZERO frames at cursor==tip (`planSessionReplay`), the
    // reconnect-right-after-a-drop base case — and session.v1 has no ack frame
    // to signal "caught up". connect({resumeFromSeq}) was therefore a
    // structural forever-pending promise. Door-level resume is ticket 05's
    // (raw client's resume watcher); see USAGE-sdk-door.md §10.
    const wire = makeScriptedSpec(handshakeScript())
    // Type-level pin (CI tests-typecheck): the option is GONE.
    // @ts-expect-error — resumeFromSeq was removed from ConnectOptions (descope; excess-property TS2353)
    const rejectedShape: ConnectOptions = { transport: wire.spec, resumeFromSeq: 7 }
    void rejectedShape
    const handle = await connect({ transport: wire.spec })
    const connects = wire.sent.filter(
      (m): m is Extract<SessionTransportMessage, { kind: "connect" }> => m.kind === "connect",
    )
    // Runtime pin: BOTH connect frames (discovery + adoption) are BARE.
    expect(connects.length).toBe(2)
    for (const frame of connects) {
      expect("resumeFromSeq" in frame).toBe(false)
    }
    await handle.close()
  })

  test("M-1 (jul-16 audit): a FAILED approval.respond send settles the approval's chain typed — awaitTurnEnd rejects instead of hanging", async () => {
    // Scripted wire: handshake normally; a turn.run is answered with an
    // approval.requested; every approval.respond send THROWS (dead pipe that
    // only manifests on write).
    const handlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
    const deliver = (message: SessionTransportMessage): void => {
      for (const handler of [...handlers]) void handler(message)
    }
    const transport: SessionTransport = {
      async send(message) {
        if (message.kind === "command" && message.command.type === "approval.respond") {
          throw new Error("pipe burst on respond")
        }
        if (message.kind === "connect") {
          if (message.sessionId === "ui-session") {
            deliver({
              kind: "rejected",
              sessionId: "session-1",
              target: "connect",
              reason: "session_id_mismatch",
            })
          } else {
            deliver({ kind: "snapshot", snapshot: makeSnapshot("websocket", { seq: 10 }) })
          }
          return
        }
        if (message.kind === "command" && message.command.type === "turn.run") {
          deliver({
            kind: "event",
            event: {
              eventId: "e-ap",
              seq: 11,
              revision: 5,
              emittedAt: "t",
              causedByCommandId: message.command.commandId,
              type: "approval.requested",
              approval: { approvalId: "ap-1", reason: "danger", requestedAt: "t" },
            },
          })
        }
      },
      onMessage(handler) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      async close() {
        handlers.clear()
      },
    }
    const spec: SessionTransportSpec = {
      kind: "ws",
      async create() {
        return transport
      },
    }
    const approvalsSeen: string[] = []
    const handle = await connect({
      transport: spec,
      onApproval: async (approval) => {
        approvalsSeen.push(approval.approvalId)
        return "approve"
      },
    })
    await handle.turn.run({ commandId: "run-1" })
    const err = await handle.awaitTurnEnd().catch((e: unknown) => e)
    expect(approvalsSeen).toEqual(["ap-1"])
    expect(err).toBeInstanceOf(SessionTurnCorrelationLostError)
    expect((err as SessionTurnCorrelationLostError).reason).toBe("continuation_failed")
    expect(String((err as Error).message)).toContain("never reached the server")
    await handle.close()
  })

  test("M-3 (jul-16 audit): an ALREADY-PARKED approval (snapshot.pendingApproval) is seeded to onApproval exactly once — the respond rides the wire", async () => {
    const parked = { approvalId: "ap-parked", reason: "danger", requestedAt: "t" }
    const wire = makeScriptedSpec((message, send) => {
      if (message.kind !== "connect") return
      if (message.sessionId === "ui-session") {
        send({
          kind: "rejected",
          sessionId: "session-1",
          target: "connect",
          reason: "session_id_mismatch",
        })
        return
      }
      send({
        kind: "snapshot",
        snapshot: makeSnapshot("websocket", {
          seq: 10,
          state: {
            status: "awaiting_approval",
            draftInput: "do it",
            permissionMode: "default",
            messageCount: 1,
          },
          pendingApproval: parked,
        }),
      })
    })
    const approvalsSeen: string[] = []
    const handle = await connect({
      transport: wire.spec,
      onApproval: async (approval) => {
        approvalsSeen.push(approval.approvalId)
        return "approve"
      },
    })
    // The flow runs async — settle it deterministically by flushing until the
    // respond frame appears (bounded).
    for (let i = 0; i < 20 && !wire.sent.some((m) => m.kind === "command"); i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    const responds = wire.sent.filter(
      (m): m is Extract<SessionTransportMessage, { kind: "command" }> =>
        m.kind === "command" && m.command.type === "approval.respond",
    )
    expect(approvalsSeen).toEqual(["ap-parked"])
    expect(responds.length).toBe(1)
    if (responds[0]?.command.type !== "approval.respond") throw new Error("narrow")
    expect(responds[0].command.approvalId).toBe("ap-parked")
    // Dedup guard: a late duplicate approval.requested for the SAME id (e.g.
    // an overlap between seed and replay) must NOT re-prompt.
    wire.deliver({
      kind: "event",
      event: {
        eventId: "e-dup",
        seq: 11,
        revision: 5,
        emittedAt: "t",
        type: "approval.requested",
        approval: parked,
      },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(approvalsSeen).toEqual(["ap-parked"])
    await handle.close()
  })

  test("M-2 stdio repro (jul-16 audit): snapshot + tail events in ONE synchronously-dispatched chunk — the window approval reaches onApproval and the tail reaches a pre-live subscriber", async () => {
    // REAL stdio framing: newline-delimited frames through
    // createSessionStdioTransport — a single reader chunk carrying
    // [snapshot, approval.requested, state.updated] dispatches all three
    // synchronously inside the handshake window (the confirmed loss path;
    // a ws door delivers them as separate macrotasks instead).
    let readerHandler: ((chunk: Buffer | string) => void) | undefined
    const reader: StdioReader = {
      on(event, handler) {
        if (event === "data") readerHandler = handler
      },
      off(event, handler) {
        if (event === "data" && readerHandler === handler) readerHandler = undefined
      },
    }
    const serverReceived: SessionTransportMessage[] = []
    const windowApproval = { approvalId: "ap-window", reason: "danger", requestedAt: "t" }
    const reactToConnect = (message: Extract<SessionTransportMessage, { kind: "connect" }>) => {
      if (message.sessionId === "ui-session") {
        readerHandler?.(
          `${encodeSessionTransportMessage({
            kind: "rejected",
            sessionId: "session-1",
            target: "connect",
            reason: "session_id_mismatch",
          })}\n`,
        )
        return
      }
      // THE repro shape: one chunk, three frames, dispatched in one
      // synchronous read callback.
      const frames: SessionTransportMessage[] = [
        { kind: "snapshot", snapshot: makeSnapshot("stdio", { seq: 10 }) },
        {
          kind: "event",
          event: {
            eventId: "e-window-approval",
            seq: 11,
            revision: 5,
            emittedAt: "t",
            type: "approval.requested",
            approval: windowApproval,
          } as SessionEvent,
        },
        {
          kind: "event",
          event: makeStateUpdatedEvent({ eventId: "e-window-state", seq: 12 }),
        },
      ]
      readerHandler?.(`${frames.map(encodeSessionTransportMessage).join("\n")}\n`)
    }
    const writer = {
      write(chunk: string) {
        // The client writes one frame per line.
        for (const line of chunk.split("\n")) {
          if (line.trim().length === 0) continue
          const message = decodeSessionTransportMessage(line)
          serverReceived.push(message)
          if (message.kind === "connect") reactToConnect(message)
        }
        return true
      },
    }
    const transport = createSessionStdioTransport({ reader, writer })

    const approvalsSeen: string[] = []
    const handle = await connect({
      transport: transports.stdio({ transport }),
      onApproval: async (approval) => {
        approvalsSeen.push(approval.approvalId)
        return "deny" // deny ⇒ respond only, no continuation — one frame to await
      },
    })
    // The window events were consumed before the handle existed — but they are
    // NOT lost: lastSeq folded them in AND a pre-live subscriber replays them.
    expect(handle.lastSeq()).toBe(12)
    const replayedTypes: string[] = []
    handle.subscribe((event) => {
      replayedTypes.push(event.type)
    })
    expect(replayedTypes).toEqual(["approval.requested", "session.state.updated"])
    // The window approval reached the flow: the respond rides the wire.
    for (
      let i = 0;
      i < 20 &&
      !serverReceived.some((m) => m.kind === "command" && m.command.type === "approval.respond");
      i++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    const responds = serverReceived.filter(
      (m): m is Extract<SessionTransportMessage, { kind: "command" }> =>
        m.kind === "command" && m.command.type === "approval.respond",
    )
    expect(responds.length).toBe(1)
    if (responds[0]?.command.type !== "approval.respond") throw new Error("narrow")
    expect(responds[0].command.approvalId).toBe("ap-window")
    expect(approvalsSeen).toEqual(["ap-window"])
    await handle.close()
  })
})

import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  type SessionTransport,
  type SessionTransportHandler,
  type SessionTransportMessage,
} from "@/ipc/session"
import { makeCommand, makeSnapshot } from "../ipc/session-transport-conformance-fixtures"

/**
 * T06 — SDK bridge error surfacing hellgate (L5 H-3).
 *
 * Root cause: `createRuntimeSession` constructed the transport bridge WITHOUT
 * `onBridgeError` / `onCommandRejected`, so a failed transport send or a
 * rejected command vanished with no diagnostic. These tests pin the bridge
 * contract those callbacks ride on: a peer `send()` failure routes to
 * `onBridgeError`, and a malformed command routes to `onCommandRejected`.
 * Both callbacks are now supplied by `session.ts` (logger.error / logger.warn),
 * so the failures are no longer silent.
 */

interface FakePeer extends SessionTransport {
  emit(message: SessionTransportMessage): Promise<void>
}

const makePeer = (opts: { failSend?: boolean } = {}): FakePeer => {
  let handler: SessionTransportHandler | undefined
  return {
    send: async () => {
      if (opts.failSend === true) throw new Error("peer send exploded")
    },
    onMessage: (h) => {
      handler = h
      return () => {
        handler = undefined
      }
    },
    close: async () => undefined,
    emit: async (message) => {
      if (handler !== undefined) await handler(message)
    },
  }
}

describe("T06 / SDK bridge error surfacing", () => {
  test("BRIDGE-ERR-1: a peer send() failure routes to onBridgeError (not swallowed)", async () => {
    const seen: unknown[] = []
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onBridgeError: ({ error }) => seen.push(error),
    })
    const peer = makePeer({ failSend: true })
    await bridge.connect(peer)
    // Replay on connect tries to send the snapshot → send throws → must surface.
    await peer.emit({ kind: "connect", sessionId: "session-1" })
    expect(seen.length).toBeGreaterThan(0)
    await bridge.close()
  })

  test("BRIDGE-REJECT-1: a session-id-mismatch command routes to onCommandRejected", async () => {
    const rejected: Array<{ type: string }> = []
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onCommandRejected: ({ command }) => rejected.push({ type: command.type }),
    })
    const peer = makePeer()
    await bridge.connect(peer)
    await peer.emit({ kind: "connect", sessionId: "session-1" })
    // Wrong sessionId ⇒ protocol validation rejection.
    await peer.emit({
      kind: "command",
      command: makeCommand({ sessionId: "WRONG-session" }),
    })
    expect(rejected).toEqual([{ type: "turn.run" }])
    await bridge.close()
  })

  test("BRIDGE-REJECT-2: a duplicate commandId routes to onCommandRejected", async () => {
    const rejected: string[] = []
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onCommandRejected: ({ command }) => rejected.push(command.commandId),
    })
    const peer = makePeer()
    await bridge.connect(peer)
    await peer.emit({ kind: "connect", sessionId: "session-1" })
    const cmd = makeCommand({ commandId: "dup-1" })
    await peer.emit({ kind: "command", command: cmd })
    await peer.emit({ kind: "command", command: cmd })
    expect(rejected).toContain("dup-1")
    await bridge.close()
  })
})

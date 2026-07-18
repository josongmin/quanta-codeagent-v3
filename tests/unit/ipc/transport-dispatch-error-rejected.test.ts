/**
 * S5a hellgate — bridge dispatch-error → `rejected` promotion (jul-16 SDK ticket 01).
 *
 * PRE-EXISTING SILENT BUG (MASTER-PLAN §0): the transport bridge's command
 * handler caught a dispatch-stage error (kernel reducer throw, e.g.
 * `empty_turn_input`) and only reported it to the SERVER-side `onBridgeError`
 * hook — the issuing wire peer received NO frame at all and hung with zero
 * diagnostic. These tests were written RED-first against that behavior:
 *
 *   RED (pre-fix):  the wire client observes NOTHING after the command frame.
 *   GREEN (post-fix): the wire client receives a `rejected` frame encoded as
 *     reason `protocol_validation` + `issue` = the kernel error's issue string
 *     (S0-3 ruling — reusing the closed-4 reason set is the ONLY encoding an
 *     already-shipped client can decode; a new reason value would be silently
 *     dropped by the old closed-4 check).
 *
 * red-on-injection: delete the promotion block in `bridge.ts` (`await
 * rejectDispatchFailure(...)`) and the REJECTED-frame assertions below go red
 * (the real-loop case reproduces the silent hang exactly).
 */
import { describe, expect, test } from "bun:test"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import {
  createSessionTransportBridge,
  SessionDispatchFailedError,
  type SessionTransport,
  type SessionTransportMessage,
} from "@/ipc/session"
import { SessionProtocolValidationError } from "@/protocol/session"
import { createRuntime } from "@/sdk/runtime"
import { capabilitiesFor } from "../../support/session-fixtures"
import { makeCommand, makeSnapshot } from "./session-transport-conformance-fixtures"

/** In-memory duplex transport pair (same shape as session-transport.test.ts):
 *  `send` awaits the remote handlers, so the full server-side handling chain —
 *  including any reply frames — has settled when `send` resolves. No timers. */
const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(message: SessionTransportMessage) => void | Promise<void>>()
  let clientClosed = false
  let serverClosed = false

  const build = (
    local: Set<(message: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(message: SessionTransportMessage) => void | Promise<void>>,
    isLocalClosed: () => boolean,
    closeLocal: () => void,
  ): SessionTransport => ({
    async send(message) {
      if (isLocalClosed()) return
      for (const handler of [...remote]) {
        await handler(message)
      }
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      closeLocal()
      local.clear()
    },
  })

  return {
    client: build(
      clientHandlers,
      serverHandlers,
      () => clientClosed,
      () => {
        clientClosed = true
      },
    ),
    server: build(
      serverHandlers,
      clientHandlers,
      () => serverClosed,
      () => {
        serverClosed = true
      },
    ),
  }
}

const rejectedFrames = (messages: readonly SessionTransportMessage[]) =>
  messages.filter(
    (m): m is Extract<SessionTransportMessage, { kind: "rejected" }> => m.kind === "rejected",
  )

describe("S5a / bridge dispatch-error → rejected promotion", () => {
  test("REAL LOOP: a wire turn.run hitting the kernel's empty_turn_input reaches the peer as a rejected frame (was: total silence)", async () => {
    // Real RuntimeSession over the real kernel reducer — NOT a stubbed
    // onCommand. `turn.run` without any prior `input.append` makes the reducer
    // throw SessionProtocolValidationError("empty_turn_input") at dispatch
    // stage, which the bridge used to swallow server-side.
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => ({
        describe: () => ({
          sessionId: "dispatch-reject-session",
          permissionMode: "default",
          capabilityManifest: capabilitiesFor(),
        }),
        runTurn: async () => {
          throw new Error("host.runTurn must NOT be reached — the reducer rejects first")
        },
        close: async () => undefined,
      })),
    })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })

    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((message) => {
      inbound.push(message)
    })
    const connected = await session.attachSessionTransport(pair.server)

    await pair.client.send({ kind: "connect", sessionId: session.sessionId })
    inbound.length = 0 // drop the handshake replay — we probe ONLY the command's aftermath

    await pair.client.send({
      kind: "command",
      command: {
        sessionId: session.sessionId,
        commandId: "cmd-empty-turn",
        issuedAt: "2026-07-16T00:00:00.000Z",
        type: "turn.run",
      },
    })

    // GREEN target (S5a): the dispatch error is PROMOTED to a rejected frame the
    // peer can decode today (closed-4 reason + issue carries the kernel string).
    const rejects = rejectedFrames(inbound)
    expect(rejects).toHaveLength(1)
    expect(rejects[0]).toEqual({
      kind: "rejected",
      sessionId: session.sessionId,
      target: "command",
      reason: "protocol_validation",
      commandId: "cmd-empty-turn",
      issue: "empty_turn_input",
    })

    await connected.close()
    await session.close()
    await runtime.close()
  })

  test("kernel validation issue string rides `issue` verbatim (empty_turn_input)", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onCommand: async () => {
        throw new SessionProtocolValidationError("empty_turn_input")
      },
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1" })
    inbound.length = 0

    await pair.client.send({ kind: "command", command: makeCommand({ commandId: "c-1" }) })

    expect(inbound).toEqual([
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "protocol_validation",
        commandId: "c-1",
        issue: "empty_turn_input",
      },
    ])
    await bridge.close()
  })

  test("a non-protocol dispatch error is promoted with the stable `dispatch_failed` issue", async () => {
    const rejectedSeen: unknown[] = []
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onCommand: async () => {
        throw new Error("host exploded mid-dispatch")
      },
      onCommandRejected: ({ error }) => rejectedSeen.push(error),
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1" })
    inbound.length = 0

    await pair.client.send({ kind: "command", command: makeCommand({ commandId: "c-2" }) })

    expect(inbound).toEqual([
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "protocol_validation",
        commandId: "c-2",
        issue: "dispatch_failed",
      },
    ])
    // The in-proc observer channel fires too — typed as the wire-level wrapper,
    // carrying the original throw as `cause`.
    expect(rejectedSeen).toHaveLength(1)
    expect(rejectedSeen[0]).toBeInstanceOf(SessionDispatchFailedError)
    expect(((rejectedSeen[0] as SessionDispatchFailedError).cause as Error).message).toBe(
      "host exploded mid-dispatch",
    )
    await bridge.close()
  })

  test("dispatch-failure rejection is FRAME-ONLY — no replay tacked on (client state is not stale)", async () => {
    // Contrast with revision_conflict (whose reject IS followed by a resync
    // snapshot): a dispatch failure means the command was VALID for the current
    // revision but failed to apply — the peer's view is not stale, so no
    // snapshot/tail replay may ride along.
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onCommand: async () => {
        throw new SessionProtocolValidationError("empty_turn_input")
      },
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1" })
    inbound.length = 0

    await pair.client.send({ kind: "command", command: makeCommand({ commandId: "c-3" }) })

    expect(inbound.map((m) => m.kind)).toEqual(["rejected"])
    await bridge.close()
  })

  test("a failed command stays retryable: the SAME commandId re-runs after a dispatch failure", async () => {
    // Pins the pre-existing dedup-prune semantics THROUGH the new rejection
    // path: the failure prunes the commandId from the dedup window, so an
    // identical retry re-dispatches (it must NOT be duplicate-rejected), and a
    // SUCCESSFUL retry produces no rejected frame at all.
    let failOnce = true
    const dispatched: string[] = []
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onCommand: async (command) => {
        dispatched.push(command.commandId)
        if (failOnce) {
          failOnce = false
          throw new Error("transient dispatch failure")
        }
      },
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1" })
    inbound.length = 0

    const command = makeCommand({ commandId: "retry-1" })
    await pair.client.send({ kind: "command", command })
    expect(rejectedFrames(inbound)).toHaveLength(1)
    expect(rejectedFrames(inbound)[0]?.issue).toBe("dispatch_failed")

    inbound.length = 0
    await pair.client.send({ kind: "command", command })
    // Re-dispatched (not dedup-rejected), succeeded, and NO rejected frame.
    expect(dispatched).toEqual(["retry-1", "retry-1"])
    expect(rejectedFrames(inbound)).toHaveLength(0)
    await bridge.close()
  })

  test("PAIRED CONTROL: a successful command produces NO rejected frame (promotion is failure-gated)", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onCommand: async () => undefined,
    })
    const pair = createTransportPair()
    const inbound: SessionTransportMessage[] = []
    pair.client.onMessage((m) => {
      inbound.push(m)
    })
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1" })
    inbound.length = 0

    await pair.client.send({ kind: "command", command: makeCommand({ commandId: "ok-1" }) })
    expect(inbound).toEqual([])
    await bridge.close()
  })

  test("server-side onBridgeError observability is PRESERVED alongside the new peer notification", async () => {
    // The promotion must be ADDITIVE: existing server-side diagnostics
    // (T06 wiring in sdk/runtime/session/engine.ts) keep firing.
    const bridgeErrors: unknown[] = []
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot("stdio"),
      onCommand: async () => {
        throw new Error("boom")
      },
      onBridgeError: ({ error }) => bridgeErrors.push(error),
    })
    const pair = createTransportPair()
    await bridge.connect(pair.server)
    await pair.client.send({ kind: "connect", sessionId: "session-1" })
    await pair.client.send({ kind: "command", command: makeCommand({ commandId: "e-1" }) })
    expect(bridgeErrors).toHaveLength(1)
    await bridge.close()
  })
})

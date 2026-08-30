/**
 * ★ HELLGATE (P0-C) — an objective refusal names itself on the wire.
 *
 * MEASURED DEFECT (2026-08-30, round-2 audit): the kernel raises two TYPED
 * objective errors — `SessionObjectiveRejectedError` (the authority's policy
 * `CommitRejection` tag) and `SessionObjectiveConflictError` (a CAS conflict
 * with both revisions). Both extend the plain `SessionProtocolError`, and
 * `rejectDispatchFailure` preserves only `SessionProtocolValidationError` /
 * `SessionRevisionConflictError`. So both collapsed into
 * `SessionDispatchFailedError` and reached the peer as `issue:"dispatch_failed"`
 * — the same three characters a host crash produces. A policy refusal, a lost
 * race and a bug were indistinguishable, which reads to an operator as a broken
 * system rather than an answer.
 *
 * The fix stays inside the SHIPPED encoding: the reject-reason set is CLOSED at
 * four on the wire (an old peer hard-checks it — `codec.ts`), and the documented
 * carrier for detail is the free-form `issue` string. So the policy tag rides
 * `protocol_validation` + `issue`, and the CAS conflict rides the reason that
 * already exists for exactly that. No union widening, no frontend change: the
 * client's `typedErrorFromRejectedMessage` already passes an unknown issue
 * through, and the web renders `turn rejected: <issue>` verbatim.
 */

import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  decodeSessionTransportMessage,
  SessionDispatchFailedError,
  type SessionTransport,
  type SessionTransportMessage,
  typedErrorFromRejectedMessage,
} from "@/ipc/session"
import {
  SESSION_PROTOCOL_VERSION,
  SessionObjectiveConflictError,
  SessionObjectiveRejectedError,
  SessionProtocolValidationError,
  SessionRevisionConflictError,
} from "@/protocol/session"
import { makeCommand, makeSnapshot } from "./session-transport-conformance-fixtures"

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
      for (const handler of [...remote]) await handler(message)
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      closeLocal()
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

/** Drive one command through the real bridge and return the frames the PEER saw. */
const rejectionFor = async (thrown: unknown) => {
  const bridge = createSessionTransportBridge({
    snapshot: makeSnapshot("stdio"),
    onCommand: async () => {
      throw thrown
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
  await bridge.close()
  const frame = inbound[0]
  if (frame?.kind !== "rejected") throw new Error(`expected a rejected frame, got ${frame?.kind}`)
  return frame
}

describe("GOAL P0-C — a policy refusal carries its tag", () => {
  test("SessionObjectiveRejectedError rides protocol_validation with the CommitRejection tag", async () => {
    const frame = await rejectionFor(new SessionObjectiveRejectedError("invalid-transition"))

    expect(frame.reason).toBe("protocol_validation")
    expect(frame.issue).toBe("objective:invalid-transition")
    expect(frame.issue).not.toBe("dispatch_failed")
  })

  test("a second, different tag is not flattened into the first", async () => {
    const frame = await rejectionFor(new SessionObjectiveRejectedError("objective-exists"))

    expect(frame.issue).toBe("objective:objective-exists")
  })

  test("the peer reconstructs a typed validation error, not a dispatch failure", async () => {
    const frame = await rejectionFor(new SessionObjectiveRejectedError("actor-forbidden"))

    const typed = typedErrorFromRejectedMessage(frame)
    expect(typed).toBeInstanceOf(SessionProtocolValidationError)
    expect(typed).not.toBeInstanceOf(SessionDispatchFailedError)
    expect((typed as SessionProtocolValidationError).issue).toBe("objective:actor-forbidden")
  })
})

describe("GOAL P0-C — a CAS conflict is a conflict", () => {
  test("SessionObjectiveConflictError rides revision_conflict with both revisions", async () => {
    const frame = await rejectionFor(new SessionObjectiveConflictError(3, 5))

    expect(frame.reason).toBe("revision_conflict")
    expect(frame.expectedRevision).toBe(3)
    expect(frame.actualRevision).toBe(5)
    expect(typedErrorFromRejectedMessage(frame)).toBeInstanceOf(SessionRevisionConflictError)
  })
})

describe("GOAL P0-C — the fix does not widen the shipped wire contract", () => {
  test("PAIRED CONTROL — a genuine host crash is still dispatch_failed", async () => {
    const frame = await rejectionFor(new Error("host exploded mid-dispatch"))

    expect(frame.reason).toBe("protocol_validation")
    expect(frame.issue).toBe("dispatch_failed")
  })

  test("the reject-reason set is still closed at four (a 5th literal is refused)", () => {
    const encoded = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "rejected",
      sessionId: "session-1",
      target: "command",
      reason: "objective_rejected",
      commandId: "c-1",
    })
    expect(() => decodeSessionTransportMessage(encoded)).toThrow(/bad_transport_reject_reason/)
  })
})

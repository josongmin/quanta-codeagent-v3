/**
 * S5 (jul-16 SDK ticket 01) — typed surfacing of EVERY `rejected` kind.
 *
 * The wire keeps its CLOSED-4 reason set (S0-3: old peers hard-check it), so
 * the "rejected 5종" of the ticket are keyed on reason + issue reuse:
 *
 *   1. duplicate_command                        → SessionDuplicateCommandError
 *   2. revision_conflict                        → SessionRevisionConflictError
 *   3. session_id_mismatch                      → SessionProtocolValidationError
 *   4. protocol_validation + kernel issue       → SessionProtocolValidationError
 *   5. protocol_validation + "dispatch_failed"  → SessionDispatchFailedError
 *   (+ protocol_validation + "bad_version"      → SessionProtocolVersionError,
 *      the S5b skew arm — covered here and in transport-version-skew.test.ts)
 *
 * Also proves the S5a rejection END-TO-END over the REAL codec on BOTH
 * conformance transports (stdio × websocket): the raw duplex pairs run every
 * frame through encode/decode, so the new `issue`-bearing rejected frame is
 * shown to survive the actual wire, not just an in-memory typed pair.
 */
import { describe, expect, test } from "bun:test"
import {
  createSessionTransportBridge,
  SessionDispatchFailedError,
  SessionDuplicateCommandError,
  type SessionTransportMessage,
  type SessionTransportRejectedMessage,
  typedErrorFromRejectedMessage,
} from "@/ipc/session"
import {
  SessionProtocolValidationError,
  SessionProtocolVersionError,
  SessionRevisionConflictError,
} from "@/protocol/session"
import {
  createHarness,
  makeCommand,
  makeSnapshot,
  type TransportKind,
} from "./session-transport-conformance-fixtures"

const rejected = (
  overrides: Partial<SessionTransportRejectedMessage> = {},
): SessionTransportRejectedMessage => ({
  kind: "rejected",
  sessionId: "session-1",
  target: "command",
  reason: "protocol_validation",
  ...overrides,
})

describe("typedErrorFromRejectedMessage — the 5 rejected kinds each map to a typed error", () => {
  test("1/5 duplicate_command → SessionDuplicateCommandError (carries the commandId)", () => {
    const error = typedErrorFromRejectedMessage(
      rejected({ reason: "duplicate_command", commandId: "dup-9" }),
    )
    expect(error).toBeInstanceOf(SessionDuplicateCommandError)
    expect((error as SessionDuplicateCommandError).commandId).toBe("dup-9")
  })

  test("2/5 revision_conflict → SessionRevisionConflictError (carries both revisions)", () => {
    const error = typedErrorFromRejectedMessage(
      rejected({ reason: "revision_conflict", expectedRevision: 5, actualRevision: 8 }),
    )
    expect(error).toBeInstanceOf(SessionRevisionConflictError)
    expect((error as SessionRevisionConflictError).expectedRevision).toBe(5)
    expect((error as SessionRevisionConflictError).actualRevision).toBe(8)
  })

  test("3/5 session_id_mismatch → SessionProtocolValidationError('session_id_mismatch')", () => {
    const error = typedErrorFromRejectedMessage(rejected({ reason: "session_id_mismatch" }))
    expect(error).toBeInstanceOf(SessionProtocolValidationError)
    expect((error as SessionProtocolValidationError).issue).toBe("session_id_mismatch")
  })

  test("4/5 protocol_validation + kernel issue → SessionProtocolValidationError with the issue verbatim", () => {
    const error = typedErrorFromRejectedMessage(rejected({ issue: "empty_turn_input" }))
    expect(error).toBeInstanceOf(SessionProtocolValidationError)
    expect((error as SessionProtocolValidationError).issue).toBe("empty_turn_input")
    // NOT mistaken for the version or dispatch arms.
    expect(error).not.toBeInstanceOf(SessionProtocolVersionError)
    expect(error).not.toBeInstanceOf(SessionDispatchFailedError)
  })

  test("5/5 protocol_validation + dispatch_failed → SessionDispatchFailedError", () => {
    const error = typedErrorFromRejectedMessage(
      rejected({ issue: "dispatch_failed", commandId: "cmd-3" }),
    )
    expect(error).toBeInstanceOf(SessionDispatchFailedError)
    expect((error as SessionDispatchFailedError).commandId).toBe("cmd-3")
  })

  test("S5b arm: protocol_validation + bad_version → SessionProtocolVersionError", () => {
    const error = typedErrorFromRejectedMessage(
      rejected({ issue: "bad_version", commandId: "cmd-v" }),
    )
    expect(error).toBeInstanceOf(SessionProtocolVersionError)
    expect((error as SessionProtocolVersionError).commandId).toBe("cmd-v")
    expect((error as SessionProtocolVersionError).localVersion).toBe("session.v1")
  })

  test("issue-less protocol_validation degrades to a generic validation error (never throws)", () => {
    const error = typedErrorFromRejectedMessage(rejected({}))
    expect(error).toBeInstanceOf(SessionProtocolValidationError)
    expect((error as SessionProtocolValidationError).issue).toBe("protocol_validation")
  })
})

describe.each<TransportKind>([
  "stdio",
  "websocket",
])("S5a over the REAL %s codec path (conformance harness)", (kind) => {
  test("a dispatch failure reaches the client as a decoded rejected frame with the issue intact", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot(kind, { revision: 5, seq: 10 }),
      onCommand: async () => {
        throw new SessionProtocolValidationError("empty_turn_input")
      },
    })
    const harness = await createHarness({ kind, bridge })
    const seen: SessionTransportMessage[] = []
    harness.client.onMessage((message) => {
      seen.push(message)
    })
    await harness.client.connect()
    seen.length = 0

    await harness.client.sendCommand(
      makeCommand({ commandId: `${kind}-dispatch-fail`, expectedRevision: 5 }),
    )

    expect(seen).toEqual([
      {
        kind: "rejected",
        sessionId: "session-1",
        target: "command",
        reason: "protocol_validation",
        commandId: `${kind}-dispatch-fail`,
        issue: "empty_turn_input",
      },
    ])

    await harness.close()
    await bridge.close()
  })

  test("the convenience client's onRejected forwards the typed error (wrapper seam not dead)", async () => {
    const bridge = createSessionTransportBridge({
      snapshot: makeSnapshot(kind, { revision: 5, seq: 10 }),
      onCommand: async () => {
        throw new Error("kaboom")
      },
    })
    const typed: unknown[] = []
    const harness = await createHarness({
      kind,
      bridge,
      onRejected: ({ error }) => {
        typed.push(error)
      },
    })
    await harness.client.connect()
    await harness.client.sendCommand(
      makeCommand({ commandId: `${kind}-typed-fail`, expectedRevision: 5 }),
    )

    expect(typed).toHaveLength(1)
    expect(typed[0]).toBeInstanceOf(SessionDispatchFailedError)
    expect((typed[0] as SessionDispatchFailedError).commandId).toBe(`${kind}-typed-fail`)

    await harness.close()
    await bridge.close()
  })
})

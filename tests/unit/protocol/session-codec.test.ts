import { describe, expect, test } from "bun:test"
import {
  decodeSessionCommand,
  decodeSessionEvent,
  encodeSessionCommand,
  encodeSessionEvent,
  SESSION_PROTOCOL_VERSION,
  SessionProtocolValidationError,
} from "@/protocol/session"

describe("@/protocol/session codec", () => {
  test("round-trips commands with envelope metadata", () => {
    const raw = encodeSessionCommand({
      sessionId: "s1",
      commandId: "c1",
      issuedAt: "2026-05-26T00:00:00.000Z",
      expectedRevision: 3,
      type: "input.append",
      text: "ping",
      images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
    })
    expect(decodeSessionCommand(raw)).toEqual({
      sessionId: "s1",
      commandId: "c1",
      issuedAt: "2026-05-26T00:00:00.000Z",
      expectedRevision: 3,
      type: "input.append",
      text: "ping",
      images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
    })
  })

  test("round-trips events with ordering metadata", () => {
    const raw = encodeSessionEvent({
      eventId: "e1",
      seq: 2,
      revision: 4,
      emittedAt: "2026-05-26T00:00:01.000Z",
      causedByCommandId: "c1",
      type: "turn.completed",
      outcomeReason: "completed",
    })
    expect(decodeSessionEvent(raw)).toEqual({
      eventId: "e1",
      seq: 2,
      revision: 4,
      emittedAt: "2026-05-26T00:00:01.000Z",
      causedByCommandId: "c1",
      type: "turn.completed",
      outcomeReason: "completed",
    })
  })

  test("rejects bad protocol versions", () => {
    const raw = JSON.stringify({
      version: `${SESSION_PROTOCOL_VERSION}.bad`,
      kind: "command",
      payload: {
        sessionId: "s1",
        commandId: "c1",
        issuedAt: "2026-05-26T00:00:00.000Z",
        type: "turn.run",
      },
    })
    expect(() => decodeSessionCommand(raw)).toThrow(SessionProtocolValidationError)
  })

  test("rejects malformed event envelopes", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "event",
      payload: {
        eventId: "e1",
        emittedAt: "2026-05-26T00:00:00.000Z",
        type: "turn.started",
      },
    })
    expect(() => decodeSessionEvent(raw)).toThrow(SessionProtocolValidationError)
  })
})

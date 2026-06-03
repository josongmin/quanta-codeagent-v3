import { describe, expect, test } from "bun:test"
import {
  CANVAS_PROTOCOL_VERSION,
  decodeCanvasFrame,
  encodeCanvasFrame,
} from "@/protocol/canvas"
import {
  decodeObservabilityFrame,
  encodeObservabilityFrame,
  OBSERVABILITY_PROTOCOL_VERSION,
} from "@/protocol/observability"
import {
  decodeSessionCommand,
  decodeSessionEvent,
  SESSION_PROTOCOL_VERSION,
  SessionProtocolValidationError,
} from "@/protocol/session"

/**
 * Hellgate: U6-protocol-validate.
 *
 *  (9) TYPE_SAFETY — decodeSessionCommand/Event must assert the TYPE of each
 *      envelope field, not just its presence. A string `"5"` revision !== a
 *      numeric `5` revision (spurious revision_conflict that wedges the
 *      client); a numeric commandId breaks the string-keyed dedup/replay maps.
 *
 *  (14) PROTOCOL_IPC — the observability + canvas frame decoders must GATE the
 *      protocol version they claim to carry. A v2 emitter to a v1 consumer
 *      must be dropped (return null), not read with the wrong schema.
 */

const wrap = (kind: "command" | "event", payload: Record<string, unknown>): string =>
  JSON.stringify({ version: SESSION_PROTOCOL_VERSION, kind, payload })

const goodCommand = (): Record<string, unknown> => ({
  sessionId: "s1",
  commandId: "c1",
  issuedAt: "2026-05-26T00:00:00.000Z",
  type: "input.append",
  text: "ping",
})

const goodEvent = (): Record<string, unknown> => ({
  eventId: "e1",
  seq: 3,
  revision: 5,
  emittedAt: "2026-05-26T00:00:00.000Z",
  type: "turn.started",
  prompt: "",
  images: [],
})

describe("(9) session codec rejects mistyped envelope fields", () => {
  test("baseline: a well-typed command/event decodes", () => {
    expect(() => decodeSessionCommand(wrap("command", goodCommand()))).not.toThrow()
    expect(() => decodeSessionEvent(wrap("event", goodEvent()))).not.toThrow()
  })

  test("numeric commandId is rejected (would break string-keyed dedup map)", () => {
    const bad = { ...goodCommand(), commandId: 42 }
    expect(() => decodeSessionCommand(wrap("command", bad))).toThrow(SessionProtocolValidationError)
  })

  test("numeric sessionId is rejected", () => {
    const bad = { ...goodCommand(), sessionId: 7 }
    expect(() => decodeSessionCommand(wrap("command", bad))).toThrow(SessionProtocolValidationError)
  })

  test("string '5' expectedRevision is rejected (spurious revision_conflict)", () => {
    const bad = { ...goodCommand(), expectedRevision: "5" }
    expect(() => decodeSessionCommand(wrap("command", bad))).toThrow(SessionProtocolValidationError)
  })

  test("absent optional expectedRevision is allowed", () => {
    const ok = goodCommand()
    expect("expectedRevision" in ok).toBe(false)
    expect(() => decodeSessionCommand(wrap("command", ok))).not.toThrow()
  })

  test("string '5' event revision is rejected (the wedge bug)", () => {
    const bad = { ...goodEvent(), revision: "5" }
    expect(() => decodeSessionEvent(wrap("event", bad))).toThrow(SessionProtocolValidationError)
  })

  test("string seq is rejected", () => {
    const bad = { ...goodEvent(), seq: "3" }
    expect(() => decodeSessionEvent(wrap("event", bad))).toThrow(SessionProtocolValidationError)
  })

  test("non-finite numeric seq/revision is rejected", () => {
    // JSON.stringify turns NaN/Infinity into null, so inject post-parse-shaped
    // strings the codec must reject by going through a hand-built envelope.
    const badRev = { ...goodEvent(), revision: Number.POSITIVE_INFINITY }
    // Number.POSITIVE_INFINITY serializes to null → typeof null !== "number" → reject.
    expect(() => decodeSessionEvent(wrap("event", badRev))).toThrow(SessionProtocolValidationError)
  })

  test("numeric type tag is rejected before the type-enum guard", () => {
    const bad = { ...goodEvent(), type: 123 }
    expect(() => decodeSessionEvent(wrap("event", bad))).toThrow(SessionProtocolValidationError)
  })

  test("numeric causedByCommandId (when present) is rejected", () => {
    const bad = { ...goodEvent(), causedByCommandId: 99 }
    expect(() => decodeSessionEvent(wrap("event", bad))).toThrow(SessionProtocolValidationError)
  })
})

describe("(14) observability frame decoder gates the protocol version", () => {
  test("baseline: a current-version frame round-trips", () => {
    const wire = encodeObservabilityFrame({
      kind: "observability.snapshot",
      runs: [],
      objective: null,
      approvals: [],
      emittedAt: 0,
    })
    expect(decodeObservabilityFrame(wire)).not.toBeNull()
  })

  test("a future-version (v2) frame is DROPPED, not read with the v1 schema", () => {
    const futureVersion = `${OBSERVABILITY_PROTOCOL_VERSION}.next`
    expect(futureVersion).not.toBe(OBSERVABILITY_PROTOCOL_VERSION)
    const wire = JSON.stringify({
      version: futureVersion,
      kind: "observability",
      payload: {
        kind: "observability.snapshot",
        runs: [],
        objective: null,
        approvals: [],
        emittedAt: 0,
      },
    })
    expect(decodeObservabilityFrame(wire)).toBeNull()
  })

  test("an arbitrary wrong version string is dropped even with a valid payload", () => {
    const wire = JSON.stringify({
      version: "observability.v2",
      kind: "observability",
      payload: {
        kind: "observability.delta",
        emittedAt: 1,
      },
    })
    expect(decodeObservabilityFrame(wire)).toBeNull()
  })
})

describe("(14) canvas frame decoder gates the protocol version", () => {
  test("baseline: a current-version frame round-trips", () => {
    const wire = encodeCanvasFrame({
      kind: "context.usage",
      segments: [{ id: "System", tokens: 10 }],
      total: 10,
      max: 100,
      emittedAt: 7,
    })
    expect(decodeCanvasFrame(wire)).not.toBeNull()
  })

  test("a future-version (v2) frame is DROPPED, not read with the v1 schema", () => {
    const futureVersion = `${CANVAS_PROTOCOL_VERSION}.next`
    expect(futureVersion).not.toBe(CANVAS_PROTOCOL_VERSION)
    const wire = JSON.stringify({
      version: futureVersion,
      kind: "canvas",
      payload: {
        kind: "context.usage",
        segments: [{ id: "System", tokens: 10 }],
        total: 10,
        max: 100,
        emittedAt: 7,
      },
    })
    expect(decodeCanvasFrame(wire)).toBeNull()
  })

  test("an arbitrary wrong version string is dropped even with a valid payload", () => {
    const wire = JSON.stringify({
      version: "canvas.v2",
      kind: "canvas",
      payload: {
        kind: "tool.diff",
        toolCallId: "t1",
        lines: [],
        additions: 0,
        deletions: 0,
        emittedAt: 0,
      },
    })
    expect(decodeCanvasFrame(wire)).toBeNull()
  })
})

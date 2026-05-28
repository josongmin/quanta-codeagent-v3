import { describe, expect, it } from "vitest"
import {
  decodeObservabilityFrame,
  decodeSnapshotFrame,
  decodeRejectedFrame,
  decodeEventFrame,
  encodeConnectFrame,
  encodeCommandFrame,
  isEventEnvelope,
  peekEnvelopeKind,
  SESSION_PROTOCOL_VERSION,
} from "./envelope"

describe("encodeCommandFrame", () => {
  it("wraps a command payload with the session protocol version + kind tag", () => {
    const raw = encodeCommandFrame({
      sessionId: "s1",
      commandId: "c1",
      issuedAt: "2026-05-26T00:00:00.000Z",
      type: "turn.run",
    })
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed.kind).toBe("command")
    expect(parsed.version).toBe(SESSION_PROTOCOL_VERSION)
    expect(parsed.payload).toMatchObject({
      sessionId: "s1",
      commandId: "c1",
      type: "turn.run",
    })
  })

  it("round-trips through a JSON parse without losing required fields", () => {
    const raw = encodeCommandFrame({
      sessionId: "s2",
      commandId: "c2",
      issuedAt: "2026-05-26T00:00:01.000Z",
      type: "input.append",
      text: "hello",
    })
    const parsed = JSON.parse(raw) as { payload: Record<string, unknown> }
    expect(parsed.payload.text).toBe("hello")
    expect(parsed.payload.type).toBe("input.append")
  })
})

describe("encodeConnectFrame", () => {
  it("emits the flat connect control envelope used by the handshake path", () => {
    const raw = encodeConnectFrame("srv-1")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed).toMatchObject({
      version: SESSION_PROTOCOL_VERSION,
      kind: "connect",
      sessionId: "srv-1",
    })
    expect("payload" in parsed).toBe(false)
  })
})

describe("decodeEventFrame", () => {
  const validEvent = JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    kind: "event",
    payload: {
      eventId: "e1",
      seq: 0,
      revision: 1,
      emittedAt: "2026-05-26T00:00:00.000Z",
      type: "session.created",
      capabilityManifest: {
        approvals: "none",
        tools: false,
        memory: false,
        artifacts: false,
        subagents: false,
        automation: false,
        shellSnapshot: false,
        transport: "websocket",
      },
    },
  })

  it("returns the typed event payload for a well-formed envelope", () => {
    const decoded = decodeEventFrame(validEvent)
    expect(decoded?.type).toBe("session.created")
    expect(decoded?.seq).toBe(0)
  })

  it("accepts turn.output.delta event envelopes", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "event",
      payload: {
        eventId: "delta-1",
        seq: 4,
        revision: 3,
        emittedAt: "2026-05-26T00:00:00.000Z",
        type: "turn.output.delta",
        delta: "pong",
      },
    })
    expect(decodeEventFrame(raw)).toEqual({
      eventId: "delta-1",
      seq: 4,
      revision: 3,
      emittedAt: "2026-05-26T00:00:00.000Z",
      type: "turn.output.delta",
      delta: "pong",
    })
  })

  it("returns null for a non-string input (Blob / ArrayBuffer placeholder)", () => {
    expect(decodeEventFrame(123)).toBeNull()
    expect(decodeEventFrame(null)).toBeNull()
    expect(decodeEventFrame(undefined)).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(decodeEventFrame("{not json")).toBeNull()
  })

  it("returns null when kind is not 'event'", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "snapshot",
      payload: { sessionId: "s", revision: 0, seq: 0 },
    })
    expect(decodeEventFrame(raw)).toBeNull()
  })

  it("returns null when the payload type tag is unknown", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "event",
      payload: {
        eventId: "e",
        seq: 0,
        revision: 0,
        emittedAt: "x",
        type: "future.event.kind",
      },
    })
    expect(decodeEventFrame(raw)).toBeNull()
  })

  it("returns null when seq is missing or non-finite", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "event",
      payload: {
        eventId: "e",
        seq: Number.NaN,
        revision: 0,
        emittedAt: "x",
        type: "turn.started",
        prompt: "",
      },
    })
    expect(decodeEventFrame(raw)).toBeNull()
  })
})

describe("decodeRejectedFrame", () => {
  it("returns the canonical sessionId when a rejected control frame carries one", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "rejected",
      target: "connect",
      reason: "protocol_validation",
      sessionId: "srv-1",
    })
    expect(decodeRejectedFrame(raw)).toEqual({
      target: "connect",
      reason: "protocol_validation",
      sessionId: "srv-1",
    })
  })

  it("returns the rejection reason even when no canonical sessionId is present", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "rejected",
      target: "command",
      reason: "protocol_validation",
      issue: "session_id_mismatch",
    })
    expect(decodeRejectedFrame(raw)).toEqual({
      target: "command",
      reason: "protocol_validation",
      issue: "session_id_mismatch",
    })
  })

  it("returns null for malformed or non-rejected frames", () => {
    expect(decodeRejectedFrame("{")).toBeNull()
    expect(
      decodeRejectedFrame(
        JSON.stringify({
          version: SESSION_PROTOCOL_VERSION,
          kind: "event",
          payload: { type: "turn.started" },
        }),
      ),
    ).toBeNull()
  })
})

describe("decodeSnapshotFrame", () => {
  it("returns the snapshot payload when the frame is well-formed", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "snapshot",
      payload: {
        sessionId: "srv-1",
        revision: 3,
        seq: 8,
        state: {
          status: "idle",
          draftInput: "",
          permissionMode: "default",
          messageCount: 2,
          lastUserText: "hello",
          lastAssistantText: "world",
          streamingAssistantText: "wor",
          lastOutcomeReason: "completed",
        },
        capabilities: {
          approvals: "none",
          tools: true,
          memory: false,
          artifacts: false,
          subagents: false,
          automation: false,
          shellSnapshot: false,
          transport: "websocket",
        },
        pendingApproval: null,
        openArtifacts: [],
      },
    })
    expect(decodeSnapshotFrame(raw)).toEqual({
      sessionId: "srv-1",
      revision: 3,
      seq: 8,
      state: {
        status: "idle",
        draftInput: "",
        permissionMode: "default",
        messageCount: 2,
        lastUserText: "hello",
        lastAssistantText: "world",
        streamingAssistantText: "wor",
        lastOutcomeReason: "completed",
      },
      capabilities: {
        approvals: "none",
        tools: true,
        memory: false,
        artifacts: false,
        subagents: false,
        automation: false,
        shellSnapshot: false,
        transport: "websocket",
      },
      pendingApproval: null,
      openArtifacts: [],
    })
  })

  it("returns null for malformed or non-snapshot frames", () => {
    expect(decodeSnapshotFrame("{")).toBeNull()
    expect(
      decodeSnapshotFrame(
        JSON.stringify({
          version: SESSION_PROTOCOL_VERSION,
          kind: "snapshot",
          payload: {
            sessionId: "srv-1",
            revision: "3",
            seq: 8,
            state: {
              status: "idle",
              draftInput: "",
              permissionMode: "default",
              messageCount: 0,
            },
            capabilities: {
              approvals: "none",
              tools: true,
              memory: false,
              artifacts: false,
              subagents: false,
              automation: false,
              shellSnapshot: false,
              transport: "websocket",
            },
            pendingApproval: null,
            openArtifacts: [],
          },
        }),
      ),
    ).toBeNull()
  })
})

describe("decodeObservabilityFrame", () => {
  it("returns the snapshot payload for a well-formed observability frame", () => {
    const raw = JSON.stringify({
      version: "observability.v1",
      kind: "observability",
      payload: {
        kind: "observability.snapshot",
        runs: [],
        objective: null,
        approvals: [],
        emittedAt: 123,
      },
    })
    expect(decodeObservabilityFrame(raw)).toEqual({
      kind: "observability.snapshot",
      runs: [],
      objective: null,
      approvals: [],
      emittedAt: 123,
    })
  })

  it("returns the delta payload for a well-formed observability frame", () => {
    const raw = JSON.stringify({
      version: "observability.v1",
      kind: "observability",
      payload: {
        kind: "observability.delta",
        runChanges: [{ id: "run-1", entry: null }],
        objectiveChanged: null,
        approvalChanges: [{ id: "approval-1", approval: null }],
        emittedAt: 456,
      },
    })
    expect(decodeObservabilityFrame(raw)).toEqual({
      kind: "observability.delta",
      runChanges: [{ id: "run-1", entry: null }],
      objectiveChanged: null,
      approvalChanges: [{ id: "approval-1", approval: null }],
      emittedAt: 456,
    })
  })

  it("returns null for malformed or non-observability frames", () => {
    expect(decodeObservabilityFrame("{")).toBeNull()
    expect(
      decodeObservabilityFrame(
        JSON.stringify({
          version: "observability.v1",
          kind: "observability",
          payload: {
            kind: "observability.snapshot",
            runs: "nope",
            objective: null,
            approvals: [],
            emittedAt: 1,
          },
        }),
      ),
    ).toBeNull()
    expect(
      decodeObservabilityFrame(
        JSON.stringify({
          version: "observability.v1",
          kind: "event",
          payload: {
            kind: "observability.snapshot",
            runs: [],
            objective: null,
            approvals: [],
            emittedAt: 1,
          },
        }),
      ),
    ).toBeNull()
  })
})

describe("peekEnvelopeKind", () => {
  it("returns the kind tag verbatim for any object envelope", () => {
    expect(peekEnvelopeKind('{"kind":"snapshot"}')).toBe("snapshot")
    expect(peekEnvelopeKind('{"kind":"rejected"}')).toBe("rejected")
    expect(peekEnvelopeKind('{"kind":"observability"}')).toBe("observability")
  })

  it("returns null when input is not a string or not JSON", () => {
    expect(peekEnvelopeKind(42)).toBeNull()
    expect(peekEnvelopeKind("{")).toBeNull()
  })

  it("returns null when kind is missing", () => {
    expect(peekEnvelopeKind("{}")).toBeNull()
  })
})

describe("isEventEnvelope", () => {
  it("accepts an envelope with kind:event + valid type tag", () => {
    const env = {
      version: SESSION_PROTOCOL_VERSION,
      kind: "event",
      payload: { type: "turn.completed", outcomeReason: "ok" },
    }
    expect(isEventEnvelope(env)).toBe(true)
  })

  it("rejects unknown shapes", () => {
    expect(isEventEnvelope(null)).toBe(false)
    expect(isEventEnvelope({})).toBe(false)
    expect(isEventEnvelope({ kind: "command" })).toBe(false)
  })
})

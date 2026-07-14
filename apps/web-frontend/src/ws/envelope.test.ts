import { describe, expect, it } from "vitest"
import {
  CANVAS_PROTOCOL_VERSION,
  decodeCanvasFrame,
  decodeEventFrame,
  decodeObservabilityFrame,
  decodeRejectedFrame,
  decodeSnapshotFrame,
  decodeSubagentFromEnvelope,
  encodeCommandFrame,
  encodeConnectFrame,
  isEventEnvelope,
  parseEnvelope,
  peekEnvelopeKind,
  SESSION_PROTOCOL_VERSION,
  SUBAGENT_PROTOCOL_VERSION,
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

  it("omits resumeFromSeq when none is provided (first-connect path stays byte-identical)", () => {
    const raw = encodeConnectFrame("srv-1")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect("resumeFromSeq" in parsed).toBe(false)
    // Byte-identical to the legacy 3-key frame.
    expect(raw).toBe(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        kind: "connect",
        sessionId: "srv-1",
      }),
    )
  })

  it("emits resumeFromSeq on reconnect when a last-seen seq is supplied", () => {
    const raw = encodeConnectFrame("srv-1", 12)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed).toMatchObject({
      version: SESSION_PROTOCOL_VERSION,
      kind: "connect",
      sessionId: "srv-1",
      resumeFromSeq: 12,
    })
  })

  it("emits resumeFromSeq=0 (a valid bootstrap seq) rather than dropping it", () => {
    const raw = encodeConnectFrame("srv-1", 0)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed.resumeFromSeq).toBe(0)
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

  it("accepts turn.llm.request event envelopes (decode gate covers the LLM lifecycle)", () => {
    // Regression for the decode-gate drift: `turn.llm.request` is a canonical
    // event the daemon emits. When EVENT_TYPES missed it, decodeEventFrame
    // returned null → the client dropped the frame AND its seq (breaking resume).
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "event",
      payload: {
        eventId: "llm-req-1",
        seq: 6,
        revision: 2,
        emittedAt: "2026-05-26T00:00:00.000Z",
        type: "turn.llm.request",
        model: "gpt-5",
        provider: "openai",
      },
    })
    const decoded = decodeEventFrame(raw)
    expect(decoded).not.toBeNull()
    expect(decoded?.type).toBe("turn.llm.request")
    expect(decoded?.seq).toBe(6)
  })

  it("accepts turn.llm.continuation event envelopes (decode gate covers the LLM lifecycle)", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "event",
      payload: {
        eventId: "llm-cont-1",
        seq: 7,
        revision: 2,
        emittedAt: "2026-05-26T00:00:00.000Z",
        type: "turn.llm.continuation",
        surfaceId: "openai-responses",
        transportId: "responses",
        phase: "resume",
        mode: "stream",
        reason: "incomplete",
      },
    })
    const decoded = decodeEventFrame(raw)
    expect(decoded).not.toBeNull()
    expect(decoded?.type).toBe("turn.llm.continuation")
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

  // UUX-1-12 — the additive observability tags pass the decode gate. (An OLD
  // frontend without them in EVENT_TYPES hits the unknown-tag null path below —
  // the graceful-ignore contract for new event types.)
  it("decodes the additive observability event tags", () => {
    for (const payload of [
      { type: "tool.progress", toolCallId: "c1", toolName: "bash", message: "run" },
      { type: "turn.recovery", reason: "backoff" },
      { type: "context.compacted", fromTurnId: "a", toTurnId: "b", summary: "s", ts: 1, tokens: 2 },
      { type: "budget.breach", severity: "soft", scope: "session-x", observed: 2, limit: 1 },
    ]) {
      const raw = JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        kind: "event",
        payload: { eventId: "e", seq: 0, revision: 0, emittedAt: "x", ...payload },
      })
      const decoded = decodeEventFrame(raw)
      expect(decoded).not.toBeNull()
      expect(decoded?.type).toBe(payload.type as NonNullable<typeof decoded>["type"])
    }
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

describe("decodeCanvasFrame", () => {
  const toolDiffFrame = JSON.stringify({
    version: CANVAS_PROTOCOL_VERSION,
    kind: "canvas",
    payload: {
      kind: "tool.diff",
      toolCallId: "tc-1",
      lines: [{ type: "added", content: "x", lineNumber: 1 }],
      additions: 1,
      deletions: 0,
      emittedAt: 7,
    },
  })

  it("decodes a tool.diff canvas frame into its payload", () => {
    const msg = decodeCanvasFrame(toolDiffFrame)
    expect(msg?.kind).toBe("tool.diff")
    if (msg?.kind === "tool.diff") {
      expect(msg.toolCallId).toBe("tc-1")
      expect(msg.additions).toBe(1)
    }
  })

  it("decodes a context.usage canvas frame into its payload", () => {
    const raw = JSON.stringify({
      version: CANVAS_PROTOCOL_VERSION,
      kind: "canvas",
      payload: {
        kind: "context.usage",
        segments: [{ id: "system", tokens: 10 }],
        total: 10,
        max: 100,
        emittedAt: 3,
      },
    })
    const msg = decodeCanvasFrame(raw)
    expect(msg?.kind).toBe("context.usage")
    if (msg?.kind === "context.usage") expect(msg.total).toBe(10)
  })

  it("rejects a canvas frame carrying a non-matching protocol version", () => {
    const raw = JSON.stringify({
      version: "canvas.v2",
      kind: "canvas",
      payload: { kind: "context.usage", segments: [], total: 1, max: 10, emittedAt: 1 },
    })
    expect(decodeCanvasFrame(raw)).toBeNull()
  })

  it("returns null for non-canvas / malformed frames", () => {
    expect(decodeCanvasFrame("{")).toBeNull()
    expect(decodeCanvasFrame(42)).toBeNull()
    expect(decodeCanvasFrame(JSON.stringify({ kind: "event" }))).toBeNull()
    // A canvas envelope whose payload fails the per-kind shape guard.
    expect(
      decodeCanvasFrame(
        JSON.stringify({
          version: CANVAS_PROTOCOL_VERSION,
          kind: "canvas",
          payload: { kind: "tool.diff" },
        }),
      ),
    ).toBeNull()
  })

  it("returns null when the version field is empty (empty-version branch)", () => {
    // An empty version string is as untrustworthy as a missing one — a v? emitter
    // read with the v1 schema would mis-render. Distinct from the version-MISMATCH
    // branch already covered above.
    const raw = JSON.stringify({
      version: "",
      kind: "canvas",
      payload: { kind: "context.usage", segments: [], total: 1, max: 10, emittedAt: 1 },
    })
    expect(decodeCanvasFrame(raw)).toBeNull()
  })

  it("returns null when the version field is missing entirely", () => {
    const raw = JSON.stringify({
      kind: "canvas",
      payload: { kind: "context.usage", segments: [], total: 1, max: 10, emittedAt: 1 },
    })
    expect(decodeCanvasFrame(raw)).toBeNull()
  })

  it("returns null for a context.usage payload that fails the per-kind shape guard", () => {
    // `segments` non-array / `total` non-number → isContextUsageShape false.
    const raw = JSON.stringify({
      version: CANVAS_PROTOCOL_VERSION,
      kind: "canvas",
      payload: { kind: "context.usage", segments: "nope", total: "x", max: 10, emittedAt: 1 },
    })
    expect(decodeCanvasFrame(raw)).toBeNull()
  })

  it("returns null when emittedAt is missing (shared canvas-message guard)", () => {
    const raw = JSON.stringify({
      version: CANVAS_PROTOCOL_VERSION,
      kind: "canvas",
      payload: { kind: "context.usage", segments: [], total: 1, max: 10 },
    })
    expect(decodeCanvasFrame(raw)).toBeNull()
  })
})

describe("decodeSubagentFromEnvelope", () => {
  const decode = (obj: unknown) => {
    const parsed = parseEnvelope(JSON.stringify(obj))
    return parsed === null ? null : decodeSubagentFromEnvelope(parsed)
  }
  const spawnFrame = {
    version: SUBAGENT_PROTOCOL_VERSION,
    kind: "subagent",
    payload: {
      type: "subagent_spawn",
      taskId: "t-1",
      parentTaskId: "p-0",
      depth: 2,
      description: "explore repo",
      agentType: "explorer",
      at: 5,
      emittedAt: 5,
    },
  }

  it("decodes a subagent_spawn frame into its payload", () => {
    const msg = decode(spawnFrame)
    expect(msg?.type).toBe("subagent_spawn")
    if (msg?.type === "subagent_spawn") {
      expect(msg.taskId).toBe("t-1")
      expect(msg.parentTaskId).toBe("p-0")
      expect(msg.depth).toBe(2)
    }
  })

  it("decodes a subagent_status frame into its payload", () => {
    const msg = decode({
      version: SUBAGENT_PROTOCOL_VERSION,
      kind: "subagent",
      payload: { type: "subagent_status", taskId: "t-1", status: "completed", at: 9, emittedAt: 9 },
    })
    expect(msg?.type).toBe("subagent_status")
    if (msg?.type === "subagent_status") expect(msg.status).toBe("completed")
  })

  it("rejects a subagent frame carrying a non-matching protocol version", () => {
    expect(decode({ ...spawnFrame, version: "subagent.v2" })).toBeNull()
  })

  it("returns null for non-subagent / malformed frames", () => {
    expect(decode({ kind: "event" })).toBeNull()
    // A subagent envelope whose payload fails the tag/`taskId`/`emittedAt` guard.
    expect(
      decode({ version: SUBAGENT_PROTOCOL_VERSION, kind: "subagent", payload: { type: "nope" } }),
    ).toBeNull()
    expect(
      decode({
        version: SUBAGENT_PROTOCOL_VERSION,
        kind: "subagent",
        payload: { type: "subagent_spawn", taskId: "t-1" },
      }),
    ).toBeNull()
  })
})

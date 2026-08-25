import { describe, expect, test } from "bun:test"
import type { SessionSnapshotLite } from "@/protocol/session"
import {
  decodeSessionCommand,
  decodeSessionEvent,
  decodeSessionSnapshot,
  encodeSessionCommand,
  encodeSessionEvent,
  encodeSessionSnapshot,
  SESSION_PROTOCOL_VERSION,
  SessionProtocolValidationError,
} from "@/protocol/session"
import { makeSnapshotLite } from "../../support/session-fixtures"

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

  test("B-MED-7: round-trips a turn.run's ADDITIVE causedByApprovalId (daemon continuation stamp)", () => {
    const raw = encodeSessionCommand({
      sessionId: "s1",
      commandId: "approval-continuation:ap-9",
      issuedAt: "2026-05-26T00:00:03.000Z",
      type: "turn.run",
      causedByApprovalId: "ap-9",
    })
    expect(decodeSessionCommand(raw)).toEqual({
      sessionId: "s1",
      commandId: "approval-continuation:ap-9",
      issuedAt: "2026-05-26T00:00:03.000Z",
      type: "turn.run",
      causedByApprovalId: "ap-9",
    })
  })

  test("B-MED-7: a bare turn.run stays byte-identical (no causedByApprovalId key)", () => {
    const decoded = decodeSessionCommand(
      encodeSessionCommand({
        sessionId: "s1",
        commandId: "c-bare",
        issuedAt: "2026-05-26T00:00:04.000Z",
        type: "turn.run",
      }),
    )
    expect(decoded).toEqual({
      sessionId: "s1",
      commandId: "c-bare",
      issuedAt: "2026-05-26T00:00:04.000Z",
      type: "turn.run",
    })
    expect("causedByApprovalId" in decoded).toBe(false)
  })

  test("B-MED-7: rejects a turn.run whose causedByApprovalId is a mistyped scalar (fail-closed)", () => {
    const raw = JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "command",
      payload: {
        sessionId: "s1",
        commandId: "c-bad",
        issuedAt: "2026-05-26T00:00:05.000Z",
        type: "turn.run",
        causedByApprovalId: 42,
      },
    })
    expect(() => decodeSessionCommand(raw)).toThrow(SessionProtocolValidationError)
  })

  test("round-trips turn.submit and rejects malformed provenance", () => {
    const command = {
      sessionId: "s1",
      commandId: "submit-1",
      issuedAt: "2026-05-26T00:00:06.000Z",
      type: "turn.submit" as const,
      text: "continue",
      expectedSessionRevision: 4,
      provenance: {
        kind: "goal-continuation" as const,
        objectiveId: "goal-1",
        objectiveRevision: 2,
        attemptId: "secret",
      },
    }
    expect(decodeSessionCommand(encodeSessionCommand(command))).toEqual(command)
    const malformed = JSON.parse(encodeSessionCommand(command))
    malformed.payload.provenance.objectiveRevision = "2"
    expect(() => decodeSessionCommand(JSON.stringify(malformed))).toThrow(
      SessionProtocolValidationError,
    )
  })

  test("round-trips transcript replace commands", () => {
    const raw = encodeSessionCommand({
      sessionId: "s1",
      commandId: "c2",
      issuedAt: "2026-05-26T00:00:02.000Z",
      type: "session.transcript.replace",
      messages: [
        { role: "user", content: [{ type: "text", text: "ping" }] },
        { role: "assistant", content: [{ type: "text", text: "pong" }] },
      ],
    })
    expect(decodeSessionCommand(raw)).toEqual({
      sessionId: "s1",
      commandId: "c2",
      issuedAt: "2026-05-26T00:00:02.000Z",
      type: "session.transcript.replace",
      messages: [
        { role: "user", content: [{ type: "text", text: "ping" }] },
        { role: "assistant", content: [{ type: "text", text: "pong" }] },
      ],
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
      assistantText: "pong",
    })
    expect(decodeSessionEvent(raw)).toEqual({
      eventId: "e1",
      seq: 2,
      revision: 4,
      emittedAt: "2026-05-26T00:00:01.000Z",
      causedByCommandId: "c1",
      type: "turn.completed",
      outcomeReason: "completed",
      assistantText: "pong",
    })
  })

  test("round-trips llm request and continuation session events", () => {
    const requestRaw = encodeSessionEvent({
      eventId: "e-llm-1",
      seq: 5,
      revision: 7,
      emittedAt: "2026-05-27T00:00:01.000Z",
      causedByCommandId: "c-llm",
      type: "turn.llm.request",
      model: "gpt-5",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      authMode: "OpenAI BYOK",
      policy: {
        mode: "review",
        baseSystem: "default",
        systemLayout: "single_block",
        repoRulesPresent: true,
        sessionCtxPresent: false,
        userAppendPresent: false,
        selectedGlobRuleNames: ["react.mdc"],
        activeSkillNames: ["rr"],
        workingStatePresent: false,
        memoryContextPresent: true,
        contextChangeCount: 0,
        mentionInjectionCount: 1,
        hookContext: "after_system",
        summaryPrefix: "conversation_summary",
        toolChoice: "any",
        promptCacheKeyPresent: true,
      },
    })
    expect(decodeSessionEvent(requestRaw)).toEqual({
      eventId: "e-llm-1",
      seq: 5,
      revision: 7,
      emittedAt: "2026-05-27T00:00:01.000Z",
      causedByCommandId: "c-llm",
      type: "turn.llm.request",
      model: "gpt-5",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      authMode: "OpenAI BYOK",
      policy: {
        mode: "review",
        baseSystem: "default",
        systemLayout: "single_block",
        repoRulesPresent: true,
        sessionCtxPresent: false,
        userAppendPresent: false,
        selectedGlobRuleNames: ["react.mdc"],
        activeSkillNames: ["rr"],
        workingStatePresent: false,
        memoryContextPresent: true,
        contextChangeCount: 0,
        mentionInjectionCount: 1,
        hookContext: "after_system",
        summaryPrefix: "conversation_summary",
        toolChoice: "any",
        promptCacheKeyPresent: true,
      },
    })

    const continuationRaw = encodeSessionEvent({
      eventId: "e-llm-2",
      seq: 6,
      revision: 8,
      emittedAt: "2026-05-27T00:00:02.000Z",
      causedByCommandId: "c-llm",
      type: "turn.llm.continuation",
      provider: "chatgpt-oauth",
      surfaceId: "openai-responses",
      transportId: "chatgpt-oauth",
      phase: "retry",
      mode: "full_retry",
      reason: "resume_rejected",
      statusCode: 400,
    })
    expect(decodeSessionEvent(continuationRaw)).toEqual({
      eventId: "e-llm-2",
      seq: 6,
      revision: 8,
      emittedAt: "2026-05-27T00:00:02.000Z",
      causedByCommandId: "c-llm",
      type: "turn.llm.continuation",
      provider: "chatgpt-oauth",
      surfaceId: "openai-responses",
      transportId: "chatgpt-oauth",
      phase: "retry",
      mode: "full_retry",
      reason: "resume_rejected",
      statusCode: 400,
    })
  })

  test("round-trips turn.started image attachments", () => {
    const raw = encodeSessionEvent({
      eventId: "e2",
      seq: 3,
      revision: 5,
      emittedAt: "2026-05-26T00:00:02.000Z",
      causedByCommandId: "c2",
      type: "turn.started",
      prompt: "",
      images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
    })
    expect(decodeSessionEvent(raw)).toEqual({
      eventId: "e2",
      seq: 3,
      revision: 5,
      emittedAt: "2026-05-26T00:00:02.000Z",
      causedByCommandId: "c2",
      type: "turn.started",
      prompt: "",
      images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
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

  const validSnapshot = (): SessionSnapshotLite =>
    makeSnapshotLite({
      sessionId: "s1",
      revision: 4,
      seq: 2,
      capabilities: { tools: true, memory: true, artifacts: true },
    })

  test("round-trips snapshots with nullable pendingApproval", () => {
    const raw = encodeSessionSnapshot(validSnapshot())
    expect(decodeSessionSnapshot(raw)).toEqual(validSnapshot())
  })

  // HELLGATE H8: decodeSessionSnapshot must route revision/seq through the same
  // assertFiniteNumber as the event path AND guard every required field. The
  // pre-fix bare `typeof === "number"` test let NaN/Infinity through, and
  // state/capabilities/pendingApproval/openArtifacts were unchecked entirely.
  const corruptSnapshot = (mutate: (s: Record<string, unknown>) => void): string => {
    const payload: Record<string, unknown> = { ...validSnapshot() }
    mutate(payload)
    return JSON.stringify({
      version: SESSION_PROTOCOL_VERSION,
      kind: "snapshot",
      payload,
    })
  }

  test("rejects snapshot with non-finite (Infinity) revision/seq over the wire", () => {
    // `1e999` is VALID JSON and JSON.parse yields Infinity, so this is a real
    // reachable path through the public decoder. The pre-fix bare
    // `typeof === "number"` test accepted it (Infinity is a number), wedging
    // revision_conflict downstream. assertFiniteNumber now rejects it.
    const infRevision = corruptSnapshot((s) => {
      s.revision = 0
    }).replace('"revision":0', '"revision":1e999')
    expect(JSON.parse(infRevision).payload.revision).toBe(Number.POSITIVE_INFINITY)
    expect(() => decodeSessionSnapshot(infRevision)).toThrow(SessionProtocolValidationError)

    const infSeq = corruptSnapshot((s) => {
      s.seq = 0
    }).replace('"seq":0', '"seq":1e999')
    expect(() => decodeSessionSnapshot(infSeq)).toThrow(SessionProtocolValidationError)
  })

  test("rejects snapshot missing required object fields", () => {
    for (const key of ["state", "capabilities", "pendingApproval", "openArtifacts"]) {
      const raw = corruptSnapshot((s) => {
        delete s[key]
      })
      expect(() => decodeSessionSnapshot(raw)).toThrow(SessionProtocolValidationError)
    }
  })

  test("rejects snapshot with mistyped required fields", () => {
    expect(() => decodeSessionSnapshot(corruptSnapshot((s) => (s.state = "running")))).toThrow(
      SessionProtocolValidationError,
    )
    expect(() => decodeSessionSnapshot(corruptSnapshot((s) => (s.capabilities = [])))).toThrow(
      SessionProtocolValidationError,
    )
    // openArtifacts must be an array, not an object.
    expect(() => decodeSessionSnapshot(corruptSnapshot((s) => (s.openArtifacts = {})))).toThrow(
      SessionProtocolValidationError,
    )
    // pendingApproval scalar is rejected, but null stays accepted (no over-correction).
    expect(() =>
      decodeSessionSnapshot(corruptSnapshot((s) => (s.pendingApproval = "pending"))),
    ).toThrow(SessionProtocolValidationError)
  })

  test("does NOT over-correct: null pendingApproval is accepted", () => {
    const raw = corruptSnapshot((s) => {
      s.pendingApproval = null
    })
    expect(() => decodeSessionSnapshot(raw)).not.toThrow()
  })
})

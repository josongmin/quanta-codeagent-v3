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
})

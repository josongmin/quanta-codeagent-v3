import { describe, expect, test } from "bun:test"
import { replaySnapshotLite } from "@/kernel/session"
import { SessionProtocolValidationError, type SessionSnapshotLite } from "@/protocol/session"

const makeSnapshot = (): SessionSnapshotLite => ({
  sessionId: "s1",
  revision: 4,
  seq: 10,
  state: {
    status: "idle",
    draftInput: "",
    permissionMode: "default",
    messageCount: 2,
    lastUserText: "ping",
    lastAssistantText: "pong",
  },
  capabilities: {
    approvals: "none",
    tools: false,
    memory: false,
    artifacts: true,
    subagents: false,
    automation: false,
    shellSnapshot: false,
    serverAutoContinues: false,
    transport: "inproc",
  },
  pendingApproval: null,
  openArtifacts: [
    {
      artifactId: "a1",
      kind: "text",
      mimeType: "text/plain",
      locator: "artifact://a1",
      createdAt: "2026-05-26T00:00:00.000Z",
    },
  ],
})

describe("kernel replay-lite", () => {
  test("clones snapshot and retains only post-snapshot tail events", () => {
    const snapshot: SessionSnapshotLite = {
      ...makeSnapshot(),
      state: {
        ...makeSnapshot().state,
        lastLlmRequest: {
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
        },
        lastLlmContinuation: {
          provider: "openai",
          surfaceId: "openai-responses",
          transportId: "public",
          phase: "prepare",
          mode: "resume",
          reason: "prepared_resume",
        },
      },
    }
    const tail = [
      {
        eventId: "e10",
        seq: 10,
        revision: 4,
        emittedAt: "2026-05-26T00:00:10.000Z",
        type: "session.state.updated" as const,
        state: snapshot.state,
      },
      {
        eventId: "e11",
        seq: 11,
        revision: 4,
        emittedAt: "2026-05-26T00:00:11.000Z",
        type: "turn.completed" as const,
        outcomeReason: "completed" as const,
      },
      {
        eventId: "e12",
        seq: 12,
        revision: 5,
        emittedAt: "2026-05-26T00:00:12.000Z",
        type: "session.state.updated" as const,
        state: {
          ...snapshot.state,
          status: "failed" as const,
          lastOutcomeReason: "error" as const,
        },
      },
    ]

    const replay = replaySnapshotLite(snapshot, tail)

    expect(replay.snapshot).toEqual(snapshot)
    expect(replay.snapshot).not.toBe(snapshot)
    expect(replay.snapshot.state).not.toBe(snapshot.state)
    expect(replay.snapshot.state.lastLlmRequest).not.toBe(snapshot.state.lastLlmRequest)
    expect(replay.snapshot.state.lastLlmRequest?.policy).not.toBe(
      snapshot.state.lastLlmRequest?.policy,
    )
    expect(replay.snapshot.state.lastLlmContinuation).not.toBe(snapshot.state.lastLlmContinuation)
    expect(replay.snapshot.openArtifacts).not.toBe(snapshot.openArtifacts)
    expect(replay.tail.map((event) => event.seq)).toEqual([11, 12])

    ;(replay.snapshot.state as { status: string }).status = "closed"
    expect(snapshot.state.status).toBe("idle")
  })

  test("fails closed when retained tail is out of order", () => {
    const snapshot = makeSnapshot()
    expect(() =>
      replaySnapshotLite(snapshot, [
        {
          eventId: "e12",
          seq: 12,
          revision: 4,
          emittedAt: "2026-05-26T00:00:12.000Z",
          type: "turn.completed",
          outcomeReason: "completed",
        },
        {
          eventId: "e11",
          seq: 11,
          revision: 4,
          emittedAt: "2026-05-26T00:00:11.000Z",
          type: "turn.failed",
          message: "out-of-order",
        },
      ]),
    ).toThrow(
      new SessionProtocolValidationError(
        "replay_tail_out_of_order",
        "replay tail must be strictly increasing after seq 12; got 11",
      ),
    )
  })

  test("fails closed when retained tail regresses below snapshot revision", () => {
    const snapshot = makeSnapshot()
    expect(() =>
      replaySnapshotLite(snapshot, [
        {
          eventId: "e11",
          seq: 11,
          revision: 3,
          emittedAt: "2026-05-26T00:00:11.000Z",
          type: "turn.failed",
          message: "revision-regressed",
        },
      ]),
    ).toThrow(
      new SessionProtocolValidationError(
        "replay_tail_revision_regression",
        "replay tail revision 3 regressed below snapshot revision 4",
      ),
    )
  })
})

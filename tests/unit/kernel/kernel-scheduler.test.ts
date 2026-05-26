import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
} from "@/kernel/session"
import type { Message } from "@/llm"

const manifest = {
  approvals: "operator" as const,
  tools: true,
  memory: false,
  artifacts: true,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  transport: "inproc" as const,
}

const makeOutcome = (reason: AgentOutcome["reason"]) =>
  ({
    reason,
    turns: 1,
    messages: [
      { role: "user", content: [{ type: "text", text: "ping" }] },
      { role: "assistant", content: [{ type: "text", text: "awaiting approval" }] },
    ],
  }) as AgentOutcome

const makeClock = (...timestamps: string[]) => {
  const queue = [...timestamps]
  const last = queue.at(-1) ?? "2026-05-26T00:00:00.000Z"
  return {
    now: () => new Date(queue.shift() ?? last),
  }
}

const messagesOf = (userText: string, assistantText?: string): readonly Message[] =>
  assistantText === undefined
    ? [{ role: "user", content: [{ type: "text", text: userText }] }]
    : [
        { role: "user", content: [{ type: "text", text: userText }] },
        { role: "assistant", content: [{ type: "text", text: assistantText }] },
      ]

describe("kernel scheduler approval flow", () => {
  test("emits ordered approval protocol events from kernel-owned state", async () => {
    let state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const resolvedApprovals: Array<{ approvalId: string; decision: "approve" | "deny" }> = []
    const approval = {
      approvalId: "ap1",
      reason: "tool.exec",
      requestedAt: "2026-05-26T00:00:02.000Z",
    }
    const host = {
      describe: () => ({
        sessionId: "s1",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async () => ({
        outcome: makeOutcome("completed"),
        messages: makeOutcome("completed").messages,
        approvalRequest: approval,
      }),
      resolveApproval: ({
        approvalId,
        decision,
      }: {
        approvalId: string
        decision: "approve" | "deny"
      }) => {
        resolvedApprovals.push({ approvalId, decision })
      },
      close: async () => undefined,
    }
    const eventLog = new InMemorySessionEventLog()

    state = (
      await dispatchSessionCommand(
        state,
        {
          sessionId: "s1",
          commandId: "c1",
          issuedAt: "2026-05-26T00:00:00.000Z",
          type: "input.append",
          text: "ping",
        },
        {
          clock: makeClock("2026-05-26T00:00:00.000Z"),
          eventLog,
          host,
        },
      )
    ).state

    const turn = await dispatchSessionCommand(
      state,
      {
        sessionId: "s1",
        commandId: "c2",
        issuedAt: "2026-05-26T00:00:01.000Z",
        expectedRevision: state.revision,
        type: "turn.run",
      },
      {
        clock: makeClock(
          "2026-05-26T00:00:01.000Z",
          "2026-05-26T00:00:02.000Z",
          "2026-05-26T00:00:03.000Z",
        ),
        eventLog,
        host,
      },
    )

    expect(turn.events.map((event) => event.type)).toEqual([
      "turn.started",
      "session.state.updated",
      "approval.requested",
      "session.state.updated",
    ])
    expect(turn.events.map((event) => event.emittedAt)).toEqual([
      "2026-05-26T00:00:01.000Z",
      "2026-05-26T00:00:01.000Z",
      "2026-05-26T00:00:02.000Z",
      "2026-05-26T00:00:03.000Z",
    ])
    expect(turn.state.status).toBe("awaiting_approval")
    expect(turn.state.pendingApproval).toEqual(approval)

    const resolved = await dispatchSessionCommand(
      turn.state,
      {
        sessionId: "s1",
        commandId: "c3",
        issuedAt: "2026-05-26T00:00:04.000Z",
        expectedRevision: turn.state.revision,
        type: "approval.respond",
        approvalId: approval.approvalId,
        decision: "approve",
      },
      {
        clock: makeClock("2026-05-26T00:00:04.000Z"),
        eventLog,
        host,
      },
    )

    expect(resolved.events.map((event) => event.type)).toEqual([
      "approval.resolved",
      "session.state.updated",
    ])
    expect(resolved.state.status).toBe("idle")
    expect(resolved.state.pendingApproval).toBeNull()
    expect(resolvedApprovals).toEqual([{ approvalId: approval.approvalId, decision: "approve" }])
  })

  test("deny clears the pending draft so the next prompt starts clean", async () => {
    let state = createKernelSessionState({
      sessionId: "s2",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const approval = {
      approvalId: "ap2",
      reason: "edit.needs_approval",
      requestedAt: "2026-05-26T00:00:12.000Z",
    }
    const host = {
      describe: () => ({
        sessionId: "s2",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async () => ({
        outcome: makeOutcome("completed"),
        messages: makeOutcome("completed").messages,
        approvalRequest: approval,
      }),
      close: async () => undefined,
    }
    const eventLog = new InMemorySessionEventLog()

    state = (
      await dispatchSessionCommand(
        state,
        {
          sessionId: "s2",
          commandId: "c1",
          issuedAt: "2026-05-26T00:00:10.000Z",
          type: "input.append",
          text: "edit file",
          images: [{ type: "image", data: "", mediaType: "image/png" }],
        },
        {
          clock: makeClock("2026-05-26T00:00:10.000Z"),
          eventLog,
          host,
        },
      )
    ).state

    const awaiting = await dispatchSessionCommand(
      state,
      {
        sessionId: "s2",
        commandId: "c2",
        issuedAt: "2026-05-26T00:00:11.000Z",
        expectedRevision: state.revision,
        type: "turn.run",
      },
      {
        clock: makeClock(
          "2026-05-26T00:00:11.000Z",
          "2026-05-26T00:00:12.000Z",
          "2026-05-26T00:00:13.000Z",
        ),
        eventLog,
        host,
      },
    )

    const denied = await dispatchSessionCommand(
      awaiting.state,
      {
        sessionId: "s2",
        commandId: "c3",
        issuedAt: "2026-05-26T00:00:14.000Z",
        expectedRevision: awaiting.state.revision,
        type: "approval.respond",
        approvalId: approval.approvalId,
        decision: "deny",
      },
      {
        clock: makeClock("2026-05-26T00:00:14.000Z"),
        eventLog,
        host,
      },
    )

    expect(denied.state.status).toBe("idle")
    expect(denied.state.pendingApproval).toBeNull()
    expect(denied.state.draftInput).toBe("")
    expect(denied.state.draftImages).toEqual([])
  })

  test("emits turn.output.delta events and clears streamingAssistantText on completion", async () => {
    let state = createKernelSessionState({
      sessionId: "s3",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const committed: Array<{ types: string[]; streamingAssistantText?: string }> = []
    const host = {
      describe: () => ({
        sessionId: "s3",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({
        onEvent,
      }: {
        onEvent?: (event: { type: "assistant_text.delta"; delta: string }) => void
      }) => {
        onEvent?.({ type: "assistant_text.delta", delta: "po" })
        onEvent?.({ type: "assistant_text.delta", delta: "ng" })
        const messages = messagesOf("ping", "pong")
        return {
          outcome: {
            reason: "completed",
            turns: 1,
            messages,
          } as AgentOutcome,
          messages,
        }
      },
      close: async () => undefined,
    }
    const eventLog = new InMemorySessionEventLog()

    state = (
      await dispatchSessionCommand(
        state,
        {
          sessionId: "s3",
          commandId: "c1",
          issuedAt: "2026-05-26T00:01:00.000Z",
          type: "input.append",
          text: "ping",
        },
        {
          clock: makeClock("2026-05-26T00:01:00.000Z"),
          eventLog,
          host,
        },
      )
    ).state

    const turn = await dispatchSessionCommand(
      state,
      {
        sessionId: "s3",
        commandId: "c2",
        issuedAt: "2026-05-26T00:01:01.000Z",
        expectedRevision: state.revision,
        type: "turn.run",
      },
      {
        clock: makeClock(
          "2026-05-26T00:01:01.000Z",
          "2026-05-26T00:01:02.000Z",
          "2026-05-26T00:01:03.000Z",
          "2026-05-26T00:01:04.000Z",
        ),
        eventLog,
        host,
        onCommitted: ({ state: committedState, events }) => {
          committed.push({
            types: events.map((event) => event.type),
            ...(committedState.transcript.streamingAssistantText !== undefined
              ? { streamingAssistantText: committedState.transcript.streamingAssistantText }
              : {}),
          })
        },
      },
    )

    expect(turn.events.map((event) => event.type)).toEqual([
      "turn.started",
      "session.state.updated",
      "turn.output.delta",
      "turn.output.delta",
      "turn.completed",
      "session.state.updated",
    ])
    expect(committed).toEqual([
      { types: ["turn.started", "session.state.updated"] },
      { types: ["turn.output.delta"], streamingAssistantText: "po" },
      { types: ["turn.output.delta"], streamingAssistantText: "pong" },
    ])
    expect(turn.state.status).toBe("idle")
    expect(turn.state.transcript.lastAssistantText).toBe("pong")
    expect(turn.state.transcript.streamingAssistantText).toBeUndefined()
  })

  test("maps logical error outcomes to turn.failed with the detailed error message", async () => {
    let state = createKernelSessionState({
      sessionId: "s4",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const host = {
      describe: () => ({
        sessionId: "s4",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async () => ({
        messages: messagesOf("ping"),
        outcome: {
          reason: "error",
          turns: 1,
          messages: messagesOf("ping"),
        } as AgentOutcome,
        errorMessage: "model stream aborted",
      }),
      close: async () => undefined,
    }
    const eventLog = new InMemorySessionEventLog()

    state = (
      await dispatchSessionCommand(
        state,
        {
          sessionId: "s4",
          commandId: "c1",
          issuedAt: "2026-05-26T00:02:00.000Z",
          type: "input.append",
          text: "ping",
        },
        {
          clock: makeClock("2026-05-26T00:02:00.000Z"),
          eventLog,
          host,
        },
      )
    ).state

    const turn = await dispatchSessionCommand(
      state,
      {
        sessionId: "s4",
        commandId: "c2",
        issuedAt: "2026-05-26T00:02:01.000Z",
        expectedRevision: state.revision,
        type: "turn.run",
      },
      {
        clock: makeClock(
          "2026-05-26T00:02:01.000Z",
          "2026-05-26T00:02:02.000Z",
          "2026-05-26T00:02:03.000Z",
        ),
        eventLog,
        host,
      },
    )

    expect(turn.events.map((event) => event.type)).toEqual([
      "turn.started",
      "session.state.updated",
      "turn.failed",
      "session.state.updated",
    ])
    const failed = turn.events.find((event) => event.type === "turn.failed")
    expect(failed?.type).toBe("turn.failed")
    if (failed?.type !== "turn.failed") throw new Error("type narrow")
    expect(failed.message).toBe("model stream aborted")
    expect(turn.state.status).toBe("failed")
    expect(turn.state.lastOutcomeReason).toBe("error")
  })
})

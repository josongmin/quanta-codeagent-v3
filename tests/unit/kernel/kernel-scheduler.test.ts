import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
} from "@/kernel/session"

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

describe("kernel scheduler approval flow", () => {
  test("emits ordered approval protocol events from kernel-owned state", async () => {
    let state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
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
  })
})

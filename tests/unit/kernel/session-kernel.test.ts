import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
  systemClock,
} from "@/kernel/session"
import { SessionRevisionConflictError } from "@/protocol/session"

const makeOutcome = (reason: AgentOutcome["reason"]) =>
  ({
    reason,
    turns: 1,
    messages: [
      { role: "user", content: [{ type: "text", text: "ping" }] },
      { role: "assistant", content: [{ type: "text", text: "pong" }] },
    ],
  }) as AgentOutcome

describe("@/kernel/session", () => {
  test("runs a turn and updates transcript state", async () => {
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
    let state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: manifest,
      identityMode: "default",
      toolProfile: "write",
    })
    const eventLog = new InMemorySessionEventLog()
    const host = {
      describe: () => ({
        sessionId: "s1",
        permissionMode: "default",
        capabilityManifest: manifest,
      }),
      runTurn: async ({
        prompt,
        images,
      }: {
        prompt: string
        images?: ReadonlyArray<{ type: "image"; data: string; mediaType: string }>
      }) => {
        expect(prompt).toBe("ping")
        expect(images).toEqual([{ type: "image", data: "Zm9v", mediaType: "image/png" }])
        return { outcome: makeOutcome("completed"), messages: makeOutcome("completed").messages }
      },
      close: async () => undefined,
    }

    state = (
      await dispatchSessionCommand(
        state,
        {
          sessionId: "s1",
          commandId: "c1",
          issuedAt: "2026-05-26T00:00:00.000Z",
          type: "input.append",
          text: "ping",
          images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
        },
        { clock: systemClock, eventLog, host },
      )
    ).state

    const result = await dispatchSessionCommand(
      state,
      {
        sessionId: "s1",
        commandId: "c2",
        issuedAt: "2026-05-26T00:00:01.000Z",
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock: systemClock, eventLog, host },
    )

    expect(result.state.status).toBe("idle")
    expect(result.state.draftInput).toBe("")
    expect(result.state.draftImages).toEqual([])
    expect(result.state.transcript.lastAssistantText).toBe("pong")
    expect(result.events.map((event) => event.type)).toContain("turn.completed")
  })

  test("rejects stale revisions", async () => {
    const state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: {
        approvals: "none",
        tools: false,
        memory: false,
        artifacts: false,
        subagents: false,
        automation: false,
        shellSnapshot: false,
        transport: "inproc",
      },
    })
    await expect(
      dispatchSessionCommand(
        state,
        {
          sessionId: "s1",
          commandId: "c1",
          issuedAt: "2026-05-26T00:00:00.000Z",
          expectedRevision: 99,
          type: "turn.run",
        },
        {
          clock: systemClock,
          eventLog: new InMemorySessionEventLog(),
          host: {
            describe: () => ({
              sessionId: "s1",
              permissionMode: "default",
              capabilityManifest: state.capabilityManifest,
            }),
            runTurn: async () => ({ outcome: makeOutcome("completed"), messages: [] }),
            close: async () => undefined,
          },
        },
      ),
    ).rejects.toThrow(SessionRevisionConflictError)
  })
})

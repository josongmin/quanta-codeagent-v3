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
        history,
        prompt,
        images,
      }: {
        history: ReadonlyArray<unknown>
        prompt: string
        images?: ReadonlyArray<{ type: "image"; data: string; mediaType: string }>
      }) => {
        expect(history).toEqual([])
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
    expect(result.turnResult?.outcome.reason).toBe("completed")
    expect(result.transcriptMessages).toEqual(makeOutcome("completed").messages)
    expect(result.events.map((event) => event.type)).toContain("turn.completed")
    const completed = result.events.find((event) => event.type === "turn.completed")
    expect(completed).toMatchObject({
      type: "turn.completed",
      outcomeReason: "completed",
      assistantText: "pong",
    })
    const started = result.events.find((event) => event.type === "turn.started")
    expect(started).toMatchObject({
      type: "turn.started",
      prompt: "ping",
      images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
    })
  })

  test("allows image-only turns", async () => {
    const manifest = {
      approvals: "none" as const,
      tools: true,
      memory: false,
      artifacts: false,
      subagents: false,
      automation: false,
      shellSnapshot: false,
      transport: "inproc" as const,
    }
    let state = createKernelSessionState({
      sessionId: "image-only",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const eventLog = new InMemorySessionEventLog()
    const host = {
      describe: () => ({
        sessionId: "image-only",
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
        expect(prompt).toBe("")
        expect(images).toEqual([{ type: "image", data: "Zm9v", mediaType: "image/png" }])
        return { outcome: makeOutcome("completed"), messages: makeOutcome("completed").messages }
      },
      close: async () => undefined,
    }

    state = (
      await dispatchSessionCommand(
        state,
        {
          sessionId: "image-only",
          commandId: "img-append",
          issuedAt: "2026-05-26T00:00:10.000Z",
          type: "input.append",
          text: "",
          images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
        },
        { clock: systemClock, eventLog, host },
      )
    ).state

    const result = await dispatchSessionCommand(
      state,
      {
        sessionId: "image-only",
        commandId: "img-run",
        issuedAt: "2026-05-26T00:00:11.000Z",
        expectedRevision: state.revision,
        type: "turn.run",
      },
      { clock: systemClock, eventLog, host },
    )

    expect(result.turnResult?.outcome.reason).toBe("completed")
    expect(result.events.find((event) => event.type === "turn.started")).toMatchObject({
      type: "turn.started",
      prompt: "",
      images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
    })
  })

  test("replaces transcript through the kernel-owned command path", async () => {
    const manifest = {
      approvals: "none" as const,
      tools: false,
      memory: false,
      artifacts: false,
      subagents: false,
      automation: false,
      shellSnapshot: false,
      transport: "inproc" as const,
    }
    const state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const messages = makeOutcome("completed").messages
    const result = await dispatchSessionCommand(
      state,
      {
        sessionId: "s1",
        commandId: "c3",
        issuedAt: "2026-05-26T00:00:02.000Z",
        type: "session.transcript.replace",
        messages,
      },
      {
        clock: systemClock,
        eventLog: new InMemorySessionEventLog(),
        host: {
          describe: () => ({
            sessionId: "s1",
            permissionMode: "default",
            capabilityManifest: manifest,
          }),
          runTurn: async () => ({ outcome: makeOutcome("completed"), messages: [] }),
          close: async () => undefined,
        },
      },
    )
    expect(result.state.transcript.messageCount).toBe(messages.length)
    expect(result.state.messages).toEqual(messages)
    expect(result.transcriptMessages).toEqual(messages)
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

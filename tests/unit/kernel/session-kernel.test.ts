import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
  systemClock,
} from "@/kernel/session"
import { SessionRevisionConflictError } from "@/protocol/session"
import { capabilitiesFor } from "../../support/session-fixtures"

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
  test("session posture commands reconcile to the host-authoritative state on ignored invalid values", async () => {
    const manifest = capabilitiesFor()
    let permissionMode = "default"
    let identityMode = "default"
    let toolProfile = "write"
    const host = {
      describe: () => ({
        sessionId: "s-posture",
        permissionMode,
        capabilityManifest: manifest,
        identityMode,
        toolProfile,
      }),
      setIdentityMode: async (mode: string) => {
        if (mode === "default" || mode === "plan" || mode === "review" || mode === "onboarding") {
          identityMode = mode
        }
      },
      setToolProfile: async (profile: string) => {
        if (profile === "write" || profile === "ask" || profile === "chat" || profile === "read") {
          toolProfile = profile
        }
      },
      setPermissionMode: async (mode: string) => {
        if (mode === "default" || mode === "acceptEdits" || mode === "auto" || mode === "bypass") {
          permissionMode = mode
        }
      },
      runTurn: async () => ({ outcome: makeOutcome("completed"), messages: [] }),
      close: async () => undefined,
    }
    let state = createKernelSessionState({
      sessionId: "s-posture",
      permissionMode,
      capabilityManifest: manifest,
      identityMode,
      toolProfile,
    })
    const eventLog = new InMemorySessionEventLog()

    const invalidIdentity = await dispatchSessionCommand(
      state,
      {
        sessionId: "s-posture",
        commandId: "c-id-bad",
        issuedAt: "2026-05-26T00:00:00.000Z",
        type: "session.identity.set",
        mode: "bogus-mode",
      },
      { clock: systemClock, eventLog, host },
    )
    expect(invalidIdentity.state.identityMode).toBe("default")
    expect(invalidIdentity.events.at(-1)).toMatchObject({
      type: "session.state.updated",
      state: { identityMode: "default" },
    })
    state = invalidIdentity.state

    const invalidToolProfile = await dispatchSessionCommand(
      state,
      {
        sessionId: "s-posture",
        commandId: "c-tool-bad",
        issuedAt: "2026-05-26T00:00:01.000Z",
        type: "session.tool_profile.set",
        profile: "bogus-profile",
      },
      { clock: systemClock, eventLog, host },
    )
    expect(invalidToolProfile.state.toolProfile).toBe("write")
    expect(invalidToolProfile.events.at(-1)).toMatchObject({
      type: "session.state.updated",
      state: { toolProfile: "write" },
    })
    state = invalidToolProfile.state

    const invalidPermission = await dispatchSessionCommand(
      state,
      {
        sessionId: "s-posture",
        commandId: "c-perm-bad",
        issuedAt: "2026-05-26T00:00:02.000Z",
        type: "session.permission.set",
        mode: "bogus-permission",
      },
      { clock: systemClock, eventLog, host },
    )
    expect(invalidPermission.state.permissionMode).toBe("default")
    expect(invalidPermission.events.at(-1)).toMatchObject({
      type: "session.state.updated",
      state: { permissionMode: "default" },
    })
  })

  test("runs a turn and updates transcript state", async () => {
    const manifest = capabilitiesFor({ approvals: "operator", tools: true, artifacts: true })
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
    const manifest = capabilitiesFor({ tools: true })
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
    const manifest = capabilitiesFor()
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
      capabilityManifest: capabilitiesFor(),
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

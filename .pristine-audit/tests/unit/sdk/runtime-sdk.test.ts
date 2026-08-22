import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import { createRuntime } from "@/sdk/runtime"
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

describe("@/sdk/runtime", () => {
  test("dispatches commands, emits events, and snapshots live state", async () => {
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => ({
        describe: () => ({
          sessionId: "sdk-session",
          permissionMode: "default",
          capabilityManifest: capabilitiesFor(),
          identityMode: "default",
          toolProfile: "write",
        }),
        runTurn: async ({ history, prompt }: { history: readonly unknown[]; prompt: string }) => {
          expect(history).toEqual([])
          expect(prompt).toBe("ping")
          return { outcome: makeOutcome("completed"), messages: makeOutcome("completed").messages }
        },
        close: async () => undefined,
      })),
    })

    const session = await runtime.createSession({
      cwd: "/tmp",
      permissionMode: "default",
      identityMode: "default",
      toolProfile: "write",
    })

    const seen: string[] = []
    const off = session.subscribe((event) => {
      seen.push(event.type)
    })

    await session.input.append("ping")
    const turn = await session.turn.run()
    const snapshot = await session.snapshot()

    expect(turn.turn?.outcome.reason).toBe("completed")
    expect(turn.turn?.messages).toEqual(makeOutcome("completed").messages)
    expect(snapshot.state.lastAssistantText).toBe("pong")
    expect(seen).toContain("turn.started")
    expect(seen).toContain("turn.completed")

    off()
    await session.close()
    await runtime.close()
  })

  test("transcript replace returns the restored messages through the runtime surface", async () => {
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => ({
        describe: () => ({
          sessionId: "sdk-session",
          permissionMode: "default",
          capabilityManifest: capabilitiesFor(),
        }),
        runTurn: async () => ({ outcome: makeOutcome("completed"), messages: [] }),
        close: async () => undefined,
      })),
    })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })
    const messages = makeOutcome("completed").messages
    const result = await session.transcript.replace(messages)
    expect(result.transcript?.messages).toEqual(messages)
    expect((await session.snapshot()).state.messageCount).toBe(messages.length)
    // P1 Phase 0 (jul-11) — the symmetric READ getter returns the live
    // Message[] losslessly (no 256-char preview truncation the SessionEvent
    // archive suffers), so a surface can persist a lossless transcript for a
    // later live swap. Empty before any replace/turn; reflects the replace.
    expect(session.transcript.messages()).toEqual(messages)
    await session.close()
    await runtime.close()
  })

  test("transcript.messages() reads the live transcript losslessly (P1 Phase 0)", async () => {
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => ({
        describe: () => ({
          sessionId: "sdk-read",
          permissionMode: "default",
          capabilityManifest: capabilitiesFor(),
        }),
        runTurn: async () => ({ outcome: makeOutcome("completed"), messages: [] }),
        close: async () => undefined,
      })),
    })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })
    expect(session.transcript.messages()).toEqual([]) // empty before any turn
    const messages = makeOutcome("completed").messages
    await session.transcript.replace(messages)
    expect(session.transcript.messages()).toEqual(messages)
    await session.close()
    await runtime.close()
  })

  test("publishes turn.started and running state before the host turn resolves", async () => {
    let releaseHostTurn = (): void => undefined
    const hostTurnGate = new Promise<void>((resolve) => {
      releaseHostTurn = resolve
    })
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => ({
        describe: () => ({
          sessionId: "sdk-session",
          permissionMode: "default",
          capabilityManifest: capabilitiesFor(),
        }),
        runTurn: async () => {
          await hostTurnGate
          return { outcome: makeOutcome("completed"), messages: makeOutcome("completed").messages }
        },
        close: async () => undefined,
      })),
    })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })

    await session.input.append("ping")

    let sawTurnStarted = false
    let sawRunningUpdate = false
    let resolveStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const off = session.subscribe((event) => {
      if (event.type === "turn.started") {
        sawTurnStarted = true
        resolveStarted()
      }
      if (event.type === "session.state.updated" && event.state.status === "running") {
        sawRunningUpdate = true
      }
    })

    const turnPromise = session.turn.run()
    await started

    expect(sawTurnStarted).toBe(true)
    expect(sawRunningUpdate).toBe(true)
    expect((await session.snapshot()).state.status).toBe("running")

    releaseHostTurn()
    const turn = await turnPromise
    expect(turn.turn?.outcome.reason).toBe("completed")

    off()
    await session.close()
    await runtime.close()
  })

  test("side conversation proxies through the runtime session seam", async () => {
    let seenQuestion = ""
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => ({
        describe: () => ({
          sessionId: "sdk-session",
          permissionMode: "default",
          capabilityManifest: capabilitiesFor(),
        }),
        runTurn: async () => ({ outcome: makeOutcome("completed"), messages: [] }),
        startSideConversation: async ({ question }) => {
          seenQuestion = question
          return {
            outcome: makeOutcome("completed"),
            answerText: "side-answer",
            inputTokens: 1,
            outputTokens: 2,
            toolsAvailable: 3,
          }
        },
        close: async () => undefined,
      })),
    })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })
    const result = await session.side.start({
      question: "where is the test command?",
      signal: new AbortController().signal,
    })
    expect(seenQuestion).toBe("where is the test command?")
    expect(result.answerText).toBe("side-answer")
    expect(result.toolsAvailable).toBe(3)
    await session.close()
    await runtime.close()
  })
})

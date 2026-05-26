import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import { createRuntime } from "@/sdk/runtime"

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

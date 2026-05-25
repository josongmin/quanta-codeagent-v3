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
        runTurn: async ({ prompt }: { prompt: string }) => {
          expect(prompt).toBe("ping")
          return { outcome: makeOutcome("completed"), messages: makeOutcome("completed").messages }
        },
        peekMessages: () => makeOutcome("completed").messages,
        peekLastOutcome: () => makeOutcome("completed"),
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
    await session.turn.run()
    const snapshot = await session.snapshot()

    expect(snapshot.state.lastAssistantText).toBe("pong")
    expect(seen).toContain("turn.started")
    expect(seen).toContain("turn.completed")

    off()
    await session.close()
    await runtime.close()
  })
})

import { describe, expect, test } from "bun:test"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { Message } from "@/llm"
import { TurnWakeRegistry } from "@/subagent"
import type { SubagentRequest } from "@/subagent/types"
import { ToolRegistry } from "@/tool"

const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert stream stub
    llm: { model: "parent", stream: async function* () {} } as any,
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "SYSTEM",
    cwd: "/repo",
    maxTurns: 8,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const outcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] satisfies Message[],
})

const req = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do the thing",
  depth: 1,
  ...over,
})

describe("subagent runner control-plane wiring", () => {
  test("shared mailbox across cloned parents mints globally unique child labels", async () => {
    const mailbox = createSubagentMailbox({
      now: (() => {
        let t = 1000
        return () => ++t
      })(),
    })
    const seen: string[] = []
    const run = async (c: AgentConfig): Promise<AgentOutcome> => {
      seen.push(c.mailboxAgentId ?? "")
      return outcome()
    }

    const base = parentConfig({ subagentMailbox: mailbox })
    const clone = { ...base, stream: { emit: () => {} } } as AgentConfig

    await createSubagentRunner(base, { run })(req({ taskId: "task-a" }))
    await createSubagentRunner(clone, { run })(req({ taskId: "task-b" }))

    expect(seen).toEqual(["root/0", "root/1"])
  })

  test("shared turn-wake registry keeps taskId -> mailbox bindings unique across runner instances", async () => {
    const wake = new TurnWakeRegistry()
    const liveBindings: string[] = []
    const run = async (c: AgentConfig): Promise<AgentOutcome> => {
      liveBindings.push(wake.labelOf(c.subagentTaskId ?? "") ?? "")
      return outcome()
    }

    const base = parentConfig({ subagentTurnWake: wake })
    const clone = { ...base, stream: { emit: () => {} } } as AgentConfig

    await createSubagentRunner(base, { run })(req({ taskId: "task-a" }))
    await createSubagentRunner(clone, { run })(req({ taskId: "task-b" }))

    expect(liveBindings).toEqual(["root/0", "root/1"])
    expect(wake.labelOf("task-a")).toBeUndefined()
    expect(wake.labelOf("task-b")).toBeUndefined()
  })

  test("workspace override drives the child cwd", async () => {
    const seen: AgentConfig[] = []
    const run = async (c: AgentConfig): Promise<AgentOutcome> => {
      seen.push(c)
      return outcome()
    }

    await createSubagentRunner(parentConfig({ cwd: "/repo" }), { run })(
      req({ workspace: "/repo/packages/alt" }),
    )

    expect(seen[0]?.cwd).toBe("/repo/packages/alt")
  })
})

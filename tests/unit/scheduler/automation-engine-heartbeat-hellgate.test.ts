import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  type AutomationEnginePort,
  type EngineAutomation,
  inMemoryAutomationEngine,
  type ScheduleInput,
  sqliteAutomationEngine,
  tickScheduler,
} from "@/scheduler/automation-engine"
import { assembleAutomation } from "@/scheduler/runtime-wire"
import type { HeartbeatPolicySnapshot } from "@/scheduler/types"

const POLICY: HeartbeatPolicySnapshot = {
  approvalPolicy: "default",
  sandboxPolicy: "workspace-write",
  collaborationMode: "default",
}

type HeartbeatRow = EngineAutomation & {
  readonly kind: "heartbeat"
  readonly targetThreadId: string
  readonly inheritedPolicy: HeartbeatPolicySnapshot
}

const heartbeatInput = (id: string, targetThreadId = "thread-42"): ScheduleInput =>
  ({
    id,
    title: "continue work",
    rule: { freq: "MINUTELY" },
    prompt: "continue the task",
    nextRunAt: 100,
    createdAt: 0,
    kind: "heartbeat",
    targetThreadId,
    inheritedPolicy: POLICY,
  }) as unknown as ScheduleInput

const assertHeartbeatEngine = async (engine: AutomationEnginePort): Promise<void> => {
  const first = await engine.schedule(heartbeatInput("heartbeat-1"))
  expect(first.ok).toBe(true)
  if (!first.ok) return

  const persisted = first.value as HeartbeatRow
  expect(persisted.kind).toBe("heartbeat")
  expect(persisted.targetThreadId).toBe("thread-42")
  expect(persisted.inheritedPolicy).toEqual(POLICY)

  const second = await engine.schedule(heartbeatInput("heartbeat-2"))
  expect(second.ok).toBe(false)
  if (!second.ok) expect(second.code).toBe("heartbeat-thread-occupied")
}

describe("automation engine heartbeat authority", () => {
  test("in-memory and sqlite engines persist heartbeat metadata and reject a second live thread owner", async () => {
    await assertHeartbeatEngine(inMemoryAutomationEngine())
    await assertHeartbeatEngine(sqliteAutomationEngine(new Database(":memory:")))
  })

  test("the production engine dispatch path forwards heartbeat routing to the agent loop", async () => {
    const engine = inMemoryAutomationEngine()
    const delivered: Array<{ prompt: string; opts: unknown }> = []
    const slot = assembleAutomation(
      { get: (name) => (name === "QUANTA_AUTOMATION" ? "on" : undefined) },
      {
        engine,
        agentLoop: {
          enqueueUserMessage: async (prompt, opts) => {
            delivered.push({ prompt, opts })
          },
        },
      },
    )
    if (slot === null) throw new Error("automation slot was not assembled")
    const scheduled = await engine.schedule(heartbeatInput("heartbeat-dispatch"))
    expect(scheduled.ok).toBe(true)

    const outcome = await tickScheduler({ engine, now: 100, handler: slot.handler })
    expect(outcome.kind).toBe("fired")
    expect(delivered).toEqual([
      {
        prompt: "continue the task",
        opts: { targetThreadId: "thread-42", inheritedPolicy: POLICY },
      },
    ])
  })
})

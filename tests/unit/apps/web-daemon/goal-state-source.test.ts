import { describe, expect, test } from "bun:test"
import { attachGoalStateSink, createGoalStateSource } from "@/apps/web-daemon/goal-state-source"
import type { GoalReadoutData } from "@/protocol/readout"

const state = (revision: number): GoalReadoutData => ({
  kind: "goal",
  revision,
  freshness: "fresh",
  validationContract: "manual-only",
  wake: { kind: "armed", delayMs: 15_000, wakeAt: 16_000 },
  latestSettlement: null,
  objective: {
    objectiveId: "objective-1",
    goal: "ship",
    status: "active",
    budget: { turnsUsed: 0, tokensUsed: 0 },
    blockers: [],
    criteria: [],
  },
})

describe("R4 default-ON Goal state source", () => {
  test("emits only changed canonical state and replays latest to reconnect", async () => {
    let current = state(1)
    let now = 10
    const source = createGoalStateSource({ read: async () => current, now: () => now++ })
    const first: number[] = []
    source.subscribe((message) => first.push(message.state.revision))

    expect(await source.refresh()).toBe(true)
    expect(await source.refresh()).toBe(false)
    current = state(2)
    expect(await source.refresh()).toBe(true)
    expect(first).toEqual([1, 2])

    const reconnect: number[] = []
    source.subscribe((message) => reconnect.push(message.state.revision))
    expect(reconnect).toEqual([2])
  })

  test("socket sink sends a typed current snapshot immediately and detaches", async () => {
    const source = createGoalStateSource({ read: async () => state(3), now: () => 50 })
    await source.refresh()
    const frames: string[] = []
    const detach = attachGoalStateSink((frame) => frames.push(frame), source)
    expect(JSON.parse(frames[0] ?? "{}")).toMatchObject({
      version: "goal-state.v1",
      kind: "goalState",
      payload: { kind: "goal.state", emittedAt: 50, state: { revision: 3 } },
    })
    detach?.()
    expect(await source.refresh()).toBe(false)
    expect(frames).toHaveLength(1)
  })
})

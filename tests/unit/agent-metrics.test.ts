import { describe, expect, test } from "bun:test"
import { AgentRecorder, METRIC } from "@/agent"
import { Metrics } from "@/observability"

describe("METRIC name table", () => {
  test("exposes the stable loop metric names", () => {
    expect(METRIC).toEqual({
      turns: "agent.turns",
      toolCalls: "agent.tool_calls",
      llmStream: "agent.llm_stream",
      toolExec: "agent.tool_exec",
      stopReason: "agent.stop_reason",
    })
  })
})

describe("AgentRecorder counters", () => {
  test("turn() increments the turns counter each call", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.turn()
    rec.turn()
    rec.turn()
    expect(m.snapshot().counters[METRIC.turns]).toBe(3)
  })

  test("toolCall() bumps both the global and the per-tool counter", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.toolCall("read")
    rec.toolCall("read")
    rec.toolCall("write")
    const c = m.snapshot().counters
    expect(c[METRIC.toolCalls]).toBe(3)
    expect(c[`${METRIC.toolCalls}.read`]).toBe(2)
    expect(c[`${METRIC.toolCalls}.write`]).toBe(1)
  })

  test("stopReason() records a per-reason counter and not a bare one", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.stopReason("completed")
    rec.stopReason("completed")
    rec.stopReason("aborted")
    const c = m.snapshot().counters
    expect(c[`${METRIC.stopReason}.completed`]).toBe(2)
    expect(c[`${METRIC.stopReason}.aborted`]).toBe(1)
    expect(c[METRIC.stopReason]).toBeUndefined()
  })
})

describe("AgentRecorder timers", () => {
  test("llmStream() start→stop records elapsed ms into the timer", () => {
    let now = 1000
    const m = new Metrics(() => now)
    const rec = new AgentRecorder(m)
    const stop = rec.llmStream()
    now = 1250
    const elapsed = stop()
    expect(elapsed).toBe(250)
    const stats = m.snapshot().timers[METRIC.llmStream]
    expect(stats?.count).toBe(1)
    expect(stats?.max).toBe(250)
  })

  test("toolExec() aggregates multiple spans into one timer distribution", () => {
    let now = 0
    const m = new Metrics(() => now)
    const rec = new AgentRecorder(m)

    const s1 = rec.toolExec()
    now = 10
    s1()

    now = 100
    const s2 = rec.toolExec()
    now = 130
    s2()

    const stats = m.snapshot().timers[METRIC.toolExec]
    expect(stats?.count).toBe(2)
    expect(stats?.min).toBe(10)
    expect(stats?.max).toBe(30)
    expect(stats?.mean).toBe(20)
  })

  test("llmStream and toolExec are independent timers", () => {
    let now = 0
    const m = new Metrics(() => now)
    const rec = new AgentRecorder(m)
    const ls = rec.llmStream()
    now = 5
    ls()
    const timers = m.snapshot().timers
    expect(timers[METRIC.llmStream]?.count).toBe(1)
    expect(timers[METRIC.toolExec]?.count ?? 0).toBe(0)
  })

  test("forwards into the exact Metrics instance it was constructed with", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.turn()
    rec.toolCall("grep")
    rec.stopReason("error")
    // Every recorded metric lands in m's snapshot, nowhere else.
    const snap = m.snapshot()
    expect(snap.counters[METRIC.turns]).toBe(1)
    expect(snap.counters[`${METRIC.toolCalls}.grep`]).toBe(1)
    expect(snap.counters[`${METRIC.stopReason}.error`]).toBe(1)
  })
})

import { describe, expect, test } from "bun:test"
import { AgentRecorder, METRIC } from "@/agent"
import { emptyPersistStats, type PersistStats } from "@/agent/memory-stats"
import { Metrics } from "@/observability"

describe("METRIC name table", () => {
  test("exposes the stable loop metric names", () => {
    expect(METRIC).toEqual({
      turns: "agent.turns",
      toolCalls: "agent.tool_calls",
      llmStream: "agent.llm_stream",
      toolExec: "agent.tool_exec",
      stopReason: "agent.stop_reason",
      recallCalls: "memory.recall.calls",
      recallEntries: "memory.recall.entries",
      recallSemantic: "memory.recall.semantic",
      recallFallback: "memory.recall.fallback",
      persistCalls: "memory.persist.calls",
      distilled: "memory.distilled",
      consolidateInserted: "memory.consolidate.inserted",
      consolidateMerged: "memory.consolidate.merged",
      consolidateSuperseded: "memory.consolidate.superseded",
      consolidateSkipped: "memory.consolidate.skipped",
      evictDecayed: "memory.evict.decayed",
      evictDeleted: "memory.evict.deleted",
      // Canonical OTel GenAI usage keys — see vocabulary.ts.
      tokensInput: "gen_ai.usage.input_tokens",
      tokensOutput: "gen_ai.usage.output_tokens",
      cacheRead: "gen_ai.usage.cache_read_input_tokens",
      // MR-06 — both keys existed in the canonical vocabulary with no live
      // emit site; the recorder now exports them from the priced record.
      cacheWrite: "gen_ai.usage.cache_creation_input_tokens",
      costUsd: "quanta.work.cost_usd",
      // A5 — refused usage records (non-finite / session-mismatch).
      usageRejected: "quanta.usage.rejected",
      // ADR-0452 — session-startup prewarm + TTFM (canonical quanta.startup.*).
      ttfm: "quanta.startup.time_to_first_message_ms",
      prewarmDuration: "quanta.startup.prewarm_duration_ms",
      prewarmOutcome: "quanta.startup.prewarm_outcome",
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

describe("AgentRecorder memory observability", () => {
  test("memoryRecall: semantic hit adds entries/calls/semantic, no fallback", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.memoryRecall({ recalled: 3, embedded: true, fellBack: false })
    const c = m.snapshot().counters
    expect(c[METRIC.recallEntries]).toBe(3)
    expect(c[METRIC.recallCalls]).toBe(1)
    expect(c[METRIC.recallSemantic]).toBe(1)
    expect(c[METRIC.recallFallback] ?? 0).toBe(0)
  })

  test("memoryRecall: empty fallback bumps calls/fallback only", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.memoryRecall({ recalled: 0, embedded: false, fellBack: true })
    const c = m.snapshot().counters
    expect(c[METRIC.recallCalls]).toBe(1)
    expect(c[METRIC.recallFallback]).toBe(1)
    expect(c[METRIC.recallSemantic] ?? 0).toBe(0)
    expect(c[METRIC.recallEntries] ?? 0).toBe(0)
  })

  test("memoryRecall: zero recalled still registers the entries counter at 0", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.memoryRecall({ recalled: 0, embedded: true, fellBack: false })
    const c = m.snapshot().counters
    expect(c[METRIC.recallEntries]).toBe(0)
    expect(c[METRIC.recallCalls]).toBe(1)
    expect(c[METRIC.recallSemantic]).toBe(1)
  })

  test("memoryPersist: fully-populated stats forward each field exactly", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    const s: PersistStats = {
      distilled: 7,
      inserted: 5,
      merged: 3,
      superseded: 2,
      skipped: 4,
      decayed: 6,
      deleted: 1,
    }
    rec.memoryPersist(s)
    const c = m.snapshot().counters
    expect(c[METRIC.persistCalls]).toBe(1)
    expect(c[METRIC.distilled]).toBe(7)
    expect(c[METRIC.consolidateInserted]).toBe(5)
    expect(c[METRIC.consolidateMerged]).toBe(3)
    expect(c[METRIC.consolidateSuperseded]).toBe(2)
    expect(c[METRIC.consolidateSkipped]).toBe(4)
    expect(c[METRIC.evictDecayed]).toBe(6)
    expect(c[METRIC.evictDeleted]).toBe(1)
  })

  test("memoryPersist(emptyPersistStats()) bumps only persist.calls", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    rec.memoryPersist(emptyPersistStats())
    const c = m.snapshot().counters
    expect(c[METRIC.persistCalls]).toBe(1)
    expect(c[METRIC.distilled]).toBe(0)
    expect(c[METRIC.consolidateInserted]).toBe(0)
    expect(c[METRIC.consolidateMerged]).toBe(0)
    expect(c[METRIC.consolidateSuperseded]).toBe(0)
    expect(c[METRIC.consolidateSkipped]).toBe(0)
    expect(c[METRIC.evictDecayed]).toBe(0)
    expect(c[METRIC.evictDeleted]).toBe(0)
    // No spurious recall-side increments.
    expect(c[METRIC.recallCalls] ?? 0).toBe(0)
    expect(c[METRIC.recallEntries] ?? 0).toBe(0)
  })

  test("memory recorders accumulate across repeated calls without throwing", () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    expect(() => {
      rec.memoryRecall({ recalled: 2, embedded: true, fellBack: false })
      rec.memoryRecall({ recalled: 1, embedded: false, fellBack: true })
      rec.memoryPersist({
        distilled: 1,
        inserted: 1,
        merged: 0,
        superseded: 0,
        skipped: 0,
        decayed: 0,
        deleted: 0,
      })
      rec.memoryPersist(emptyPersistStats())
    }).not.toThrow()
    const c = m.snapshot().counters
    expect(c[METRIC.recallCalls]).toBe(2)
    expect(c[METRIC.recallEntries]).toBe(3)
    expect(c[METRIC.recallSemantic]).toBe(1)
    expect(c[METRIC.recallFallback]).toBe(1)
    expect(c[METRIC.persistCalls]).toBe(2)
    expect(c[METRIC.distilled]).toBe(1)
    expect(c[METRIC.consolidateInserted]).toBe(1)
  })
})

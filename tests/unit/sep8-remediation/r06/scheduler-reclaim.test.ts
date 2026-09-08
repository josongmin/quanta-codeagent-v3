import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  inMemoryAutomationEngine,
  sqliteAutomationEngine,
  tickScheduler,
} from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { RRule } from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

const utc = (y: number, mo: number, d: number, h = 0): number => Date.UTC(y, mo - 1, d, h, 0, 0)

const dueAt = utc(2026, 5, 25, 10)

describe("G-F4 ticker reclaim rail", () => {
  test("durable sqlite: crashed tick is reclaimed by a later ticker", async () => {
    const db = new Database(":memory:")
    const engine = sqliteAutomationEngine(db)
    await engine.schedule({
      id: "cron-1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: dueAt,
      createdAt: dueAt - 1,
    })

    let release: (() => void) | undefined
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = tickScheduler({
      engine,
      now: dueAt,
      handler: () => parked,
      reclaimStaleAfterMs: 50,
      renewEveryMs: 0,
    })
    await Bun.sleep(20)
    const second = await tickScheduler({
      engine,
      now: dueAt + 80,
      handler: async () => undefined,
      reclaimStaleAfterMs: 50,
      renewEveryMs: 0,
    })
    expect(second.kind).toBe("fired")
    const oldFinalize = await engine.finalize({
      id: "cron-1",
      claimToken: "not-the-live-token",
      firedAt: dueAt,
      outcome: "fired",
      nextRunAt: dueAt + 86_400_000,
      inboxTitle: "x",
      inboxSummary: "x",
    })
    expect(oldFinalize.ok).toBe(false)
    release?.()
    const firstOutcome = await first
    expect(firstOutcome.kind).toBe("engine-error")
  })

  test("live renewed claim is not stolen", async () => {
    const engine = inMemoryAutomationEngine()
    await engine.schedule({
      id: "live-1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: dueAt,
      createdAt: dueAt - 1,
    })
    let t = dueAt
    let release: (() => void) | undefined
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = tickScheduler({
      engine,
      now: dueAt,
      handler: () => parked,
      reclaimStaleAfterMs: 40,
      renewEveryMs: 10,
      nowFn: () => t,
    })
    await Bun.sleep(15)
    t = dueAt + 70
    await Bun.sleep(50)
    t = dueAt + 80
    const second = await tickScheduler({
      engine,
      now: t,
      handler: async () => {
        throw new Error("stolen")
      },
      reclaimStaleAfterMs: 40,
      renewEveryMs: 0,
      nowFn: () => t,
    })
    expect(second.kind).toBe("idle")
    release?.()
    const firstOutcome = await first
    expect(firstOutcome.kind).toBe("fired")
  })

  test("stale running row without renew is reclaimed (recovery-required, not exactly-once)", async () => {
    const engine = inMemoryAutomationEngine()
    await engine.schedule({
      id: "once-1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: dueAt,
      createdAt: dueAt - 1,
    })
    let fires = 0
    let release: (() => void) | undefined
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = tickScheduler({
      engine,
      now: dueAt,
      handler: async () => {
        fires += 1
        await parked
      },
      reclaimStaleAfterMs: 20,
      renewEveryMs: 0,
    })
    await Bun.sleep(15)
    const second = await tickScheduler({
      engine,
      now: dueAt + 50,
      handler: async () => {
        fires += 1
      },
      reclaimStaleAfterMs: 20,
      renewEveryMs: 0,
    })
    expect(second.kind).toBe("fired")
    release?.()
    await first
    expect(fires).toBe(2)
  })

  test("old token finalize is rejected after reclaim", async () => {
    const engine = inMemoryAutomationEngine()
    await engine.schedule({
      id: "tok-1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: dueAt,
      createdAt: dueAt - 1,
    })
    const claimed = await engine.claim(dueAt)
    expect(claimed.ok).toBe(true)
    if (!claimed.ok || claimed.value === null) throw new Error("expected claim")
    const oldToken = claimed.value.claimToken
    const reclaimed = await engine.claim(dueAt + 100, { reclaimBefore: dueAt + 50 })
    expect(reclaimed.ok && reclaimed.value !== null).toBe(true)
    if (!reclaimed.ok || reclaimed.value === null) throw new Error("expected reclaim")
    expect(reclaimed.value.claimToken).not.toBe(oldToken)
    const fin = await engine.finalize({
      id: "tok-1",
      claimToken: oldToken,
      firedAt: dueAt + 100,
      outcome: "fired",
      nextRunAt: dueAt + 86_400_000,
      inboxTitle: "x",
      inboxSummary: "x",
    })
    expect(fin.ok).toBe(false)
  })
})

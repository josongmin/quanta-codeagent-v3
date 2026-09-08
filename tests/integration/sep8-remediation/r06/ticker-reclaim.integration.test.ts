import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { sqliteAutomationEngine, tickScheduler } from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { RRule } from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

describe("R06 ticker reclaim (sqlite engine)", () => {
  test("kill mid-handler then later tick reclaims", async () => {
    const engine = sqliteAutomationEngine(new Database(":memory:"))
    const dueAt = Date.UTC(2026, 4, 25, 10)
    await engine.schedule({
      id: "cron-int",
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
      reclaimStaleAfterMs: 40,
      renewEveryMs: 0,
    })
    await Bun.sleep(15)
    const second = await tickScheduler({
      engine,
      now: dueAt + 80,
      handler: async () => undefined,
      reclaimStaleAfterMs: 40,
      renewEveryMs: 0,
    })
    expect(second.kind).toBe("fired")
    release?.()
    await first
  })
})

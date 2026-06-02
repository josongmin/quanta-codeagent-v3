/**
 * ADR-0453 jun-02 wire hellgate — the scheduler-path (automation-engine)
 * autorun-eligibility gate. The reactor path was wired earlier; this proves the
 * SAME pure verdict now also gates RRULE-scheduled fires on the LIVE
 * automation-engine tick (the dead `createSchedulerRuntime` path was bypassed).
 *
 *   HELL-AEW-01  a NOT-eligible verdict ⇒ tick returns `skipped` BEFORE any
 *                claim: the handler never runs AND the due row is NOT advanced
 *                (a later eligible tick still fires it — proves no claim leak,
 *                no anchor advance).
 *   HELL-AEW-02  an eligible verdict ⇒ normal fire (`fired`, handler invoked).
 *   HELL-AEW-03  NO eligibility gate ⇒ byte-identical fire (the consult is
 *                skipped entirely; pre-ADR-0453 behavior).
 *   HELL-AEW-04  the reason anchor is surfaced on the skipped outcome.
 */
import { describe, expect, it } from "bun:test"
import { inMemoryAutomationEngine, tickScheduler } from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { RRule } from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest as RRule
}
const utc = (y: number, mo: number, d: number, h = 0): number => Date.UTC(y, mo, d, h)

const dueEngine = async () => {
  const engine = inMemoryAutomationEngine()
  await engine.schedule({
    id: "a1",
    title: "T",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "do thing",
    nextRunAt: utc(2026, 5, 25, 10),
    createdAt: utc(2026, 5, 25),
  })
  return engine
}
const NOW = utc(2026, 5, 25, 11) // after nextRunAt ⇒ the row is due

describe("ADR-0453 wire — autorun-eligibility gate on the automation-engine tick", () => {
  it("HELL-AEW-01: not-eligible ⇒ skipped before claim; row NOT advanced", async () => {
    const engine = await dueEngine()
    let fired = 0
    const handler = async (): Promise<void> => {
      fired += 1
    }
    const out = await tickScheduler({
      engine,
      now: NOW,
      handler,
      eligibility: () => ({ eligible: false, reason: "policy-never" }),
    })
    expect(out.kind).toBe("skipped")
    expect(fired).toBe(0)

    // No claim was taken + no anchor advanced ⇒ a later ELIGIBLE tick still
    // fires the same row (it was never consumed).
    const out2 = await tickScheduler({
      engine,
      now: NOW,
      handler,
      eligibility: () => ({ eligible: true, reason: "policy-always" }),
    })
    expect(out2.kind).toBe("fired")
    expect(fired).toBe(1)
  })

  it("HELL-AEW-02: eligible ⇒ normal fire (handler invoked)", async () => {
    const engine = await dueEngine()
    let fired = 0
    const out = await tickScheduler({
      engine,
      now: NOW,
      handler: async () => {
        fired += 1
      },
      eligibility: () => ({ eligible: true, reason: "policy-always" }),
    })
    expect(out.kind).toBe("fired")
    expect(fired).toBe(1)
  })

  it("HELL-AEW-03: no eligibility gate ⇒ byte-identical fire", async () => {
    const engine = await dueEngine()
    let fired = 0
    const out = await tickScheduler({
      engine,
      now: NOW,
      handler: async () => {
        fired += 1
      },
    })
    expect(out.kind).toBe("fired")
    expect(fired).toBe(1)
  })

  it("HELL-AEW-04: skipped outcome carries the closed reason anchor", async () => {
    const engine = await dueEngine()
    const out = await tickScheduler({
      engine,
      now: NOW,
      handler: async () => {},
      eligibility: () => ({ eligible: false, reason: "on-request-absent" }),
    })
    expect(out).toEqual({ kind: "skipped", at: NOW, reason: "on-request-absent" })
  })
})

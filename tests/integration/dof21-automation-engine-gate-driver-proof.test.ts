/**
 * DOF-21 real-proof — automation-engine (215-automation-engine / automation-engine-wire).
 *
 * WHAT THIS REPLACES / STRENGTHENS
 * --------------------------------
 * The pre-existing `tests/integration/automation-engine-tick-wire-hellgate.test.ts`
 * drives the real `startAutomationEngineTicker` + real `inMemoryAutomationEngine`,
 * but it NEVER exercises the production GATE: it hand-builds the
 * `AgentConfig.automationEngine` slot literally (`cfgWithEngine({...})`) and never
 * routes through `assembleAutomation(env, deps)` — so `QUANTA_AUTOMATION=on` (the
 * env flag that actually admits the whole subsystem at the composition root) is
 * never the thing under test, and there is no paired control proving that with the
 * gate OFF the scheduler does nothing.
 *
 * DOF-21 requires a real driver end-to-end: the ENV gate → composition-root
 * assembler (`assembleAutomation`) → the real `setInterval`-backed ticker
 * (`startAutomationEngineTicker`) → the real `inMemoryAutomationEngine`'s
 * claim/finalize run-model → observable state advance (fireCount / lastRunAt /
 * inbox) AND the handler dispatching the automation prompt onto a real
 * `AgentLoopPort`. The tick is driven by a fake-clock `setInterval` fired by an
 * external caller (the "driver"), exactly as the composition root would.
 *
 * PAIRED CONTROL (the load-bearing half):
 *   - Gate OFF (`QUANTA_AUTOMATION` unset / not "on") ⇒ `assembleAutomation`
 *     returns `null` ⇒ `startAutomationEngineTicker` arms NO timer ⇒ scheduling a
 *     due automation and firing the (nonexistent) tick advances NOTHING: the row
 *     stays `scheduled` with `fireCount===0`, the handler is never invoked, no
 *     inbox item is written. If a regression made the wire fire regardless of the
 *     gate, THIS test goes RED (fireCount would become 1, dispatch length 1).
 *
 * Everything is hermetic: real in-memory engine, real assembler, real ticker,
 * fake `setInterval` + fake clock so the "driver" is deterministic. No disk, no
 * LLM, no daemon.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { startAutomationEngineTicker } from "@/agent/loop-helpers"
import {
  type AutomationEnginePort,
  type EngineAutomation,
  inMemoryAutomationEngine,
} from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import { assembleAutomation, type EnvReader } from "@/scheduler/runtime-wire"
import type { AgentLoopPort } from "@/scheduler/types"
import type { RRule } from "@/scheduler/types"

// ─── fixtures ─────────────────────────────────────────────────────────────

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

/** A plain env reader over a literal record — mirrors the shape the
 *  composition root passes `assembleAutomation`. */
const envOf = (rec: Record<string, string | undefined>): EnvReader => ({
  get: (name) => rec[name],
})

/** A real-shaped `AgentLoopPort` that records every dispatched prompt. This is
 *  the DOWNSTREAM CONSUMER a real fire drives — the handler closes over
 *  `agentLoop.enqueueUserMessage`, so observing this array proves the tick
 *  actually reached the agent-loop seam (not just mutated engine state). */
const recordingAgentLoop = (): {
  loop: AgentLoopPort
  dispatched: Array<{ prompt: string; opts: unknown }>
} => {
  const dispatched: Array<{ prompt: string; opts: unknown }> = []
  const loop: AgentLoopPort = {
    enqueueUserMessage: async (prompt: string, opts?: unknown) => {
      dispatched.push({ prompt, opts })
    },
  } as unknown as AgentLoopPort
  return { loop, dispatched }
}

/** Fake `setInterval`/`clearInterval` that captures each arm so an external
 *  "driver" can fire the tick body deterministically. */
const fakeIntervalDeps = () => {
  const arms: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
  return {
    arms,
    deps: {
      setInterval: (cb: () => void, ms: number): unknown => {
        const arm = { cb, ms, cleared: false }
        arms.push(arm)
        return arm
      },
      clearInterval: (handle: unknown): void => {
        ;(handle as { cleared: boolean }).cleared = true
      },
    },
  }
}

/** Spread an assembled slot into a minimal AgentConfig — the ticker reads ONLY
 *  `cfg.automationEngine`, so a structural cast is faithful. */
const cfgWithSlot = (slot: AgentConfig["automationEngine"] | null): AgentConfig =>
  ({ ...(slot !== null ? { automationEngine: slot } : {}) }) as unknown as AgentConfig

/** Advance the async tick chain (claim → handler → finalize → onTick). */
const settle = () => new Promise((r) => setTimeout(r, 5))

describe("DOF-21 — automation-engine gate → assembler → ticker → engine run-model", () => {
  // ── PROOF: gate ON drives the full schedule→tick→finalize chain ──────────
  test("gate ON: QUANTA_AUTOMATION=on ⇒ ticker drives a due row through claim/finalize; state advances + handler dispatches", async () => {
    const engine: AutomationEnginePort = inMemoryAutomationEngine()
    // Pre-existing due automation.
    await engine.schedule({
      id: "auto-proof",
      title: "nightly digest",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "summarize today",
      nextRunAt: 1_000,
      createdAt: 0,
    })

    const { loop, dispatched } = recordingAgentLoop()

    // REAL GATE + REAL ASSEMBLER: this is the composition-root path. The engine
    // is injected (deterministic) but the ENV FLAG is what admits the slot.
    const slot = assembleAutomation(
      envOf({ QUANTA_AUTOMATION: "on", QUANTA_AUTOMATION_INTERVAL_MS: "30" }),
      { agentLoop: loop, engine, now: () => 2_000 },
    )
    expect(slot).not.toBeNull() // gate admitted the wire

    const { arms, deps } = fakeIntervalDeps()
    const handle = startAutomationEngineTicker(cfgWithSlot(slot), deps)
    expect(handle).toBeDefined()
    expect(arms).toHaveLength(1)
    // Interval knob flowed through the assembler verbatim.
    expect(arms[0]!.ms).toBe(30)

    // Pre-tick invariant: nothing has fired yet.
    const before = await engine.list()
    expect(before.ok).toBe(true)
    const rowBefore = before.ok ? before.value.find((a) => a.id === "auto-proof") : undefined
    expect(rowBefore?.fireCount).toBe(0)
    expect(rowBefore?.lastRunAt).toBeUndefined()
    expect(dispatched).toHaveLength(0)

    // DRIVER: fire the timer body once (what the real setInterval would do).
    arms[0]!.cb()
    await settle()

    // OBSERVABLE EFFECT #1 — real engine run-model advanced: fireCount bumped,
    // lastRunAt stamped at the tick clock, row back to `scheduled` (recurring).
    const after = await engine.list()
    expect(after.ok).toBe(true)
    const rowAfter: EngineAutomation | undefined = after.ok
      ? after.value.find((a) => a.id === "auto-proof")
      : undefined
    expect(rowAfter).toBeDefined()
    expect(rowAfter?.fireCount).toBe(1)
    expect(rowAfter?.lastRunAt).toBe(2_000)
    expect(rowAfter?.status).toBe("scheduled")

    // OBSERVABLE EFFECT #2 — handler dispatched the automation prompt onto the
    // real AgentLoopPort seam (the downstream consumer).
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.prompt).toBe("summarize today")

    handle?.stop()
    expect(arms[0]!.cleared).toBe(true)
  })

  // ── PAIRED CONTROL: gate OFF ⇒ NOTHING drives ───────────────────────────
  test("gate OFF (paired control): QUANTA_AUTOMATION unset ⇒ null slot ⇒ no timer ⇒ zero effect", async () => {
    const engine: AutomationEnginePort = inMemoryAutomationEngine()
    await engine.schedule({
      id: "auto-proof",
      title: "nightly digest",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "summarize today",
      nextRunAt: 1_000,
      createdAt: 0,
    })

    const { loop, dispatched } = recordingAgentLoop()

    // GATE OFF — the ONLY difference from the proof above.
    const slot = assembleAutomation(
      envOf({ QUANTA_AUTOMATION: undefined, QUANTA_AUTOMATION_INTERVAL_MS: "30" }),
      { agentLoop: loop, engine, now: () => 2_000 },
    )
    // RED-on-regression anchor: if the gate stopped mattering, slot !== null.
    expect(slot).toBeNull()

    const { arms, deps } = fakeIntervalDeps()
    const handle = startAutomationEngineTicker(cfgWithSlot(slot), deps)
    // No slot ⇒ helper returns undefined ⇒ NO timer armed.
    expect(handle).toBeUndefined()
    expect(arms).toHaveLength(0)

    // There is no tick body to fire. Settle anyway to catch a stray async fire.
    await settle()

    // The engine row is UNTOUCHED: still scheduled, never fired.
    const after = await engine.list()
    expect(after.ok).toBe(true)
    const rowAfter = after.ok ? after.value.find((a) => a.id === "auto-proof") : undefined
    expect(rowAfter?.fireCount).toBe(0)
    expect(rowAfter?.lastRunAt).toBeUndefined()
    expect(rowAfter?.status).toBe("scheduled")
    // Handler never dispatched.
    expect(dispatched).toHaveLength(0)
  })

  // ── PAIRED CONTROL 2: gate ON but a REQUIRED sub-condition removed ───────
  // The gate flag alone is not sufficient: `assembleAutomation` also validates
  // the interval knob. A malformed interval (a broken required condition) ⇒
  // null slot even with QUANTA_AUTOMATION=on. This proves the gate is a real
  // conjunction, not a single boolean the test happens to satisfy.
  test("gate ON but interval invalid (broken-wire control): assembler returns null ⇒ no driver", async () => {
    const engine = inMemoryAutomationEngine()
    await engine.schedule({
      id: "auto-proof",
      title: "t",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: 1_000,
      createdAt: 0,
    })
    const { loop, dispatched } = recordingAgentLoop()
    const slot = assembleAutomation(
      envOf({ QUANTA_AUTOMATION: "on", QUANTA_AUTOMATION_INTERVAL_MS: "-5" }),
      { agentLoop: loop, engine, now: () => 2_000 },
    )
    expect(slot).toBeNull()
    const { arms, deps } = fakeIntervalDeps()
    expect(startAutomationEngineTicker(cfgWithSlot(slot), deps)).toBeUndefined()
    expect(arms).toHaveLength(0)
    await settle()
    const after = await engine.list()
    const row = after.ok ? after.value.find((a) => a.id === "auto-proof") : undefined
    expect(row?.fireCount).toBe(0)
    expect(dispatched).toHaveLength(0)
  })

  // ── EDGE: two driver ticks on a recurring row ⇒ fireCount increments twice,
  // prompt dispatched twice — proves the run-model actually re-arms the row
  // (a stub that "fired once and got stuck" would fail the count-2 assertion).
  test("gate ON: two driver ticks advance fireCount 0→1→2 and dispatch twice (recurring re-arm)", async () => {
    const engine = inMemoryAutomationEngine()
    await engine.schedule({
      id: "auto-recur",
      title: "t",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "recur-prompt",
      nextRunAt: 1_000,
      createdAt: 0,
    })
    const { loop, dispatched } = recordingAgentLoop()
    // Clock advances each read so the second tick is genuinely "later" and the
    // recurring row is due again.
    let clock = 2_000
    const slot = assembleAutomation(envOf({ QUANTA_AUTOMATION: "on" }), {
      agentLoop: loop,
      engine,
      now: () => clock,
    })
    expect(slot).not.toBeNull()
    const { arms, deps } = fakeIntervalDeps()
    startAutomationEngineTicker(cfgWithSlot(slot), deps)

    arms[0]!.cb()
    await settle()
    let list = await engine.list()
    let row = list.ok ? list.value.find((a) => a.id === "auto-recur") : undefined
    expect(row?.fireCount).toBe(1)

    // Advance the clock WELL past the recurring next-fire so tick #2 claims it.
    clock = 100_000_000
    arms[0]!.cb()
    await settle()
    list = await engine.list()
    row = list.ok ? list.value.find((a) => a.id === "auto-recur") : undefined
    expect(row?.fireCount).toBe(2)
    expect(dispatched).toHaveLength(2)
    expect(dispatched.map((d) => d.prompt)).toEqual(["recur-prompt", "recur-prompt"])
  })
})

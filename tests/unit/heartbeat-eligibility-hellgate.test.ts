/**
 * ADR-0453 — Heartbeat autorun eligibility hellgate.
 *
 * Three concerns under adversarial test:
 *   1. The PURE evaluator: every `approvalPolicy` → correct `{ eligible, reason }`,
 *      `on-failure` only after a `fail`, `on-request` only with a manual approval,
 *      mode does NOT change the verdict, reasons are the closed enum set.
 *   2. The SCHEDULER gate: with a resolver injected, a NOT-eligible verdict skips
 *      the fire (emits `not-eligible` + anchor unmoved); ABSENT resolver is
 *      byte-identical to the RRULE-only fire path.
 *   3. The REACTOR gate (4th guard): with a resolver injected, a NOT-eligible
 *      verdict skips the wake; ABSENT resolver is byte-identical to the 3-guard
 *      path.
 *
 * All effects are fakes — no wall clock, no fs, no process.env. The evaluator
 * is exercised directly (it is pure).
 */

import { describe, expect, test } from "bun:test"
import {
  ALL_AUTORUN_ELIGIBILITY_REASONS,
  type AutorunApprovalPolicy,
  type AutorunEligibilityReason,
  evaluateAutorunEligibility,
} from "@/permission/autorun-eligibility"
import { injectSimulatedTurn } from "@/reactor/self-wake"
import type {
  ProactiveTrigger,
  AgentLoopPort as ReactorAgentLoop,
  ClockPort as ReactorClock,
  EnvPort as ReactorEnv,
  ReactorSelfWakeEvent,
  AutorunVerdict as ReactorVerdict,
} from "@/reactor/types"
import { createAutomation } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { createSchedulerRuntime } from "@/scheduler/runtime"
import type {
  AgentLoopPort,
  Automation,
  AutomationStorePort,
  AutorunEligibilityResolverPort,
  ClockPort,
  EnvPort,
  ModelAvailabilityPort,
  SchedulerEvent,
  SchedulerSinkPort,
} from "@/scheduler/types"

// ===========================================================================
// 1. Pure evaluator
// ===========================================================================

describe("ADR-0453 evaluateAutorunEligibility — pure mapping", () => {
  test('[1] "always" ⇒ eligible / policy-always (regardless of outcome)', () => {
    expect(evaluateAutorunEligibility({ approvalPolicy: "always" })).toEqual({
      eligible: true,
      reason: "policy-always",
    })
    expect(evaluateAutorunEligibility({ approvalPolicy: "always", priorOutcome: "fail" })).toEqual({
      eligible: true,
      reason: "policy-always",
    })
  })

  test('[2] "never" ⇒ NOT eligible / policy-never (even after a failure)', () => {
    expect(evaluateAutorunEligibility({ approvalPolicy: "never" })).toEqual({
      eligible: false,
      reason: "policy-never",
    })
    expect(
      evaluateAutorunEligibility({
        approvalPolicy: "never",
        priorOutcome: "fail",
        manualApprovalPresent: true,
      }),
    ).toEqual({ eligible: false, reason: "policy-never" })
  })

  test('[3] "on-failure" eligible IFF priorOutcome === "fail"', () => {
    expect(
      evaluateAutorunEligibility({ approvalPolicy: "on-failure", priorOutcome: "fail" }),
    ).toEqual({ eligible: true, reason: "on-failure-failed" })
    // non-failure outcomes
    for (const o of ["success", "partial", "uncertain"] as const) {
      expect(evaluateAutorunEligibility({ approvalPolicy: "on-failure", priorOutcome: o })).toEqual(
        { eligible: false, reason: "on-failure-not-failed" },
      )
    }
  })

  test('[4] "on-failure" absent outcome ⇒ NOT eligible (fail-toward-no-run)', () => {
    expect(evaluateAutorunEligibility({ approvalPolicy: "on-failure" })).toEqual({
      eligible: false,
      reason: "on-failure-not-failed",
    })
  })

  test('[5] "on-request" eligible IFF a manual approval is present', () => {
    expect(
      evaluateAutorunEligibility({ approvalPolicy: "on-request", manualApprovalPresent: true }),
    ).toEqual({ eligible: true, reason: "on-request-present" })
    expect(
      evaluateAutorunEligibility({ approvalPolicy: "on-request", manualApprovalPresent: false }),
    ).toEqual({ eligible: false, reason: "on-request-absent" })
    // absent flag ⇒ no standing request ⇒ blocked
    expect(evaluateAutorunEligibility({ approvalPolicy: "on-request" })).toEqual({
      eligible: false,
      reason: "on-request-absent",
    })
  })

  test("[6] mode does NOT change the verdict (orthogonal audit anchor only)", () => {
    const base = { approvalPolicy: "never" as const }
    for (const mode of ["architect", "editor", "debug", "tdd", "explore", ""]) {
      expect(evaluateAutorunEligibility({ ...base, mode })).toEqual({
        eligible: false,
        reason: "policy-never",
      })
    }
  })

  test("[7] every emitted reason is in the closed enum set (structural, not free text)", () => {
    const policies: AutorunApprovalPolicy[] = ["always", "never", "on-failure", "on-request"]
    const seen = new Set<AutorunEligibilityReason>()
    for (const p of policies) {
      for (const o of ["success", "partial", "uncertain", "fail"] as const) {
        for (const m of [true, false]) {
          const r = evaluateAutorunEligibility({
            approvalPolicy: p,
            priorOutcome: o,
            manualApprovalPresent: m,
          })
          expect(ALL_AUTORUN_ELIGIBILITY_REASONS).toContain(r.reason)
          seen.add(r.reason)
        }
      }
    }
    // The full input lattice exercises every closed reason arm.
    expect([...seen].sort()).toEqual([...ALL_AUTORUN_ELIGIBILITY_REASONS].sort())
  })

  test("[8] PURE / TOTAL — same input ⇒ same verdict, no side effects", () => {
    const input = {
      approvalPolicy: "on-failure" as const,
      priorOutcome: "fail" as const,
      manualApprovalPresent: false,
      mode: "debug",
    }
    const a = evaluateAutorunEligibility(input)
    const b = evaluateAutorunEligibility(input)
    expect(a).toEqual(b)
    // input not mutated
    expect(input).toEqual({
      approvalPolicy: "on-failure",
      priorOutcome: "fail",
      manualApprovalPresent: false,
      mode: "debug",
    })
  })
})

// ===========================================================================
// Scheduler fixtures
// ===========================================================================

const ruleOf = (s: string) => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}
const utc = (y: number, mo: number, d: number): number => Date.UTC(y, mo - 1, d, 0, 0, 0)

const sampleAutomation = (overrides?: Partial<Automation>): Automation => ({
  ...createAutomation({
    id: "a1",
    title: "daily",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "run me",
    modelPreference: "gpt-5",
    modelFallbacks: ["claude-4"],
    createdAt: utc(2026, 5, 1),
  }),
  ...overrides,
})

interface SchedFakes {
  readonly clock: ClockPort
  readonly env: EnvPort
  readonly store: AutomationStorePort
  readonly content: Automation[]
  readonly availability: ModelAvailabilityPort
  readonly agentLoop: AgentLoopPort
  readonly enqueued: string[]
  readonly sink: SchedulerSinkPort
  readonly events: SchedulerEvent[]
}

const schedFakes = (initial: ReadonlyArray<Automation>): SchedFakes => {
  const content: Automation[] = [...initial]
  const enqueued: string[] = []
  const events: SchedulerEvent[] = []
  return {
    clock: { now: () => utc(2026, 5, 3) }, // 2 days after createdAt ⇒ due
    env: { get: () => undefined },
    store: {
      load: async () => [...content],
      save: async (_w, a) => {
        const i = content.findIndex((x) => x.id === a.id)
        if (i >= 0) content[i] = a
        else content.push(a)
      },
      delete: async () => undefined,
    },
    content,
    availability: { isAvailable: async (m) => ["gpt-5", "claude-4"].includes(m) },
    agentLoop: { enqueueUserMessage: async (m) => void enqueued.push(m) },
    enqueued,
    sink: { emit: (e) => void events.push(e) },
    events,
  }
}

const resolverOf = (verdict: ReactorVerdict | undefined): AutorunEligibilityResolverPort => ({
  resolve: () => verdict,
})

describe("ADR-0453 scheduler gate", () => {
  test("[9] resolver NOT-eligible ⇒ skip fire, anchor unmoved, emits not-eligible", async () => {
    const f = schedFakes([sampleAutomation()])
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
      eligibility: resolverOf({ eligible: false, reason: "policy-never" }),
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual([]) // no dispatch
    expect(f.content[0]?.fireCount).toBe(0) // anchor UNMOVED
    expect(f.content[0]?.lastFiredAt).toBeUndefined()
    const skip = f.events.find((e) => e.type === "scheduler.skipped")
    expect(skip).toBeDefined()
    expect(skip).toMatchObject({ reason: "not-eligible", eligibilityReason: "policy-never" })
  })

  test("[10] resolver eligible ⇒ fires normally (gate is pass-through)", async () => {
    const f = schedFakes([sampleAutomation()])
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
      eligibility: resolverOf({ eligible: true, reason: "policy-always" }),
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual(["run me"])
    expect(f.content[0]?.fireCount).toBe(1)
    expect(f.events.some((e) => e.type === "scheduler.fired")).toBe(true)
  })

  test("[11] resolver returns undefined ⇒ no opinion ⇒ fires (additive gate)", async () => {
    const f = schedFakes([sampleAutomation()])
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
      eligibility: resolverOf(undefined),
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual(["run me"])
    expect(f.content[0]?.fireCount).toBe(1)
  })

  test("[12] DEFAULT-OFF — no resolver ⇒ byte-identical to RRULE-only fire", async () => {
    const withGate = schedFakes([sampleAutomation()])
    const noGate = schedFakes([sampleAutomation()])
    const mk = (f: SchedFakes, withResolver: boolean) =>
      createSchedulerRuntime({
        store: f.store,
        availability: f.availability,
        clock: f.clock,
        env: f.env,
        agentLoop: f.agentLoop,
        workspace: "/w",
        sink: f.sink,
        ...(withResolver ? { eligibility: resolverOf(undefined) } : {}),
      })
    await mk(withGate, true).tickOnce()
    await mk(noGate, false).tickOnce()
    // Same dispatch, same persisted anchor, same emitted events.
    expect(noGate.enqueued).toEqual(withGate.enqueued)
    expect(noGate.content[0]?.fireCount).toBe(withGate.content[0]?.fireCount)
    expect(noGate.content[0]?.lastFiredAt).toBe(withGate.content[0]?.lastFiredAt)
    expect(noGate.events).toEqual(withGate.events)
    // And the no-gate path must be a plain fire (no eligibility event).
    expect(noGate.events.every((e) => !("eligibilityReason" in e))).toBe(true)
  })

  test("[13] on-failure semantics through the scheduler gate (no failure ⇒ blocked)", async () => {
    const f = schedFakes([sampleAutomation()])
    const rt = createSchedulerRuntime({
      store: f.store,
      availability: f.availability,
      clock: f.clock,
      env: f.env,
      agentLoop: f.agentLoop,
      workspace: "/w",
      sink: f.sink,
      // Resolver wired to the PURE evaluator with a non-failure prior outcome.
      eligibility: {
        resolve: () =>
          evaluateAutorunEligibility({ approvalPolicy: "on-failure", priorOutcome: "success" }),
      },
    })
    await rt.tickOnce()
    expect(f.enqueued).toEqual([])
    const skip = f.events.find((e) => e.type === "scheduler.skipped")
    expect(skip).toMatchObject({
      reason: "not-eligible",
      eligibilityReason: "on-failure-not-failed",
    })
  })
})

// ===========================================================================
// Reactor fixtures (4th guard)
// ===========================================================================

const reactorEnvOn: ReactorEnv = {
  get: (n) => (n === "QUANTA_PROACTIVE_REACTOR" ? "1" : undefined),
}
const reactorClock = (ms: number): ReactorClock => ({ now: () => ms })
const QUIET = 30_000

const trigger = (): ProactiveTrigger =>
  Object.freeze({
    reason: "ci_completion",
    evidence: Object.freeze({ kind: "url" as const, value: "https://x/pr/1" }),
    simulatedMessage: "CI done",
    abortSignal: new AbortController().signal,
  })

interface ReactorFakes {
  readonly loop: ReactorAgentLoop
  readonly calls: string[]
  readonly events: ReactorSelfWakeEvent[]
}
const reactorFakes = (): ReactorFakes => {
  const calls: string[] = []
  const events: ReactorSelfWakeEvent[] = []
  return {
    loop: { enqueueUserMessage: async (m) => void calls.push(m) },
    calls,
    events,
  }
}

describe("ADR-0453 reactor 4th-guard gate", () => {
  test("[14] all 3 guards pass + resolver NOT-eligible ⇒ skipped:not-eligible", async () => {
    const f = reactorFakes()
    const res = await injectSimulatedTurn({
      trigger: trigger(),
      agentLoop: f.loop,
      envPort: reactorEnvOn,
      clockPort: reactorClock(1_000_000),
      lastUserInputAt: 1_000_000 - QUIET - 1, // quiet window satisfied
      lastTurnOutcome: "success", // prior-outcome guard satisfied
      eligibility: () => ({ eligible: false, reason: "policy-never" }),
      onEvent: (e) => void f.events.push(e),
    })
    expect(res).toEqual({
      injected: false,
      reason: "not-eligible",
      eligibilityReason: "policy-never",
    })
    expect(f.calls).toEqual([]) // never touched the loop
    expect(f.events).toHaveLength(1)
    expect(f.events[0]).toMatchObject({
      outcome: "skipped",
      reason: "not-eligible",
      eligibilityReason: "policy-never",
    })
  })

  test("[15] resolver eligible ⇒ wake injects (gate pass-through)", async () => {
    const f = reactorFakes()
    const res = await injectSimulatedTurn({
      trigger: trigger(),
      agentLoop: f.loop,
      envPort: reactorEnvOn,
      clockPort: reactorClock(1_000_000),
      lastUserInputAt: 1_000_000 - QUIET - 1,
      lastTurnOutcome: "success",
      eligibility: () => ({ eligible: true, reason: "policy-always" }),
      onEvent: (e) => void f.events.push(e),
    })
    expect(res.injected).toBe(true)
    expect(f.calls).toHaveLength(1)
  })

  test("[16] resolver runs AFTER the 3 guards — env-off short-circuits before it", async () => {
    const f = reactorFakes()
    let resolverCalled = false
    const res = await injectSimulatedTurn({
      trigger: trigger(),
      agentLoop: f.loop,
      envPort: { get: () => undefined }, // env-off ⇒ guard 1 rejects first
      clockPort: reactorClock(1_000_000),
      lastUserInputAt: 0,
      lastTurnOutcome: "success",
      eligibility: () => {
        resolverCalled = true
        return { eligible: false, reason: "policy-never" }
      },
      onEvent: (e) => void f.events.push(e),
    })
    expect(res.reason).toBe("env-off")
    expect(resolverCalled).toBe(false) // cheap guards win; resolver not consulted
  })

  test("[17] DEFAULT-OFF — no resolver ⇒ byte-identical to the 3-guard path", async () => {
    const mk = async (withResolver: boolean) => {
      const f = reactorFakes()
      const res = await injectSimulatedTurn({
        trigger: trigger(),
        agentLoop: f.loop,
        envPort: reactorEnvOn,
        clockPort: reactorClock(1_000_000),
        lastUserInputAt: 1_000_000 - QUIET - 1,
        lastTurnOutcome: "success",
        ...(withResolver ? { eligibility: () => undefined } : {}),
        onEvent: (e) => void f.events.push(e),
      })
      return { res, f }
    }
    const a = await mk(false)
    const b = await mk(true) // resolver present but returns undefined (no opinion)
    expect(a.res).toEqual(b.res)
    expect(a.f.calls).toEqual(b.f.calls)
    expect(a.res.injected).toBe(true) // both inject — gate is additive
    // No eligibility event leaks on the default path.
    expect(a.f.events.every((e) => e.reason !== "not-eligible")).toBe(true)
  })

  test("[18] on-failure through the reactor gate (failure ⇒ eligible ⇒ injects)", async () => {
    const f = reactorFakes()
    const res = await injectSimulatedTurn({
      trigger: trigger(),
      agentLoop: f.loop,
      envPort: reactorEnvOn,
      clockPort: reactorClock(1_000_000),
      lastUserInputAt: 1_000_000 - QUIET - 1,
      lastTurnOutcome: "success",
      eligibility: () =>
        evaluateAutorunEligibility({ approvalPolicy: "on-failure", priorOutcome: "fail" }),
      onEvent: (e) => void f.events.push(e),
    })
    expect(res.injected).toBe(true)
    expect(f.calls).toHaveLength(1)
  })
})

/**
 * ★ HELLGATE — Capability C LIVE: the REAL `@/subagent/coordination`
 *   `createIdleBarrier` driving the REAL `@/side-agent` daemon registry's
 *   team-idle fan-in. Proves the barrier is genuinely wired through the pass
 *   lifecycle (beacon on spawn + pass-complete, reactivate while in flight) and
 *   that `teamIdle()`/`idleSince()` reflect it — NOT a no-op seam.
 *
 * Source under test:
 *   - src/side-agent/registry.ts (beacon/reactivate + teamIdle/idleSince)
 *   - src/subagent/coordination/idle-barrier.ts (the injected barrier)
 */
import { describe, expect, test } from "bun:test"
import {
  createSideAgentDaemonRegistry,
  type SideAgentDaemonOpts,
  type SideAgentRunnerPort,
  type SideAgentSpec,
} from "@/side-agent"
import { createIdleBarrier } from "@/subagent/coordination"

/** Manual interval timers: `fire(handle)` ticks a daemon once. */
const mkTimers = () => {
  const handlers = new Map<number, () => void>()
  let next = 0
  return {
    setInterval: (h: () => void): unknown => {
      const id = ++next
      handlers.set(id, h)
      return id
    },
    clearInterval: (): void => {},
    fire: (handle: unknown): void => {
      handlers.get(handle as number)?.()
    },
  }
}

const mkClock = () => {
  let t = 1000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const mailbox = { send: () => {} }

const spec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
  task: "watch",
  trigger: { kind: "interval", everyMs: 1000 },
  maxWakes: 100,
  maxTurnsPerWake: 3,
  ...over,
})

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Build a registry over the REAL barrier + scripted runner. Returns the timer
 *  handle source so a test can `fire` a daemon's wake. */
const build = (runner: SideAgentRunnerPort, withBarrier: boolean, clock = mkClock()) => {
  const timers = mkTimers()
  const opts: SideAgentDaemonOpts = {
    runner,
    mailbox,
    mainRecipient: "main",
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: clock.now,
    ...(withBarrier ? { idleBarrier: createIdleBarrier({ now: clock.now }) } : {}),
  }
  return { reg: createSideAgentDaemonRegistry(opts), timers, clock }
}

const idleRunner: SideAgentRunnerPort = { run: async () => null }
const hangRunner: SideAgentRunnerPort = { run: () => new Promise(() => {}) }

describe("HELLGATE C — team-idle barrier default-OFF (no barrier wired)", () => {
  test("teamIdle() ⇒ false, idleSince() ⇒ undefined (opt-in via QUANTA_TEAM_IDLE)", () => {
    const { reg } = build(idleRunner, false)
    reg.spawn(spec())
    expect(reg.teamIdle()).toBe(false)
    expect(reg.idleSince()).toBeUndefined()
  })
})

describe("HELLGATE C — REAL barrier drives team-idle through the pass lifecycle", () => {
  test("a freshly-spawned daemon is beaconed idle ⇒ teamIdle true, idleSince = spawn ts", () => {
    const clock = mkClock()
    const { reg } = build(idleRunner, true, clock)
    reg.spawn(spec()) // beacon at t=1000
    expect(reg.teamIdle()).toBe(true)
    expect(reg.idleSince()).toBe(1000)
  })

  test("empty team (no daemons) ⇒ teamIdle false (never report a vacuous team done)", () => {
    const { reg } = build(idleRunner, true)
    expect(reg.teamIdle()).toBe(false)
    expect(reg.idleSince()).toBeUndefined()
  })

  test("a pass IN FLIGHT clears the beacon ⇒ teamIdle false until it completes", () => {
    const { reg, timers } = build(hangRunner, true)
    const id = reg.spawn(spec())
    expect(reg.teamIdle()).toBe(true) // idle before the first wake
    // The interval fires → wake() sets inFlight + reactivate() synchronously
    // (before the awaited runner.run hangs).
    const handle = 1 // the single daemon's interval handle
    timers.fire(handle)
    expect(id).toMatch(/^sa-/)
    expect(reg.teamIdle()).toBe(false) // busy: beacon cleared
    expect(reg.idleSince()).toBeUndefined()
  })

  test("pass COMPLETES ⇒ re-beaconed idle ⇒ teamIdle true again (release ts advances)", async () => {
    const clock = mkClock()
    const { reg, timers } = build(idleRunner, true, clock)
    reg.spawn(spec()) // beacon @1000
    clock.advance(500) // now=1500
    timers.fire(1) // wake → reactivate, runner completes (null result)
    await flush() // let the async pass settle → beacon @1500
    expect(reg.teamIdle()).toBe(true)
    expect(reg.idleSince()).toBe(1500)
  })

  test("two daemons: team idle only when BOTH are quiescent; idleSince = MAX", () => {
    const clock = mkClock()
    const { reg, timers } = build(hangRunner, true, clock)
    reg.spawn(spec()) // d1 beacon @1000 (handle 1)
    clock.advance(100)
    reg.spawn(spec()) // d2 beacon @1100 (handle 2)
    expect(reg.teamIdle()).toBe(true)
    expect(reg.idleSince()).toBe(1100) // MAX across members
    timers.fire(1) // d1 goes busy (hang)
    expect(reg.teamIdle()).toBe(false) // not ALL idle
  })

  test("a STOPPED daemon leaves the team ⇒ teamIdle reflects the remaining member", () => {
    const { reg } = build(hangRunner, true)
    const a = reg.spawn(spec())
    const b = reg.spawn(spec())
    expect(reg.teamIdle()).toBe(true)
    reg.stop(a) // a is terminal — beacon cleared, no longer a member
    expect(reg.teamIdle()).toBe(true) // b still idle
    expect(b).not.toBe(a)
  })
})

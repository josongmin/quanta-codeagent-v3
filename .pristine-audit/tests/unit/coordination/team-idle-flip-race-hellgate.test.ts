/**
 * ★ HELLGATE — Capability C: idle-barrier FLIP-RACE + stale-beacon ordering in
 *   the LIVE `@/side-agent` registry driving the REAL `createIdleBarrier`.
 *
 * Attacks (concurrency invariants #1 + #2):
 *   - FLIP-RACE: a member beacons idle, then immediately goes busy; a leader's
 *     `teamIdle()` read must NEVER observe a false "all idle" while a member is
 *     mid-transition. Because the registry reactivates SYNCHRONOUSLY at wake
 *     entry (before the awaited pass), a busy daemon carries NO beacon — so a
 *     read between two daemons' transitions is always a consistent snapshot.
 *   - STALE-BEACON: a daemon completes a pass and re-beacons at the LATER clock
 *     instant; `idleSince()` must reflect the MAX (the moment the LAST member
 *     went idle) and be MONOTONE per member — a completed pass's re-beacon never
 *     resurrects an older idleSince. (mirrors the pty diffCapture out-of-order
 *     class: last CAUSAL write wins, and the registry serializes a daemon's
 *     passes via `inFlight` so causal order == call order.)
 *   - in-flight + re-idle interleave across two daemons: team is idle ONLY when
 *     BOTH are quiescent; a single busy member breaks it even if the other just
 *     re-beaconed.
 *
 * Source under test: src/side-agent/registry.ts + src/subagent/coordination/idle-barrier.ts
 */
import { describe, expect, test } from "bun:test"
import {
  createSideAgentDaemonRegistry,
  type SideAgentDaemonOpts,
  type SideAgentRunnerPort,
  type SideAgentSpec,
} from "@/side-agent"
import { createIdleBarrier } from "@/subagent/coordination"

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
    fire: (handle: unknown): void => handlers.get(handle as number)?.(),
  }
}

const mkClock = () => {
  let t = 1000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const mailbox = { send: () => {} }
const flush = () => new Promise((r) => setTimeout(r, 0))

const spec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
  task: "watch",
  trigger: { kind: "interval", everyMs: 1000 },
  maxWakes: 100,
  maxTurnsPerWake: 3,
  ...over,
})

/** A runner whose pass resolution is controllable PER CALL (FIFO). `releaseNext`
 *  resolves the OLDEST in-flight pass — so two daemons' passes can be released
 *  independently and interleaved deterministically. */
const mkGatedRunner = (): {
  runner: SideAgentRunnerPort
  releaseNext: () => void
  inFlight: () => number
} => {
  const queue: Array<() => void> = []
  const runner: SideAgentRunnerPort = {
    run: () => new Promise((resolve) => queue.push(() => resolve(null))),
  }
  return {
    runner,
    releaseNext: () => queue.shift()?.(),
    inFlight: () => queue.length,
  }
}

const build = (runner: SideAgentRunnerPort, clock = mkClock()) => {
  const timers = mkTimers()
  const opts: SideAgentDaemonOpts = {
    runner,
    mailbox,
    mainRecipient: "main",
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: clock.now,
    idleBarrier: createIdleBarrier({ now: clock.now }),
  }
  return { reg: createSideAgentDaemonRegistry(opts), timers, clock }
}

describe("HELLGATE C — idle FLIP-RACE (no false all-idle mid-transition)", () => {
  test("member goes busy DURING a leader read window ⇒ teamIdle flips to false, never a stale true", () => {
    const { reg, timers } = build(mkGatedRunner().runner)
    reg.spawn(spec()) // d1 idle (handle 1)
    reg.spawn(spec()) // d2 idle (handle 2)
    expect(reg.teamIdle()).toBe(true) // both idle — consistent snapshot

    // d1's interval fires: wake() sets inFlight + reactivate SYNCHRONOUSLY.
    timers.fire(1)
    // A leader reading NOW must see the transition (d1 busy) — not a stale true.
    expect(reg.teamIdle()).toBe(false)
    expect(reg.idleSince()).toBeUndefined()
  })

  test("ONE member re-idles while the OTHER is still busy ⇒ team is NOT idle (no false all-idle)", async () => {
    const g = mkGatedRunner()
    const clock = mkClock()
    const { reg, timers } = build(g.runner, clock)
    reg.spawn(spec()) // d1 (handle 1)
    reg.spawn(spec()) // d2 (handle 2)
    timers.fire(1) // d1 busy (its pass enqueued first)
    timers.fire(2) // d2 busy (enqueued second)
    expect(reg.teamIdle()).toBe(false)
    expect(g.inFlight()).toBe(2)

    // Release ONLY d1's pass → d1 re-beacons idle; d2 is STILL busy.
    clock.advance(50)
    g.releaseNext() // resolves d1 (FIFO oldest)
    await flush()
    // THE ATTACK: d1 idle but d2 busy ⇒ team must remain NOT idle.
    expect(reg.teamIdle()).toBe(false)
    expect(reg.idleSince()).toBeUndefined()

    // Now release d2 → BOTH quiescent ⇒ team idle.
    clock.advance(50)
    g.releaseNext()
    await flush()
    expect(reg.teamIdle()).toBe(true)
  })
})

describe("HELLGATE C — stale-beacon / idleSince monotonicity", () => {
  test("a completed pass re-beacons at the LATER instant ⇒ idleSince advances, never regresses", async () => {
    const idleRunner: SideAgentRunnerPort = { run: async () => null }
    const clock = mkClock()
    const { reg, timers } = build(idleRunner, clock)
    reg.spawn(spec()) // d1 beacon @1000 (handle 1)
    clock.advance(100)
    reg.spawn(spec()) // d2 beacon @1100 (handle 2)
    expect(reg.idleSince()).toBe(1100) // MAX = the last member to go idle

    // d1 wakes + completes at a LATER instant → re-beacons @1500.
    clock.advance(400) // now=1500
    timers.fire(1)
    await flush()
    // d1's beacon is now 1500 (the later instant); d2 still @1100. MAX = 1500.
    expect(reg.teamIdle()).toBe(true)
    expect(reg.idleSince()).toBe(1500) // advanced, did NOT regress to 1100
  })

  test("re-beacon uses LATEST timestamp per member (no duplicate / no stale resurrection)", async () => {
    const idleRunner: SideAgentRunnerPort = { run: async () => null }
    const clock = mkClock()
    const { reg, timers } = build(idleRunner, clock)
    reg.spawn(spec()) // beacon @1000
    expect(reg.idleSince()).toBe(1000)
    // Multiple wake/complete cycles — each re-beacon REPLACES, never appends.
    for (const t of [1100, 1200, 1300]) {
      clock.advance(100)
      timers.fire(1)
      await flush()
      expect(reg.idleSince()).toBe(t) // exactly the latest instant, monotone up
    }
  })
})

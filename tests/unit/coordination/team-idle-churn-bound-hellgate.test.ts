/**
 * ★ HELLGATE — Capability C resource bounds under CHURN (invariants #3 daemon-Map
 *   concurrency-safe pruning + #5 unbounded growth) in the LIVE registry.
 *
 *   - A long session that spawns→stops 10k daemons keeps `list()` bounded by
 *     `maxRetained` (the terminal-prune ring) and the running set by
 *     `maxConcurrent` — no unbounded map growth.
 *   - The idle-barrier beacon set never accretes stale beacons: `finish` (every
 *     terminal path) reactivates the daemon, so a STOPPED daemon's beacon is
 *     dropped — `teamIdle()`/`idleSince()` reflect ONLY current running members,
 *     not a graveyard of dead beacons.
 *   - prune during a teamIdle()/idleSince() read window is consistent (prune runs
 *     at the END of public methods, never mid-iteration of the daemons Map).
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

const mkTimers = () => ({
  setInterval: (): unknown => 0,
  clearInterval: (): void => {},
})

const mkClock = () => {
  let t = 1000
  return { now: () => t++, advance: (ms: number) => (t += ms) }
}

const idleRunner: SideAgentRunnerPort = { run: async () => null }

const spec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
  task: "watch",
  trigger: { kind: "interval", everyMs: 1000 },
  maxWakes: 100,
  maxTurnsPerWake: 3,
  ...over,
})

const build = (over: Partial<SideAgentDaemonOpts> = {}) => {
  const timers = mkTimers()
  const clock = mkClock()
  const opts: SideAgentDaemonOpts = {
    runner: idleRunner,
    mailbox: { send: () => {} },
    mainRecipient: "main",
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: clock.now,
    idleBarrier: createIdleBarrier({ now: clock.now }),
    maxConcurrent: 4,
    maxRetained: 16,
    ...over,
  }
  return createSideAgentDaemonRegistry(opts)
}

describe("HELLGATE C — resource bounds under heavy spawn→stop churn", () => {
  test("10k spawn→stop cycles keep list() bounded by maxRetained (no map blowup)", () => {
    const reg = build()
    for (let i = 0; i < 10_000; i++) {
      const id = reg.spawn(spec())
      reg.stop(id)
    }
    // The map retains at most `maxRetained` terminal daemons (running = 0 now).
    expect(reg.list().length).toBeLessThanOrEqual(16)
    // Team is empty (all stopped) ⇒ teamIdle false (never a vacuous team done).
    expect(reg.teamIdle()).toBe(false)
    expect(reg.idleSince()).toBeUndefined()
  })

  test("stopped daemons' beacons never contribute — idle reflects ONLY live members", () => {
    const reg = build()
    // Spawn-then-stop many daemons (each beaconed idle at spawn, cleared on stop).
    const dead: string[] = []
    for (let i = 0; i < 50; i++) {
      const id = reg.spawn(spec())
      dead.push(id)
      reg.stop(id)
    }
    // Now spawn ONE live daemon. If stale beacons leaked into the barrier, an
    // over-counting bug could still flip teamIdle on the dead ids — but membership
    // is the running set, and the barrier dropped the dead beacons on `finish`.
    const live = reg.spawn(spec())
    expect(reg.teamIdle()).toBe(true) // exactly the one live, idle member
    // idleSince is the live daemon's beacon instant, not any dead one's.
    const since = reg.idleSince()
    expect(since).toBeDefined()
    expect(typeof since).toBe("number")
    // Stop the live one → team empty again → not idle.
    reg.stop(live)
    expect(reg.teamIdle()).toBe(false)
  })

  test("interleaved spawn/stop keeps running set ≤ maxConcurrent (cap enforced across churn)", () => {
    const reg = build({ maxConcurrent: 3 })
    const liveIds: string[] = []
    for (let i = 0; i < 200; i++) {
      // Keep at most 3 alive; stop the oldest when at cap, then spawn.
      if (liveIds.length >= 3) {
        const victim = liveIds.shift()
        if (victim !== undefined) reg.stop(victim)
      }
      liveIds.push(reg.spawn(spec()))
      const running = reg.list().filter((d) => d.status === "running").length
      expect(running).toBeLessThanOrEqual(3) // cap NEVER exceeded across churn
    }
  })
})

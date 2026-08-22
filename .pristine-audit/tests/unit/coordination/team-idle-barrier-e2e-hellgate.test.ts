/**
 * E2E hellgate — Capability C: team-idle barrier over the in-memory port.
 *
 * Plan: docs/plans/multiagent-coordination.md §2.C.
 *
 * Drives `createIdleBarrier()` (the thin `IdleBarrierPort` with an injected
 * clock) with 3 members beaconing one-by-one as a virtual clock advances:
 *  - `teamIdle` flips to true EXACTLY when the LAST member beacons;
 *  - `idleSince` (release ts) is the LAST member's timestamp;
 *  - one member re-activating flips the barrier back to false.
 *
 * No `Date.now()` — the clock is fully injected and advanced explicitly.
 */

import { describe, expect, it } from "bun:test"
import { createIdleBarrier } from "@/subagent/coordination/idle-barrier"

/** A virtual, monotone, injected clock — the ONLY time source for the barrier. */
const virtualClock = (start = 0) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe("team-idle barrier e2e — 3 members beacon one-by-one", () => {
  it("flips to idle EXACTLY when the last member beacons; release ts = last", () => {
    const clock = virtualClock(1000)
    const barrier = createIdleBarrier({ now: clock.now })
    const members = ["alpha", "beta", "gamma"]

    // t=1000 — alpha idles.
    barrier.beacon("alpha")
    expect(barrier.teamIdle(members)).toBe(false)
    expect(barrier.idleSince(members)).toBeUndefined()

    // t=1100 — beta idles.
    clock.advance(100)
    barrier.beacon("beta")
    expect(barrier.teamIdle(members)).toBe(false)
    expect(barrier.idleSince(members)).toBeUndefined()

    // t=1250 — gamma (LAST) idles ⇒ barrier releases NOW.
    clock.advance(150)
    barrier.beacon("gamma")
    expect(barrier.teamIdle(members)).toBe(true)
    // release ts = the moment the last member went idle = 1250 (the max).
    expect(barrier.idleSince(members)).toBe(1250)
  })

  it("a member re-activating flips the barrier back to false", () => {
    const clock = virtualClock(0)
    const barrier = createIdleBarrier({ now: clock.now })
    const members = ["a", "b"]

    barrier.beacon("a")
    clock.advance(10)
    barrier.beacon("b")
    expect(barrier.teamIdle(members)).toBe(true)
    expect(barrier.idleSince(members)).toBe(10)

    // b picks up work again — clears its beacon.
    barrier.reactivate("b")
    expect(barrier.teamIdle(members)).toBe(false)
    expect(barrier.idleSince(members)).toBeUndefined()

    // b finishes again later — barrier re-arms at the NEW timestamp.
    clock.advance(40) // t=50
    barrier.beacon("b")
    expect(barrier.teamIdle(members)).toBe(true)
    expect(barrier.idleSince(members)).toBe(50)
  })

  it("an unknown member's beacon does not flip a team barrier", () => {
    const clock = virtualClock(0)
    const barrier = createIdleBarrier({ now: clock.now })
    const members = ["a", "b"]

    barrier.beacon("a")
    clock.advance(5)
    barrier.beacon("stranger") // not in members
    expect(barrier.teamIdle(members)).toBe(false)
    expect(barrier.idleSince(members)).toBeUndefined()

    clock.advance(5)
    barrier.beacon("b")
    expect(barrier.teamIdle(members)).toBe(true)
    expect(barrier.idleSince(members)).toBe(10) // stranger's t=5 ignored
  })
})

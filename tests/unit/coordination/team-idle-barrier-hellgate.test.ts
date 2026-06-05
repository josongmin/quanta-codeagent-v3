/**
 * Hellgate — Capability C: team-idle barrier + idle beacon (PURE core).
 *
 * Plan: docs/plans/multiagent-coordination.md §2.C + §5.
 *
 * Adversarial pins on the pure predicate `teamIdle` / `idleSince` and the pure
 * beacon-list transforms `upsertBeacon` / `clearBeacon`:
 *  - partial beacons ⇒ NOT idle;
 *  - ALL members beaconed ⇒ idle + `idleSince` = MAX across members (the
 *    barrier-release timestamp = the moment the LAST member went idle);
 *  - a member re-activating (`clearBeacon`) ⇒ NOT idle again;
 *  - an unknown-member beacon (id not in `members`) is IGNORED — a stray beacon
 *    NEVER flips the barrier;
 *  - empty `members` ⇒ documented choice `false` (no team ⇒ no barrier-release);
 *  - `upsertBeacon` replaces a member's beacon (latest `idleSince` wins per
 *    agent) — no duplicate entries.
 */

import { describe, expect, it } from "bun:test"
import {
  clearBeacon,
  type IdleBeacon,
  idleSince,
  teamIdle,
  upsertBeacon,
} from "@/subagent/coordination/idle-barrier"

const beacon = (agentId: string, idleSince: number): IdleBeacon => ({ agentId, idleSince })

describe("team-idle barrier — teamIdle predicate", () => {
  it("partial beacons ⇒ NOT idle", () => {
    const members = ["a", "b", "c"]
    const beacons = [beacon("a", 10), beacon("b", 20)]
    expect(teamIdle(beacons, members)).toBe(false)
    expect(idleSince(beacons, members)).toBeUndefined()
  })

  it("ALL members beaconed ⇒ idle, idleSince = MAX across members", () => {
    const members = ["a", "b", "c"]
    const beacons = [beacon("a", 10), beacon("b", 30), beacon("c", 20)]
    expect(teamIdle(beacons, members)).toBe(true)
    // release ts = the moment the LAST member went idle = max idleSince.
    expect(idleSince(beacons, members)).toBe(30)
  })

  it("no beacons at all ⇒ NOT idle", () => {
    expect(teamIdle([], ["a", "b"])).toBe(false)
    expect(idleSince([], ["a", "b"])).toBeUndefined()
  })

  it("single member, single beacon ⇒ idle + that timestamp", () => {
    expect(teamIdle([beacon("solo", 7)], ["solo"])).toBe(true)
    expect(idleSince([beacon("solo", 7)], ["solo"])).toBe(7)
  })
})

describe("team-idle barrier — empty members (documented choice = false)", () => {
  it("empty members ⇒ NOT idle (no team ⇒ no barrier-release)", () => {
    expect(teamIdle([], [])).toBe(false)
    expect(teamIdle([beacon("ghost", 1)], [])).toBe(false)
    expect(idleSince([], [])).toBeUndefined()
    expect(idleSince([beacon("ghost", 1)], [])).toBeUndefined()
  })
})

describe("team-idle barrier — unknown-member beacon ignored", () => {
  it("a stray beacon (id not in members) NEVER flips the barrier", () => {
    const members = ["a", "b"]
    // a + b beaconed AND a stray "x" — still idle, stray ignored.
    const beacons = [beacon("a", 5), beacon("x", 999), beacon("b", 6)]
    expect(teamIdle(beacons, members)).toBe(true)
    // idleSince ignores the stray (999) — max over MEMBERS only.
    expect(idleSince(beacons, members)).toBe(6)
  })

  it("only a stray beacon ⇒ NOT idle (members unbeaconed)", () => {
    expect(teamIdle([beacon("x", 999)], ["a", "b"])).toBe(false)
    expect(idleSince([beacon("x", 999)], ["a", "b"])).toBeUndefined()
  })
})

describe("team-idle barrier — clearBeacon (member re-activates)", () => {
  it("re-activating a member drops its beacon ⇒ NOT idle again", () => {
    const members = ["a", "b"]
    const idle = [beacon("a", 10), beacon("b", 20)]
    expect(teamIdle(idle, members)).toBe(true)

    const reactivated = clearBeacon(idle, "b")
    expect(teamIdle(reactivated, members)).toBe(false)
    expect(idleSince(reactivated, members)).toBeUndefined()
    // a's beacon survives.
    expect(reactivated).toEqual([beacon("a", 10)])
  })

  it("is pure — does not mutate the input array", () => {
    const idle = [beacon("a", 10), beacon("b", 20)]
    const out = clearBeacon(idle, "a")
    expect(idle).toEqual([beacon("a", 10), beacon("b", 20)])
    expect(out).toEqual([beacon("b", 20)])
    expect(out).not.toBe(idle)
  })

  it("clearing an unknown id ⇒ unchanged content, new array", () => {
    const idle = [beacon("a", 10)]
    const out = clearBeacon(idle, "nope")
    expect(out).toEqual([beacon("a", 10)])
    expect(out).not.toBe(idle)
  })
})

describe("team-idle barrier — upsertBeacon (latest per agent, no dup)", () => {
  it("inserts a new member's beacon", () => {
    const out = upsertBeacon([beacon("a", 10)], beacon("b", 20))
    expect(out).toEqual([beacon("a", 10), beacon("b", 20)])
  })

  it("REPLACES an existing member's beacon (latest idleSince wins) — no dup", () => {
    const out = upsertBeacon([beacon("a", 10), beacon("b", 20)], beacon("a", 99))
    // exactly one entry per agent.
    expect(out.filter((x) => x.agentId === "a")).toHaveLength(1)
    expect(out.find((x) => x.agentId === "a")?.idleSince).toBe(99)
    expect(out.find((x) => x.agentId === "b")?.idleSince).toBe(20)
  })

  it("is pure — does not mutate the input array", () => {
    const before = [beacon("a", 10)]
    const out = upsertBeacon(before, beacon("a", 50))
    expect(before).toEqual([beacon("a", 10)])
    expect(out).not.toBe(before)
  })

  it("a re-beacon then teamIdle uses the LATEST timestamp", () => {
    const members = ["a", "b"]
    let beacons: IdleBeacon[] = [beacon("a", 10), beacon("b", 20)]
    expect(idleSince(beacons, members)).toBe(20)
    // a goes active then idle again later at t=100 (replace, not append).
    beacons = upsertBeacon(beacons, beacon("a", 100))
    expect(beacons.filter((x) => x.agentId === "a")).toHaveLength(1)
    expect(idleSince(beacons, members)).toBe(100)
  })
})

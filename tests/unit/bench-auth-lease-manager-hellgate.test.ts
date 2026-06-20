/**
 * Hellgate — T-2 AuthLeaseManager (jun-20 multi-auth fleet).
 *
 * The whole feature is throttle ISOLATION. These tests pin the invariants that,
 * if broken, silently re-create the single-account confound:
 *  - slots can't leak across requeue / throw / lost box,
 *  - a 429 on A cools down ONLY A; B keeps draining,
 *  - a cooled-down account is NOT re-picked until cooldown expires,
 *  - tie-break is deterministic (preferred > least-loaded > manifest order).
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { AuthLeaseManager } from "@/apps/bench/auth-pool"
import type { AuthPoolEntry } from "@/apps/bench/auth-pool"

const ENTRIES: readonly AuthPoolEntry[] = [
  { label: "a", authFile: "/a.json", maxParallel: 6, maxBoxes: 1, cooldownBaseSec: 10 },
  { label: "b", authFile: "/b.json", maxParallel: 6, maxBoxes: 1, cooldownBaseSec: 10 },
]

// Controllable clock so cooldown windows are deterministic.
let clock = 0
const mgrOf = (entries: readonly AuthPoolEntry[] = ENTRIES) =>
  new AuthLeaseManager(entries, { now: () => clock })

beforeEach(() => {
  clock = 1_000_000
})

const ok = { rateLimited: false, lostBox: false, completed: true } as const
const r429 = { rateLimited: true, lostBox: false, completed: false } as const

describe("T-2 capacity", () => {
  test("grantedSlots never exceeds residual maxParallel", () => {
    const m = mgrOf([{ label: "a", authFile: "/a.json", maxParallel: 4 }])
    const lease = m.acquire({ requestedSlots: 10, runId: "r1" })
    expect(lease?.grantedSlots).toBe(4)
  })

  test("account cannot be oversubscribed past maxParallel across leases", () => {
    const m = mgrOf([{ label: "a", authFile: "/a.json", maxParallel: 6 }]) // no maxBoxes cap
    const l1 = m.acquire({ requestedSlots: 4, runId: "r1" })
    const l2 = m.acquire({ requestedSlots: 4, runId: "r2" })
    expect(l1?.grantedSlots).toBe(4)
    expect(l2?.grantedSlots).toBe(2) // only 2 residual
    const l3 = m.acquire({ requestedSlots: 1, runId: "r3" })
    expect(l3).toBeNull() // saturated
  })

  test("maxBoxes caps concurrent leases even when slots remain", () => {
    const m = mgrOf([{ label: "a", authFile: "/a.json", maxParallel: 6, maxBoxes: 1 }])
    const l1 = m.acquire({ requestedSlots: 1, runId: "r1" })
    expect(l1).not.toBeNull()
    // 5 slots free, but the single box budget is taken ⇒ no second lease
    expect(m.acquire({ requestedSlots: 1, runId: "r2" })).toBeNull()
  })
})

describe("T-2 release accounting (no leak)", () => {
  test("release returns slots so the account is leasable again", () => {
    const m = mgrOf([{ label: "a", authFile: "/a.json", maxParallel: 6, maxBoxes: 1 }])
    const l1 = m.acquire({ requestedSlots: 6, runId: "r1" })
    expect(m.acquire({ requestedSlots: 1, runId: "r2" })).toBeNull()
    l1?.release(ok)
    const l3 = m.acquire({ requestedSlots: 6, runId: "r3" })
    expect(l3?.grantedSlots).toBe(6) // full capacity restored
  })

  test("lost box still returns slots (requeue path can't leak)", () => {
    const m = mgrOf([{ label: "a", authFile: "/a.json", maxParallel: 6, maxBoxes: 1 }])
    const l1 = m.acquire({ requestedSlots: 6, runId: "r1" })
    l1?.release({ rateLimited: false, lostBox: true, completed: false })
    expect(m.snapshot()[0]?.activeSlots).toBe(0)
    expect(m.snapshot()[0]?.activeBoxes).toBe(0)
  })

  test("double-release is idempotent (no negative / no double-return)", () => {
    const m = mgrOf([{ label: "a", authFile: "/a.json", maxParallel: 6 }])
    const l1 = m.acquire({ requestedSlots: 3, runId: "r1" })
    const l2 = m.acquire({ requestedSlots: 3, runId: "r2" })
    l1?.release(ok)
    l1?.release(ok) // second call must be a no-op
    // l2 still holds 3 — a buggy double-return would drop activeSlots below 3
    expect(m.snapshot()[0]?.activeSlots).toBe(3)
    l2?.release(ok)
    expect(m.snapshot()[0]?.activeSlots).toBe(0)
  })
})

describe("T-2 per-account cooldown isolation", () => {
  test("429 on A cools down ONLY A; B keeps leasing", () => {
    const m = mgrOf()
    const la = m.acquire({ requestedSlots: 1, runId: "r1", preferredAccountLabel: "a" })
    expect(la?.accountLabel).toBe("a")
    la?.release(r429)
    // A is cooling now — even explicitly preferring A must route to B (unaffected).
    const lb = m.acquire({ requestedSlots: 1, runId: "r2", preferredAccountLabel: "a" })
    expect(lb?.accountLabel).toBe("b")
    // And A is genuinely cooling, not merely busy: requesting it alone yields null
    // once B is also full.
    lb?.release(ok)
    const repick = m.acquire({ requestedSlots: 1, runId: "r3", preferredAccountLabel: "a" })
    expect(repick?.accountLabel).not.toBe("a") // still cooling
  })

  test("a cooled-down account is NOT re-picked until cooldown expires", () => {
    const m = mgrOf([{ label: "solo", authFile: "/s.json", maxParallel: 6, cooldownBaseSec: 10 }])
    const l1 = m.acquire({ requestedSlots: 1, runId: "r1" })
    l1?.release(r429)
    // base 10s ⇒ cooling; nothing schedulable right now
    expect(m.acquire({ requestedSlots: 1, runId: "r2" })).toBeNull()
    expect(m.hasSchedulableAccount()).toBe(false)
    expect(m.nextReadyAt()).toBe(clock + 10_000)
    // advance past cooldown ⇒ ready again
    clock += 10_001
    expect(m.acquire({ requestedSlots: 1, runId: "r3" })).not.toBeNull()
  })

  test("exponential backoff grows with consecutive 429s, completed resets it", () => {
    const m = mgrOf([{ label: "solo", authFile: "/s.json", maxParallel: 6, cooldownBaseSec: 10 }])
    // 1st 429 ⇒ 10s
    m.acquire({ requestedSlots: 1, runId: "r1" })?.release(r429)
    expect(m.nextReadyAt()).toBe(clock + 10_000)
    clock += 10_001
    // 2nd consecutive 429 ⇒ 20s
    m.acquire({ requestedSlots: 1, runId: "r2" })?.release(r429)
    expect(m.nextReadyAt()).toBe(clock + 20_000)
    clock += 20_001
    // a clean completion resets the streak ⇒ next 429 is back to base 10s
    m.acquire({ requestedSlots: 1, runId: "r3" })?.release(ok)
    m.acquire({ requestedSlots: 1, runId: "r4" })?.release(r429)
    expect(m.nextReadyAt()).toBe(clock + 10_000)
  })
})

describe("T-2 deterministic tie-break", () => {
  test("preferred account wins when ready", () => {
    const m = mgrOf()
    expect(m.acquire({ requestedSlots: 1, runId: "r1", preferredAccountLabel: "b" })?.accountLabel).toBe(
      "b",
    )
  })

  test("preferred but saturated ⇒ falls through to another ready account", () => {
    const m = mgrOf([
      { label: "a", authFile: "/a.json", maxParallel: 1, maxBoxes: 1 },
      { label: "b", authFile: "/b.json", maxParallel: 6 },
    ])
    m.acquire({ requestedSlots: 1, runId: "r1", preferredAccountLabel: "a" }) // fills a
    const l = m.acquire({ requestedSlots: 1, runId: "r2", preferredAccountLabel: "a" })
    expect(l?.accountLabel).toBe("b")
  })

  test("no preference ⇒ least-loaded, ties resolve by manifest order", () => {
    const m = mgrOf()
    // both empty ⇒ first manifest entry "a"
    const l1 = m.acquire({ requestedSlots: 3, runId: "r1" })
    expect(l1?.accountLabel).toBe("a")
    // now a is more loaded ⇒ b is least-loaded
    const l2 = m.acquire({ requestedSlots: 1, runId: "r2" })
    expect(l2?.accountLabel).toBe("b")
  })

  test("disabled account is never leased", () => {
    const m = mgrOf([
      { label: "off", authFile: "/o.json", maxParallel: 6, disabled: true },
      { label: "on", authFile: "/n.json", maxParallel: 6 },
    ])
    for (let i = 0; i < 5; i++) {
      const l = m.acquire({ requestedSlots: 1, runId: `r${i}`, preferredAccountLabel: "off" })
      expect(l?.accountLabel).toBe("on")
    }
  })

  test("all accounts disabled ⇒ acquire null and not schedulable", () => {
    const m = mgrOf([{ label: "off", authFile: "/o.json", maxParallel: 6, disabled: true }])
    expect(m.acquire({ requestedSlots: 1, runId: "r1" })).toBeNull()
    expect(m.hasSchedulableAccount()).toBe(false)
    expect(m.nextReadyAt()).toBeUndefined() // disabled ≠ cooling; nothing to wait for
  })
})

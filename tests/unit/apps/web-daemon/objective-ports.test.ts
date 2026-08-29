/**
 * GOAL-08 round 4 — the daemon runtime ports expose the SAME attempt-slot
 * instance the session host claims (the wake composer's fail-stop gate reads
 * it); a non-slot value is dropped, an absent objective yields no port.
 */

import { describe, expect, test } from "bun:test"
import { objectivePorts } from "@/apps/web-daemon/runtime-factory"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"

describe("GOAL-08 round 4 — daemon objectivePorts", () => {
  test("same slot instance, same authority", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    const slot = createObjectiveAttemptSlot()
    const ports = objectivePorts(authority, slot)
    expect(ports.objectiveAuthority).toBe(authority)
    expect(ports.objectiveAttemptSlot).toBe(slot)
  })
  test("no objective ⇒ no ports; a non-slot value is not exposed", () => {
    expect(objectivePorts(undefined, undefined)).toEqual({})
    const authority = createObjectiveAuthority({ now: () => 1 })
    expect(objectivePorts(authority, { not: "a slot" })).toEqual({ objectiveAuthority: authority })
  })
})

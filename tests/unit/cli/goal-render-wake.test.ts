/**
 * GOAL-06 — the /goal report renders the wake controller's TYPED scheduling
 * decision (the PTY suite asserts this line instead of waiting for a fire).
 */

import { describe, expect, test } from "bun:test"
import { renderGoalDomain } from "@/apps/cli/slash/goal-render"
import { createObjectiveAuthority } from "@/objective"

describe("GOAL-06 — /goal report wake line", () => {
  test("armed / idle+reason / stopped / not composed", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "ship", successCriteria: ["c"] })
    const domain = authority.readDomain("t")
    expect(renderGoalDomain(domain, 1, { kind: "armed", delayMs: 15_000 })).toContain(
      "wake: armed in 15s",
    )
    expect(renderGoalDomain(domain, 1, { kind: "armed", delayMs: 900_000 })).toContain(
      "wake: armed in 15m",
    )
    expect(
      renderGoalDomain(domain, 1, { kind: "idle", skipReason: "validation-contract-missing" }),
    ).toContain("wake: idle (validation-contract-missing)")
    expect(renderGoalDomain(domain, 1, { kind: "pending", delayMs: 15_000 })).toContain(
      "wake: pending 15s quiet",
    )
    expect(renderGoalDomain(domain, 1, { kind: "stopped" })).toContain("wake: stopped")
    expect(renderGoalDomain(domain, 1, undefined)).toContain("wake: not composed")
    expect(renderGoalDomain(domain, 1)).toContain("wake: not composed")
  })

  test("GOAL-08 round 3 — a fail-stopped attempt slot renders its reason", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "ship", successCriteria: ["c"] })
    expect(
      renderGoalDomain(authority.readDomain("t"), 1, {
        kind: "idle",
        skipReason: "attempt-slot-fail-stopped",
        detail: "disk full",
      }),
    ).toContain("wake: idle (attempt-slot-fail-stopped: disk full)")
  })
})

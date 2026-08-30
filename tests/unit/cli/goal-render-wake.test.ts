/**
 * GOAL-06 — the /goal report renders the wake controller's TYPED scheduling
 * decision (the PTY suite asserts this line instead of waiting for a fire).
 */

import { describe, expect, test } from "bun:test"
import { renderGoalDomain, renderWakeStatus } from "@/apps/cli/slash/goal-render"
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

/**
 * W3 — the wake decision computes a retry instant and a limiting bound for
 * several skips, and `status()` used to discard both. The line could say
 * "idle (usage-limited)" without saying whether that meant thirty seconds or
 * four hours — the operator's actual question. Same defect as the
 * `budget.limitedBy` one fixed earlier today, in a second place.
 */
describe("W3 — an idle wake line carries the detail the decision computed", () => {
  test("it names the retry instant when there is one", () => {
    const line = renderWakeStatus(
      { kind: "idle", skipReason: "usage-limited", retryAt: 90_000 },
      60_000,
    )

    expect(line).toContain("usage-limited")
    expect(line).toContain("retry in 30s")
  })

  test("it names the limiting bound when there is one", () => {
    const line = renderWakeStatus({
      kind: "idle",
      skipReason: "autonomous-turn-cap",
      limitedBy: "product-hard-cap",
    })

    expect(line).toContain("product-hard-cap")
  })

  test("PAIRED CONTROL — a bare idle line is byte-identical", () => {
    expect(renderWakeStatus({ kind: "idle", skipReason: "no-goal" })).toBe("wake: idle (no-goal)")
  })
})

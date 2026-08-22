/**
 * Pillar D ratchet — experiments ≠ features.
 *
 * Enforces the experiment LIFECYCLE so dead A/B knobs cannot rot in place:
 *  - every registry row is well-formed (owner + hypothesis + valid ISO expiry);
 *  - NO `active` experiment is past its expiry (the burn-down — forces a
 *    graduate-or-retire decision on stale flags);
 *  - the guard has TEETH (a synthetic active+expired row makes the predicate fire);
 *  - retired experiments are surfaced for deletion (the follow-up sweep worklist).
 *
 * Determinism: `today` is a fixed literal here — the production helpers are pure
 * and never call Date.now()/new Date(), so this ratchet is reproducible.
 */

import { describe, expect, test } from "bun:test"
import type { ExperimentMeta } from "@/config/knob-schema/contracts"
import {
  EXPERIMENTS,
  type ExperimentEntry,
  experimentByKnob,
  expiredActiveExperiments,
  retiredKnobIds,
} from "@/runner/batch/eval/kernel/experiments"

/** Fixed "now" for the burn-down. Bump this literal to re-run the burn-down at a
 *  later date — NEVER replace with Date.now()/new Date() (keeps the ratchet
 *  deterministic). */
const TODAY = "2026-06-27"

/** Strict ISO YYYY-MM-DD shape, and a real calendar date when parsed. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  // Round-trip through Date to reject e.g. 2026-13-40 (this is test-only date
  // VALIDATION, not clock reading — the production helpers stay pure).
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

describe("experiment lifecycle registry — well-formedness", () => {
  test("registry is non-empty (seeded with real entries)", () => {
    expect(EXPERIMENTS.length).toBeGreaterThan(0)
  })

  test("every entry has a non-empty owner, hypothesis, and valid ISO expiry", () => {
    for (const { knobId, meta } of EXPERIMENTS) {
      expect(knobId.length, `knobId for ${knobId}`).toBeGreaterThan(0)
      expect(meta.owner.trim().length, `owner for ${knobId}`).toBeGreaterThan(0)
      expect(meta.hypothesis.trim().length, `hypothesis for ${knobId}`).toBeGreaterThan(0)
      expect(isValidIsoDate(meta.expiry), `expiry "${meta.expiry}" for ${knobId}`).toBe(true)
      expect(["active", "graduated", "retired"]).toContain(meta.status)
    }
  })

  test("knob ids are unique (no duplicate registry rows)", () => {
    const ids = EXPERIMENTS.map((e) => e.knobId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("experimentByKnob resolves a known knob and returns undefined otherwise", () => {
    expect(experimentByKnob("verify-select")?.status).toBe("retired")
    expect(experimentByKnob("repro-vote")?.status).toBe("active")
    expect(experimentByKnob("not-a-real-knob")).toBeUndefined()
  })
})

describe("experiment lifecycle ratchet — the burn-down", () => {
  test("NO active experiment is past its expiry as of TODAY", () => {
    const overdue = expiredActiveExperiments(TODAY)
    expect(
      overdue,
      `expired active experiments (must graduate→feature or retire→delete): ${overdue
        .map((e) => `${e.knobId}@${e.meta.expiry}`)
        .join(", ")}`,
    ).toEqual([])
  })

  test("the registry demonstrates BOTH lifecycle states", () => {
    const statuses = new Set(EXPERIMENTS.map((e) => e.meta.status))
    expect(statuses.has("active")).toBe(true)
    expect(statuses.has("retired")).toBe(true)
  })
})

describe("experiment lifecycle ratchet — red on injection (teeth)", () => {
  test("a synthetic active+expired entry makes expiredActiveExperiments fire", () => {
    const poisoned: ExperimentEntry[] = [
      {
        knobId: "rotting-experiment",
        meta: {
          owner: "nobody",
          hypothesis: "left to rot past its expiry",
          expiry: "2020-01-01",
          status: "active",
        } satisfies ExperimentMeta,
      },
    ]
    const overdue = expiredActiveExperiments(TODAY, poisoned)
    expect(overdue.map((e) => e.knobId)).toEqual(["rotting-experiment"])
  })

  test("an expired but RETIRED entry does NOT fire (only active counts)", () => {
    const retiredButExpired: ExperimentEntry[] = [
      {
        knobId: "already-retired",
        meta: { owner: "x", hypothesis: "y", expiry: "2020-01-01", status: "retired" },
      },
    ]
    expect(expiredActiveExperiments(TODAY, retiredButExpired)).toEqual([])
  })

  test("an active entry expiring EXACTLY today does not fire (strict <)", () => {
    const expiringToday: ExperimentEntry[] = [
      {
        knobId: "expires-today",
        meta: { owner: "x", hypothesis: "y", expiry: TODAY, status: "active" },
      },
    ]
    expect(expiredActiveExperiments(TODAY, expiringToday)).toEqual([])
  })
})

describe("experiment lifecycle — retirement sweep worklist", () => {
  test("retiredKnobIds lists every retired knob for deletion", () => {
    const retired = retiredKnobIds()
    expect(retired).toContain("verify-select")
    expect(retired).toContain("verify-select-repro")
    expect(retired).toContain("verify-select-regression")
    // exactly the retired rows, nothing active leaks in
    for (const id of retired) {
      expect(experimentByKnob(id)?.status).toBe("retired")
    }
  })

  test("retiredKnobIds excludes active experiments", () => {
    expect(retiredKnobIds()).not.toContain("repro-vote")
  })
})

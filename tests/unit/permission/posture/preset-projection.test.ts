/**
 * RFC-05 E1 — NAMED-PRESET PROJECTION and the offered-preset surface.
 *
 * Proves: each offered preset's canonical record projects back to its own name;
 * a record matching no offered preset projects to `null` ("custom"); the PARKED
 * `full-access` rung is never offered and never projected to a label; the
 * projection is unambiguous (at most one preset matches any record).
 */

import { describe, expect, test } from "bun:test"
import { APPROVAL_LADDER } from "../../../../src/permission/approval-ladder"
import { availablePresets } from "../../../../src/permission/posture/availability"
import {
  applyPreset,
  OFFERED_PRESETS,
  presetPatch,
  projectPreset,
} from "../../../../src/permission/posture/presets"
import { allCompleteRecords, nthCompleteRecord } from "./fixtures"

describe("availablePresets — parks full-access, excludes custom", () => {
  test("offers exactly the non-parked rungs", () => {
    expect([...availablePresets()]).toEqual(["read-only", "auto", "granular", "guardian-approvals"])
  })

  test("never offers full-access (PARKED) or custom", () => {
    expect(availablePresets()).not.toContain("full-access")
    expect(availablePresets()).not.toContain("custom")
  })
})

describe("projectPreset — round-trips each offered preset", () => {
  test("each offered preset's canonical ThreadPermission projects to its own name", () => {
    for (const preset of OFFERED_PRESETS) {
      expect(projectPreset(APPROVAL_LADDER[preset])).toBe(preset)
    }
  })

  test("applying a preset then projecting yields that preset (askOutsidePlan-agnostic)", () => {
    const base = nthCompleteRecord(10)
    for (const preset of OFFERED_PRESETS) {
      const next = applyPreset(base, preset)
      expect(projectPreset(next.threadPermission)).toBe(preset)
    }
  })
})

describe("projectPreset — custom when no offered preset matches", () => {
  test("the PARKED full-access record projects to null (no label leaked)", () => {
    expect(projectPreset(APPROVAL_LADDER["full-access"])).toBeNull()
  })

  test("an off-table combination projects to null (custom)", () => {
    expect(
      projectPreset({
        approvalPolicy: "on-failure",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "read-only" },
      }),
    ).toBeNull()
  })
})

describe("projection is unambiguous over all complete records", () => {
  test("no ThreadPermission matches more than one offered preset", () => {
    for (const record of allCompleteRecords()) {
      const matches = OFFERED_PRESETS.filter((p) => {
        const patch = presetPatch(p)
        const tp = record.threadPermission
        return (
          tp.approvalPolicy === patch.approvalPolicy &&
          tp.approvalsReviewer === patch.approvalsReviewer &&
          JSON.stringify(tp.sandboxPolicy) === JSON.stringify(patch.sandboxPolicy)
        )
      })
      expect(matches.length).toBeLessThanOrEqual(1)
    }
  })
})

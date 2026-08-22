/**
 * RFC-05 E1 — LEGACY-ABSENCE MIGRATION to current behavior.
 *
 * Proves: a stored record missing the NEW posture fields migrates to EXACT
 * current behavior — the question knob to unrestricted (current behavior has no
 * outside-plan gate), the revision to the initial value, the requested patch to
 * empty; provided values pass through verbatim; no inference is replayed. The
 * existing ThreadPermission is preserved.
 */

import { describe, expect, test } from "bun:test"
import { APPROVAL_LADDER } from "../../../../src/permission/approval-ladder"
import type { ThreadPermission } from "../../../../src/permission/permission-store"
import { migrateLegacy } from "../../../../src/permission/posture/presets"
import {
  CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN,
  INITIAL_REVISION,
} from "../../../../src/permission/posture/types"

const TP: ThreadPermission = APPROVAL_LADDER.auto

describe("migrateLegacy — missing new fields map to current behavior", () => {
  test("absent askOutsidePlan -> current behavior (unrestricted / true)", () => {
    const migrated = migrateLegacy({ threadPermission: TP })
    expect(migrated.record.askOutsidePlan).toBe(CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN)
    expect(migrated.record.askOutsidePlan).toBe(true)
  })

  test("absent revision -> INITIAL_REVISION", () => {
    expect(migrateLegacy({ threadPermission: TP }).revision).toBe(INITIAL_REVISION)
  })

  test("absent requestedPatch -> empty patch", () => {
    expect(migrateLegacy({ threadPermission: TP }).requested.patch).toEqual({})
  })

  test("preserves the existing ThreadPermission verbatim", () => {
    expect(migrateLegacy({ threadPermission: TP }).record.threadPermission).toEqual(TP)
  })

  test("requested.preset reflects the existing record's projection", () => {
    // `auto` rung -> projects to the `auto` preset.
    expect(migrateLegacy({ threadPermission: APPROVAL_LADDER.auto }).requested.preset).toBe("auto")
    // full-access rung (parked) -> custom (null).
    expect(
      migrateLegacy({ threadPermission: APPROVAL_LADDER["full-access"] }).requested.preset,
    ).toBeNull()
  })
})

describe("migrateLegacy — provided values pass through (no override)", () => {
  test("explicit askOutsidePlan:false is honored (not forced to current behavior)", () => {
    expect(
      migrateLegacy({ threadPermission: TP, askOutsidePlan: false }).record.askOutsidePlan,
    ).toBe(false)
  })

  test("explicit revision + requestedPatch pass through", () => {
    const migrated = migrateLegacy({
      threadPermission: TP,
      revision: 9,
      requestedPatch: { approvalPolicy: "always" },
    })
    expect(migrated.revision).toBe(9)
    expect(migrated.requested.patch).toEqual({ approvalPolicy: "always" })
  })
})

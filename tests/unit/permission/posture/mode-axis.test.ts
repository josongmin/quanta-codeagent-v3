/**
 * RFC-05 E2b — the posture `effectiveMode` axis (canonical-authority correction).
 *
 * E1/E2 modeled reviewerRoute + threadPermission + askOutsidePlan but OMITTED
 * the frozen canonical field `ResolvedPermissionPosture.effectiveMode:
 * PermissionMode`. Permission `evaluate()` gates on `ctx.mode: PermissionMode`
 * (`policy.ts`: bypass/acceptEdits/auto), so the posture authority cannot become
 * the mode SSOT until it carries `effectiveMode`. This packet adds `mode` as a
 * first-class posture axis, reusing the EXISTING `PermissionMode` union (NO new
 * enum value, NO new discriminant).
 *
 * RED rails pinned here (fail to compile/assert on the un-corrected model):
 *   (a) `EffectivePosture` cannot express a `PermissionMode` — no `effectiveMode`
 *       field, so the canonical-conformance assertion cannot be written;
 *   (b) a patch that sets `mode` drops it (lossy) — `applyPatch`/`toCustomPatch`
 *       do not carry the mode axis;
 *   (c) the managed policy cannot clamp/force the effective mode — `resolveEffective`
 *       has no managed-mode input.
 *
 * Every invariant carries a red-on-injection note so the test is non-vacuous.
 */

import { describe, expect, test } from "bun:test"
import {
  buildResolvedPosture,
  resolveEffective,
} from "../../../../src/permission/posture/availability"
import {
  applyPatch,
  applyPreset,
  migrateLegacy,
  presetPatch,
  toCustomPatch,
} from "../../../../src/permission/posture/presets"
import {
  CURRENT_BEHAVIOR_MODE,
  type EffectivePosture,
  type PostureRecord,
  type ResolvedPermissionPosture,
  type ReviewerAvailability,
} from "../../../../src/permission/posture/types"
import { ALL_PERMISSION_MODES, type PermissionMode } from "../../../../src/permission/types"

const AVAIL: ReviewerAvailability = { hasAutoReview: false, hasGuardianReview: false }

const recordWithMode = (mode: PermissionMode): PostureRecord => ({
  threadPermission: {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "read-only" },
  },
  askOutsidePlan: true,
  mode,
})

describe("RFC-05 E2b — effectiveMode is a first-class posture axis (RED rail a)", () => {
  test("EffectivePosture can express every PermissionMode (canonical conformance)", () => {
    // Canonical-conformance: the resolved effective view MUST carry a
    // PermissionMode. RED before the fix: `EffectivePosture` has no
    // `effectiveMode` field, so this reference does not type-check.
    for (const mode of ALL_PERMISSION_MODES) {
      const effective: EffectivePosture = resolveEffective(recordWithMode(mode), AVAIL)
      expect(effective.effectiveMode).toBe(mode)
    }
  })

  test("the resolved posture surfaces effectiveMode from the record's mode", () => {
    const resolved: ResolvedPermissionPosture = buildResolvedPosture({
      record: recordWithMode("acceptEdits"),
      revision: 1,
      requestedPatch: {},
      availability: AVAIL,
    })
    // RED-ON-INJECTION: drop `effectiveMode` from `resolveEffective`'s return ⇒
    // this is `undefined` ⇒ RED.
    expect(resolved.effective.effectiveMode).toBe("acceptEdits")
  })

  test("reuses the EXISTING PermissionMode union (no new enum value)", () => {
    // The axis is exactly the four existing modes — a drift-guard against a new
    // discriminant sneaking in through the posture model.
    expect([...ALL_PERMISSION_MODES]).toEqual(["default", "acceptEdits", "bypass", "auto"])
  })
})

describe("RFC-05 E2b — lossless patch algebra over the mode axis (RED rail b)", () => {
  test("a patch that sets mode is applied; an unmentioned mode is preserved", () => {
    const base = recordWithMode("default")
    // Setting mode wins.
    expect(applyPatch(base, { mode: "bypass" }).mode).toBe("bypass")
    // RED-ON-INJECTION: drop `mode: patch.mode ?? record.mode` from applyPatch ⇒
    // the set is a no-op / the preserve is dropped ⇒ RED on one of these.
    // Omitting mode preserves the base's mode verbatim.
    expect(applyPatch(base, { approvalPolicy: "always" }).mode).toBe("default")
    expect(applyPatch(recordWithMode("auto"), {}).mode).toBe("auto")
  })

  test("custom roundtrip carries the mode axis losslessly", () => {
    for (const mode of ALL_PERMISSION_MODES) {
      const r = recordWithMode(mode)
      // Apply the captured custom patch over a DISTINCT-mode base: a lossy
      // roundtrip would leak the base mode through.
      const roundTripped = applyPatch(recordWithMode("bypass"), toCustomPatch(r))
      expect(roundTripped.mode).toBe(mode)
    }
  })

  test("a named preset leaves the mode axis UNMENTIONED (preset != mode)", () => {
    // presetPatch is mode-agnostic: selecting a preset must never clobber mode.
    expect("mode" in presetPatch("read-only")).toBe(false)
    const withBypass = recordWithMode("bypass")
    expect(applyPreset(withBypass, "read-only").mode).toBe("bypass")
  })
})

describe("RFC-05 E2b — managed policy clamps/forces the effective mode (RED rail c)", () => {
  test("a managed mode clamp forces effectiveMode regardless of the record's mode", () => {
    const base = recordWithMode("bypass")
    // RED before the fix: resolveEffective has no third managed-mode argument.
    const clamped = resolveEffective(base, AVAIL, "default")
    // RED-ON-INJECTION: ignore the managedMode argument (return record.mode) ⇒
    // this is "bypass" ⇒ RED.
    expect(clamped.effectiveMode).toBe("default")
    // No clamp ⇒ the record's own mode stands (deterministic paired control).
    expect(resolveEffective(base, AVAIL).effectiveMode).toBe("bypass")
  })

  test("buildResolvedPosture threads the managed clamp into the effective view", () => {
    const resolved = buildResolvedPosture({
      record: recordWithMode("bypass"),
      revision: 4,
      requestedPatch: {},
      availability: AVAIL,
      managedMode: "acceptEdits",
    })
    expect(resolved.effective.effectiveMode).toBe("acceptEdits")
  })

  test("the clamp is deterministic (same inputs ⇒ same effectiveMode)", () => {
    const base = recordWithMode("auto")
    const a = resolveEffective(base, AVAIL, "default").effectiveMode
    const b = resolveEffective(base, AVAIL, "default").effectiveMode
    expect(a).toBe(b)
    expect(a).toBe("default")
  })
})

describe("RFC-05 E2b — legacy-absent mode migrates to current behavior", () => {
  test("migrateLegacy with no mode ⇒ CURRENT_BEHAVIOR_MODE (the existing default)", () => {
    const migrated = migrateLegacy({
      threadPermission: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "read-only" },
      },
    })
    // Current behavior is the base `default` mode — NOT a new blocking mode.
    expect(migrated.record.mode).toBe(CURRENT_BEHAVIOR_MODE)
    expect(migrated.record.mode).toBe("default")
  })

  test("an explicit legacy mode passes through verbatim (no override)", () => {
    const migrated = migrateLegacy({
      threadPermission: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "read-only" },
      },
      mode: "acceptEdits",
    })
    expect(migrated.record.mode).toBe("acceptEdits")
  })
})

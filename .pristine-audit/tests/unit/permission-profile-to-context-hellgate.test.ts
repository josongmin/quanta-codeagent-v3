/**
 * GAP2 hellgate — profile.approval.mode → PermissionContext.mode derive.
 *
 * Pins the pure mapper that derives the loop's live `PermissionContext.mode`
 * from a named `PermissionProfile`'s `approval` pillar. The intent is the
 * non-duplicating wire described in the deep map: the network axis is enforced
 * by the A1 dispatch-guard and the file-system axis is not dispatch-time
 * enforceable, so the only clean derive is approval → context-mode.
 *
 * Invariants:
 *   - `trusted`    (approval mode "auto")    ⇒ context mode "auto"
 *   - `restricted` (approval mode "always")  ⇒ context mode "default"
 *   - `default`    (approval mode "once")    ⇒ context mode "default"
 *   - mapper is PURE (same input → same output, no I/O) + TOTAL over the
 *     closed `ApprovalMode` union.
 */

import { describe, expect, test } from "bun:test"
import type { ApprovalMode } from "@/permission"
import {
  approvalModeToContextMode,
  NAMED_PROFILES,
  type PermissionMode,
  permissionModeFromProfile,
  resolveProfileByName,
} from "@/permission"

const ALL_APPROVAL_MODES: readonly ApprovalMode[] = ["auto", "once", "session", "always"]

describe("GAP2 profile.approval → PermissionContext.mode", () => {
  test('[1] "trusted" (approval auto) ⇒ derived context mode "auto"', () => {
    expect(permissionModeFromProfile(resolveProfileByName("trusted"))).toBe("auto")
  })

  test('[2] "restricted" (approval always) ⇒ derived context mode "default"', () => {
    expect(permissionModeFromProfile(resolveProfileByName("restricted"))).toBe("default")
  })

  test('[3] "default" (approval once) ⇒ derived context mode "default"', () => {
    expect(permissionModeFromProfile(resolveProfileByName("default"))).toBe("default")
  })

  test("[4] mapper is total over the closed ApprovalMode union", () => {
    const out = new Map<ApprovalMode, PermissionMode>()
    for (const m of ALL_APPROVAL_MODES) out.set(m, approvalModeToContextMode(m))
    expect(out.get("auto")).toBe("auto")
    expect(out.get("once")).toBe("default")
    expect(out.get("session")).toBe("default")
    expect(out.get("always")).toBe("default")
    // Every discriminant produced a value (no undefined fall-through).
    expect(out.size).toBe(ALL_APPROVAL_MODES.length)
    for (const m of ALL_APPROVAL_MODES) expect(out.get(m)).toBeDefined()
  })

  test("[5] mapper is pure — repeated calls yield identical results", () => {
    for (const m of ALL_APPROVAL_MODES) {
      const a = approvalModeToContextMode(m)
      const b = approvalModeToContextMode(m)
      expect(a).toBe(b)
    }
  })

  test('[6] only "auto" approval maps to a non-"default" context mode', () => {
    for (const name of ["default", "trusted", "restricted"] as const) {
      const profile = NAMED_PROFILES[name]
      const derived = permissionModeFromProfile(profile)
      if (profile.approval.mode === "auto") expect(derived).toBe("auto")
      else expect(derived).toBe("default")
    }
  })
})

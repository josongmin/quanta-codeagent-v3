/**
 * RFC-05 E1 — REQUESTED vs EFFECTIVE split + domain revision.
 *
 * Proves the requested view (lossless patch + projected preset) and the
 * effective view (fully-resolved complete record + reviewer route) are distinct,
 * that the reviewer route is resolved through the EXISTING selectDefaultReviewer
 * SSOT (no remap / no invented route), and that the domain revision is a
 * monotonic CAS token.
 */

import { describe, expect, test } from "bun:test"
import { selectDefaultReviewer } from "../../../../src/permission"
import { APPROVAL_LADDER } from "../../../../src/permission/approval-ladder"
import type { ControlPolicy } from "../../../../src/permission/permission-profile"
import {
  buildResolvedPosture,
  resolveEffective,
} from "../../../../src/permission/posture/availability"
import type { PostureRecord, ReviewerAvailability } from "../../../../src/permission/posture/types"
import { INITIAL_REVISION, nextRevision } from "../../../../src/permission/posture/types"
import { allCompleteRecords, nthCompleteRecord } from "./fixtures"

const RECORDS = allCompleteRecords()

// A fixed-length TUPLE type (not `ReadonlyArray`): indexing is then statically
// total, so the fixture reads need no `!`, while each element keeps the full
// `ReviewerAvailability` shape (an `as const` here would narrow the union and
// hide the optional `autoReviewEnabled` field).
const availabilities: readonly [
  ReviewerAvailability,
  ReviewerAvailability,
  ReviewerAvailability,
  ReviewerAvailability,
  ReviewerAvailability,
] = [
  { hasAutoReview: false, hasGuardianReview: false },
  { hasAutoReview: true, hasGuardianReview: false },
  { hasAutoReview: false, hasGuardianReview: true },
  { hasAutoReview: true, hasGuardianReview: true },
  { hasAutoReview: true, hasGuardianReview: true, autoReviewEnabled: true },
]

const sandboxProfileOf = (sandbox: PostureRecord["threadPermission"]["sandboxPolicy"]) => {
  if (sandbox.type === "read-only") return "read-only" as const
  if (sandbox.type === "danger-full-access") return "danger-full-access" as const
  return sandbox.networkAccess === true
    ? ("workspace-write-net" as const)
    : ("workspace-write" as const)
}

describe("resolveEffective — reuses selectDefaultReviewer (no remap)", () => {
  test("route matches the existing SSOT for every record x availability", () => {
    for (const record of RECORDS) {
      for (const avail of availabilities) {
        const effective = resolveEffective(record, avail)
        const expected = selectDefaultReviewer({
          threadPermission: record.threadPermission,
          permissionMode: "default",
          sandboxProfile: sandboxProfileOf(record.threadPermission.sandboxPolicy),
          hasAutoReview: avail.hasAutoReview,
          hasGuardianReview: avail.hasGuardianReview,
          ...(avail.autoReviewEnabled !== undefined
            ? { autoReviewEnabled: avail.autoReviewEnabled }
            : {}),
        })
        expect(effective.reviewerRoute).toBe(expected)
      }
    }
  })

  // Concrete route pins — independent of the test's own sandbox mapping, so the
  // "matches the SSOT" property above cannot be vacuously true via a shared bug.
  test("read-only rung (approvalsReviewer=user) resolves to the user route", () => {
    const route = resolveEffective(
      { threadPermission: APPROVAL_LADDER["read-only"], askOutsidePlan: true },
      { hasAutoReview: true, hasGuardianReview: true },
    ).reviewerRoute
    expect(route).toBe("user")
  })

  test("guardian-approvals rung routes to guardian only when the guardian is live", () => {
    const record = { threadPermission: APPROVAL_LADDER["guardian-approvals"], askOutsidePlan: true }
    expect(
      resolveEffective(record, { hasAutoReview: false, hasGuardianReview: true }).reviewerRoute,
    ).toBe("guardian_subagent")
    // Guardian absent, auto present -> falls to auto_review (not silently user).
    expect(
      resolveEffective(record, { hasAutoReview: true, hasGuardianReview: false }).reviewerRoute,
    ).toBe("auto_review")
    // Neither live -> fail-closed user.
    expect(
      resolveEffective(record, { hasAutoReview: false, hasGuardianReview: false }).reviewerRoute,
    ).toBe("user")
  })

  test("effective view is COMPLETE and carries the record's question knob", () => {
    for (const record of RECORDS) {
      const effective = resolveEffective(record, availabilities[0])
      expect(effective.threadPermission).toEqual(record.threadPermission)
      expect(effective.askOutsidePlan).toBe(record.askOutsidePlan)
      expect(effective.reviewerRoute).toBeDefined()
    }
  })
})

describe("buildResolvedPosture — requested and effective are distinct views", () => {
  const MANAGED: ControlPolicy = { managedBy: "admin", auditRequired: true }

  test("requested keeps the operator's lossless patch; effective is resolved", () => {
    const record = nthCompleteRecord(0)
    const resolved = buildResolvedPosture({
      record,
      revision: 7,
      requestedPatch: { approvalPolicy: "always" },
      availability: availabilities[3],
    })
    // Requested carries the PATCH (partial), not the complete record.
    expect(resolved.requested.patch).toEqual({ approvalPolicy: "always" })
    // Effective is the complete resolved record with a reviewer route.
    expect(resolved.effective.threadPermission).toEqual(record.threadPermission)
    expect(resolved.effective.reviewerRoute).toBeDefined()
    // The two are not the same object/shape.
    expect("reviewerRoute" in (resolved.requested as object)).toBe(false)
    expect("patch" in (resolved.effective as object)).toBe(false)
  })

  test("locks derive from the managed policy producer only", () => {
    const record = nthCompleteRecord(0)
    const withManaged = buildResolvedPosture({
      record,
      revision: 1,
      requestedPatch: {},
      availability: availabilities[0],
      managedPolicy: MANAGED,
    })
    const withoutManaged = buildResolvedPosture({
      record,
      revision: 1,
      requestedPatch: {},
      availability: availabilities[0],
    })
    expect(withManaged.locks.map((l) => l.reason)).toEqual(["managed_policy"])
    expect(withoutManaged.locks).toEqual([])
  })

  test("carries the domain revision verbatim", () => {
    const resolved = buildResolvedPosture({
      record: nthCompleteRecord(0),
      revision: 42,
      requestedPatch: {},
      availability: availabilities[0],
    })
    expect(resolved.revision).toBe(42)
  })
})

describe("domain revision — monotonic CAS token", () => {
  test("nextRevision strictly increments from the initial revision", () => {
    expect(INITIAL_REVISION).toBe(0)
    let r: number = INITIAL_REVISION
    for (let i = 0; i < 5; i++) {
      const n = nextRevision(r)
      expect(n).toBe(r + 1)
      r = n
    }
  })
})

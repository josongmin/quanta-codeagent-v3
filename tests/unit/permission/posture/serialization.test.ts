/**
 * RFC-05 E1 — DETERMINISTIC serialization.
 *
 * Proves: structurally-equal postures serialize byte-identically regardless of
 * key insertion order; the lock brand symbol never appears in the output; a
 * resolved posture (with a producer lock) serializes deterministically.
 */

import { describe, expect, test } from "bun:test"
import type { ControlPolicy } from "../../../../src/permission/permission-profile"
import { buildResolvedPosture } from "../../../../src/permission/posture/availability"
import {
  serializePosture,
  serializeResolvedPosture,
} from "../../../../src/permission/posture/presets"
import type { PostureRecord } from "../../../../src/permission/posture/types"

describe("serializePosture — key-order independent", () => {
  test("two structurally-equal records with different key order match", () => {
    const a: PostureRecord = {
      threadPermission: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspace-write",
          networkAccess: true,
          writableRoots: ["/a", "/b"],
        },
      },
      askOutsidePlan: true,
    }
    // Same data, keys inserted in a different order at every level.
    const b: PostureRecord = {
      askOutsidePlan: true,
      threadPermission: {
        sandboxPolicy: {
          writableRoots: ["/a", "/b"],
          type: "workspace-write",
          networkAccess: true,
        },
        approvalsReviewer: "user",
        approvalPolicy: "on-request",
      },
    } as PostureRecord
    expect(serializePosture(a)).toBe(serializePosture(b))
  })

  test("differing arrays produce differing output (non-vacuous)", () => {
    const base = { sandboxPolicy: { type: "workspace-write", writableRoots: ["/a"] } }
    const other = { sandboxPolicy: { type: "workspace-write", writableRoots: ["/b"] } }
    expect(serializePosture(base)).not.toBe(serializePosture(other))
  })

  test("explicitly-undefined optional and absent key serialize identically", () => {
    expect(serializePosture({ type: "read-only", networkAccess: undefined })).toBe(
      serializePosture({ type: "read-only" }),
    )
  })
})

describe("serializeResolvedPosture — deterministic and brand-free", () => {
  const MANAGED: ControlPolicy = { managedBy: "admin", auditRequired: true }
  const record: PostureRecord = {
    threadPermission: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "read-only" },
    },
    askOutsidePlan: false,
  }

  test("two identical resolved postures serialize byte-identically", () => {
    const build = () =>
      buildResolvedPosture({
        record,
        revision: 3,
        requestedPatch: { sandboxPolicy: { type: "read-only" } },
        availability: { hasAutoReview: true, hasGuardianReview: true },
        managedPolicy: MANAGED,
      })
    expect(serializeResolvedPosture(build())).toBe(serializeResolvedPosture(build()))
  })

  test("the lock brand symbol is never serialized", () => {
    const resolved = buildResolvedPosture({
      record,
      revision: 3,
      requestedPatch: {},
      availability: { hasAutoReview: false, hasGuardianReview: false },
      managedPolicy: MANAGED,
    })
    const json = serializeResolvedPosture(resolved)
    expect(json).toContain("managed_policy")
    expect(json).not.toContain("Symbol")
    expect(json).not.toContain("quanta.permission.posture.lock")
    // Round-trips as plain JSON (no symbol keys survive).
    expect(() => JSON.parse(json)).not.toThrow()
  })
})

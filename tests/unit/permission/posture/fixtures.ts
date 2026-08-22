/**
 * Exhaustive complete-record generator for the RFC-05 E1 posture property
 * tests. The field space is small enough to enumerate EXHAUSTIVELY (64 complete
 * records), which is strictly stronger than sampled randomization for the
 * lossless invariant.
 */

import type { ThreadPermission } from "../../../../src/permission/permission-store"
import type { PostureRecord } from "../../../../src/permission/posture/types"
import type { PermissionMode } from "../../../../src/permission/types"

const APPROVAL_POLICIES: ReadonlyArray<ThreadPermission["approvalPolicy"]> = [
  "never",
  "on-request",
  "on-failure",
  "always",
]

const REVIEWERS: ReadonlyArray<ThreadPermission["approvalsReviewer"]> = ["user", "agent"]

const SANDBOXES: ReadonlyArray<ThreadPermission["sandboxPolicy"]> = [
  { type: "read-only" },
  { type: "danger-full-access" },
  { type: "workspace-write" },
  { type: "workspace-write", writableRoots: ["/repo"], networkAccess: true },
]

const ASK: ReadonlyArray<boolean> = [true, false]

// RFC-05 E2b — the permission-mode axis. Enumerated (not sampled) so the lossless
// invariant is proven over EVERY mode, reusing the existing PermissionMode union.
const MODES: ReadonlyArray<PermissionMode> = ["default", "acceptEdits", "bypass", "auto"]

/** All 256 complete posture records (4 x 2 x 4 x 2 x 4 — the mode axis added). */
export const allCompleteRecords = (): readonly PostureRecord[] => {
  const out: PostureRecord[] = []
  for (const approvalPolicy of APPROVAL_POLICIES) {
    for (const approvalsReviewer of REVIEWERS) {
      for (const sandboxPolicy of SANDBOXES) {
        for (const askOutsidePlan of ASK) {
          for (const mode of MODES) {
            out.push({
              threadPermission: { approvalPolicy, approvalsReviewer, sandboxPolicy },
              askOutsidePlan,
              mode,
            })
          }
        }
      }
    }
  }
  return out
}

/** A single record structurally distinct from most generated ones, used as the
 *  "wrong base" to prove `toCustomPatch` does not leak base fields through. */
export const DISTINCT_BASE: PostureRecord = {
  threadPermission: {
    approvalPolicy: "always",
    approvalsReviewer: "agent",
    sandboxPolicy: { type: "danger-full-access" },
  },
  askOutsidePlan: false,
  mode: "bypass",
}

/** Nth complete record, by index, with a NAMED failure. The fixtures are a
 *  cartesian product, so an index is only meaningful relative to that product's
 *  size — a non-null assertion (`records[i]!`) would let a fixture-count change
 *  hand the test `undefined` and fail somewhere downstream instead of here. */
export const nthCompleteRecord = (index: number): PostureRecord => {
  const records = allCompleteRecords()
  const record = records[index]
  if (record === undefined) {
    throw new Error(
      `posture fixtures: no complete record at index ${index} (have ${records.length})`,
    )
  }
  return record
}

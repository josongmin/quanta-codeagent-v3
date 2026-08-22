/**
 * Exhaustive complete-record generator for the RFC-05 E1 posture property
 * tests. The field space is small enough to enumerate EXHAUSTIVELY (64 complete
 * records), which is strictly stronger than sampled randomization for the
 * lossless invariant.
 */

import type { ThreadPermission } from "../../../../src/permission/permission-store"
import type { PostureRecord } from "../../../../src/permission/posture/types"

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

/** All 64 complete posture records (4 x 2 x 4 x 2). */
export const allCompleteRecords = (): readonly PostureRecord[] => {
  const out: PostureRecord[] = []
  for (const approvalPolicy of APPROVAL_POLICIES) {
    for (const approvalsReviewer of REVIEWERS) {
      for (const sandboxPolicy of SANDBOXES) {
        for (const askOutsidePlan of ASK) {
          out.push({
            threadPermission: { approvalPolicy, approvalsReviewer, sandboxPolicy },
            askOutsidePlan,
          })
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
}

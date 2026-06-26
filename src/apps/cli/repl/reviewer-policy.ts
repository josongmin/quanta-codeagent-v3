/**
 * Surface-side reviewer-policy glue.
 *
 * The DECISION logic (`selectDefaultReviewer`) and the `ReviewerSandboxProfile`
 * type are owned by `@/permission` (peer of `approval-ladder.ts` / `reviewer.ts`)
 * — both the input authority record and the output tier are permission-domain
 * types, so the algorithm belongs in the core, not a surface. This module keeps
 * only the genuinely surface-bound concern: parsing the `QUANTA_SANDBOX` env
 * literal into the core `ReviewerSandboxProfile`. The CLI is the designated
 * `process.env` reader.
 */

import type { ReviewerSandboxProfile } from "@/permission"

export const parseCliReviewerSandboxProfile = (raw: string | undefined): ReviewerSandboxProfile => {
  switch (raw) {
    case undefined:
    case "":
      return "default"
    case "default":
    case "off":
    case "read-only":
    case "workspace-write":
    case "workspace-write-net":
    case "danger-full-access":
      return raw
    default:
      return "default"
  }
}

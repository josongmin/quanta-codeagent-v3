/**
 * APPROVAL LADDER — named posture preset SSOT (T03, jun-13 codex-ide reabsorption,
 * feature `03-guardian-auto-approval-reviewer`).
 *
 * Codex collaboration-mode matrix (`src-GT0gjTeg.js` `Nm`) is a NAMED ladder of
 * postures, each a triple of `{sandbox, approvalPolicy, reviewer}`:
 *
 *   read-only:           sandbox=read-only,          approval=on-request, reviewer=user
 *   auto:                sandbox=workspace-write,     approval=on-request, reviewer=user
 *   granular:            sandbox=workspace-write,     approval=always,     reviewer=user
 *   guardian-approvals:  sandbox=workspace-write,     approval=on-request, reviewer=agent
 *   full-access:         sandbox=danger-full-access,  approval=never,      reviewer=user
 *   custom:              operator-defined (NOT in the table; resolves to undefined)
 *
 * This is the SINGLE source of truth for that mapping. It maps a named rung
 * straight onto a {@link ThreadPermission} (the per-thread reviewer authority the
 * permission stack already consumes), so selecting a rung is the ONLY edit a
 * surface makes — the `reviewer: "agent"` field (guardian-approvals) is what
 * routes the approval to the side-agent guardian reviewer.
 *
 * SAFETY: `guardian-approvals` is the ONLY rung whose reviewer is `agent`; every
 * other rung keeps the human reviewer. The default is NEVER a rung at all (no
 * ladder selected ⇒ no seeding ⇒ byte-identical legacy behavior). HARD_DENY runs
 * BEFORE the reviewer regardless of rung (see `@/permission/policy#evaluate`), so
 * a `guardian-approvals` posture can never auto-approve a hard-denied command.
 */

import type { ThreadPermission } from "./per-thread-store"

/** The named rungs of the approval ladder, in escalation order. `custom` is a
 *  sentinel for an operator-defined posture and has NO table entry. */
export const APPROVAL_LADDER_NAMES = [
  "read-only",
  "auto",
  "granular",
  "guardian-approvals",
  "full-access",
  "custom",
] as const

export type ApprovalLadderName = (typeof APPROVAL_LADDER_NAMES)[number]

/** The five concrete rungs (every name except `custom`). */
export type NamedApprovalLadderRung = Exclude<ApprovalLadderName, "custom">

/**
 * SSOT table: each named rung → the exact `ThreadPermission` it denotes. `custom`
 * is intentionally absent (a `custom` posture is supplied by the operator, not
 * derived here). Frozen so a consumer cannot mutate a shared rung.
 */
export const APPROVAL_LADDER: Readonly<Record<NamedApprovalLadderRung, ThreadPermission>> =
  Object.freeze({
    "read-only": Object.freeze({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: Object.freeze({ type: "read-only" }),
    }),
    auto: Object.freeze({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: Object.freeze({ type: "workspace-write" }),
    }),
    granular: Object.freeze({
      approvalPolicy: "always",
      approvalsReviewer: "user",
      sandboxPolicy: Object.freeze({ type: "workspace-write" }),
    }),
    "guardian-approvals": Object.freeze({
      approvalPolicy: "on-request",
      approvalsReviewer: "agent",
      sandboxPolicy: Object.freeze({ type: "workspace-write" }),
    }),
    "full-access": Object.freeze({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: Object.freeze({ type: "danger-full-access" }),
    }),
  }) as Readonly<Record<NamedApprovalLadderRung, ThreadPermission>>

/** Narrow an arbitrary string to a known ladder name, or `undefined`. An empty /
 *  unknown / `custom` value yields `undefined` — fail-safe: an invalid posture
 *  literal never silently widens authority. The consumer reads the resolved
 *  rung's authority straight off {@link APPROVAL_LADDER}. */
export const parseApprovalLadderName = (
  raw: string | undefined,
): NamedApprovalLadderRung | undefined => {
  if (raw === undefined || raw === "") return undefined
  return (APPROVAL_LADDER_NAMES as readonly string[]).includes(raw) && raw !== "custom"
    ? (raw as NamedApprovalLadderRung)
    : undefined
}

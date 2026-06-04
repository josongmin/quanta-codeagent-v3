/**
 * H8 — heartbeat-automation creation-boundary invariants (pure, no I/O).
 *
 * `cron` automations are thread-detached (fresh fire); `heartbeat` automations
 * attach to ONE conversation thread and inherit its posture. Two invariants the
 * HOST enforces at CREATION time (the fire path stays simple — see
 * `runtime.ts`, which just routes a well-formed heartbeat):
 *
 *   1. A `heartbeat` MUST carry a `targetThreadId` (+ posture snapshot) — a
 *      heartbeat with no thread is meaningless (it would silently degrade to a
 *      fresh cron fire, losing the "keep working THIS thread" intent).
 *   2. At most ONE `active` heartbeat per `targetThreadId` (Codex constraint) —
 *      two repeating agents on the same thread under the same posture would
 *      double-drive it.
 *
 * Pure: callers pass the candidate + the current automation set; these never
 * read the store. NO-THROW (return a typed verdict).
 */

import type { Automation } from "./types"

/** Why a heartbeat candidate is rejected at creation. */
export type HeartbeatRejectReason = "missing-target-thread" | "missing-policy" | "thread-occupied"

export type HeartbeatValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: HeartbeatRejectReason }

/** The single `active` heartbeat attached to `threadId`, if any. Pure scan. */
export const activeHeartbeatForThread = (
  automations: readonly Automation[],
  threadId: string,
): Automation | undefined =>
  automations.find(
    (a) => a.kind === "heartbeat" && a.status === "active" && a.targetThreadId === threadId,
  )

/**
 * Validate a heartbeat candidate against the current set BEFORE persisting it.
 * `cron` candidates are always `ok` (no heartbeat constraints apply). For a
 * `heartbeat`: requires a target thread + a posture snapshot, and rejects when
 * that thread already has a DIFFERENT active heartbeat (same id ⇒ an update, so
 * it is allowed to re-occupy its own slot).
 */
export const validateHeartbeatCandidate = (
  candidate: Automation,
  existing: readonly Automation[],
): HeartbeatValidation => {
  if (candidate.kind !== "heartbeat") return { ok: true }
  if (candidate.targetThreadId === undefined || candidate.targetThreadId.length === 0) {
    return { ok: false, reason: "missing-target-thread" }
  }
  if (candidate.inheritedPolicy === undefined) {
    return { ok: false, reason: "missing-policy" }
  }
  const occupant = activeHeartbeatForThread(existing, candidate.targetThreadId)
  if (occupant !== undefined && occupant.id !== candidate.id) {
    return { ok: false, reason: "thread-occupied" }
  }
  return { ok: true }
}

/**
 * Post-denial precedence (ADR-0046).
 *
 * Codex's guardian reviewer applies "post-denial precedence": once an action
 * was explicitly denied and the user later re-approves AFTER seeing the risk,
 * the re-approval overrides the rule that originally denied it. This is
 * intentionally narrow — the override is per-(thread, actionSignature) and
 * requires a complete 3-step sequence:
 *
 *     recordDenial(action, reason)         — gate's deny path records here
 *     recordRiskSeen(action)               — UI shows "this is dangerous: X"
 *     recordUserOverride(action)           — user explicitly clicks "do it anyway"
 *
 * Only after all three steps does `hasPostDenialOverride` return true. The
 * sequence ordering matters — `recordRiskSeen` BEFORE `recordUserOverride`
 * is what prevents a malicious prompt from auto-overriding a denial by
 * fabricating a fake override timestamp. See ADR-0046 §Risks.
 *
 * Slice rules: pure facade over `permission-store.ts`. No IO beyond the
 * store's own debounced flush.
 */

import { computeActionSignature, type DenialRecord, type PermissionStore } from "./permission-store"
import { emitPostDenialEvent } from "./recorder"

export type { DenialRecord } from "./permission-store"
export { computeActionSignature } from "./permission-store"

/** Optional caller-injected clock. Production uses `Date.now`; tests pass a
 *  fake. */
export interface PostDenialClock {
  now(): number
}

const defaultClock: PostDenialClock = { now: () => Date.now() }

export interface PostDenialAction {
  threadId: string
  tool: string
  workdir: string
  args: unknown
}

/** Record a fresh denial. Resets any prior `seenRiskAt`/`userOverrideAt` for
 *  the same `(threadId, actionSignature)` — re-denying is a new event.
 *  `store` is REQUIRED — composition root injects (no service-locator fallback). */
export const recordDenial = (
  action: PostDenialAction,
  reason: string,
  opts: { clock?: PostDenialClock; store: PermissionStore },
): string => {
  const clock = opts.clock ?? defaultClock
  const store = opts.store
  const actionSignature = computeActionSignature({
    tool: action.tool,
    workdir: action.workdir,
    args: action.args,
  })
  store.recordDenial({
    threadId: action.threadId,
    actionSignature,
    deniedAt: clock.now(),
    deniedReason: reason,
  })
  // SECURITY: only the hashed actionSignature + threadId reach the recorder.
  // `reason` is intentionally NOT plumbed through — it may be a free-form
  // string from a HARD_DENY rule that quotes the offending command. The
  // audit log owns reasons; the metric layer owns the funnel transitions.
  emitPostDenialEvent({
    event: "denied",
    actionSignature,
    threadId: action.threadId,
    decidedBy: "stack",
  })
  return actionSignature
}

/** Mark that the user has seen the concrete risk explanation. No-op when
 *  no prior denial exists (defensive — UI should not call this for an
 *  action that was never denied). `store` is REQUIRED. */
export const recordRiskSeen = (
  action: PostDenialAction,
  opts: { clock?: PostDenialClock; store: PermissionStore },
): string => {
  const clock = opts.clock ?? defaultClock
  const store = opts.store
  const actionSignature = computeActionSignature({
    tool: action.tool,
    workdir: action.workdir,
    args: action.args,
  })
  store.recordRiskSeen(action.threadId, actionSignature, clock.now())
  emitPostDenialEvent({
    event: "risk-seen",
    actionSignature,
    threadId: action.threadId,
    decidedBy: "stack",
  })
  return actionSignature
}

/** Mark that the user has explicitly re-approved this action AFTER seeing
 *  the risk. The store enforces sequence ordering via timestamps.
 *  `store` is REQUIRED. */
export const recordUserOverride = (
  action: PostDenialAction,
  opts: { clock?: PostDenialClock; store: PermissionStore },
): string => {
  const clock = opts.clock ?? defaultClock
  const store = opts.store
  const actionSignature = computeActionSignature({
    tool: action.tool,
    workdir: action.workdir,
    args: action.args,
  })
  store.recordUserOverride(action.threadId, actionSignature, clock.now())
  emitPostDenialEvent({
    event: "user-override",
    actionSignature,
    threadId: action.threadId,
    decidedBy: "stack",
  })
  return actionSignature
}

/** True when the override sequence is complete AND properly ordered for the
 *  (threadId, action) pair. Used by the admissibility-gate as the highest-
 *  precedence allow signal. `store` is REQUIRED. */
export const hasPostDenialOverride = (
  action: PostDenialAction,
  opts: { store: PermissionStore },
): boolean => {
  const store = opts.store
  const actionSignature = computeActionSignature({
    tool: action.tool,
    workdir: action.workdir,
    args: action.args,
  })
  return store.hasPostDenialOverride(action.threadId, actionSignature)
}

/** Inspect the raw denial record (debug/audit/UI surfaces — e.g. the CLI
 *  status command). `store` is REQUIRED. */
export const getDenialRecord = (
  action: PostDenialAction,
  opts: { store: PermissionStore },
): DenialRecord | undefined => {
  const store = opts.store
  const actionSignature = computeActionSignature({
    tool: action.tool,
    workdir: action.workdir,
    args: action.args,
  })
  return store.getDenial(action.threadId, actionSignature)
}

/** Clear the override sequence (e.g. when the action's structural fingerprint
 *  changes — tool renamed, args canonicalization differs). The CLI exposes
 *  this for operators who need to reset state. `store` is REQUIRED. */
export const clearDenialRecord = (
  action: PostDenialAction,
  opts: { store: PermissionStore },
): void => {
  const store = opts.store
  const actionSignature = computeActionSignature({
    tool: action.tool,
    workdir: action.workdir,
    args: action.args,
  })
  store.clearDenial(action.threadId, actionSignature)
}

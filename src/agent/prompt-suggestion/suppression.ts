/**
 * Prompt-suggestion slice — suppression-context guard (ADR-0467).
 *
 * WHAT: `suppressionReason(state) → SuppressReason | null`. A PURE guard over a
 *   typed `AppStateView`. When ANY of plan-mode / rate-limited /
 *   elicitation-active / pending-permission holds, NO suggestion is shown — the
 *   model is never even called. Returns the FIRST matching reason (declaration
 *   order) or `null` when it is safe to suggest.
 *
 * SLICE: `@/agent`. Imports ONLY sibling `./types`. No IO, no env, no clock.
 *
 * NO-THROW CONTRACT: total over every `AppStateView`; never throws.
 *
 * EVIDENCE: Claude CLI gates suggestion generation behind `suppressSuggestions`
 *   which is set in plan mode, while rate-limited, during an open elicitation,
 *   and while a permission request is pending.
 */

import type { AppStateView, SuppressReason } from "./types"

/**
 * Returns the suppression reason, or `null` if suggesting is permitted. Checked
 * in a fixed precedence so telemetry is deterministic: a state that is both in
 * plan mode and rate-limited reports `plan_mode`.
 */
export function suppressionReason(state: AppStateView): SuppressReason | null {
  if (state.planMode) return "plan_mode"
  if (state.rateLimited) return "rate_limited"
  if (state.elicitationActive) return "elicitation_active"
  if (state.pendingPermission) return "pending_permission"
  return null
}

/**
 * Plan-tool error mapping (ADR-0095 draft).
 *
 * Converts a {@link PlanMutationErrorCode} from the producer-side mutator
 * into a model-facing reason string + a typed {@link ToolFailure} payload.
 * Adding a new code MUST extend the closed switch — exhaustive `never`
 * default arm causes tsc to fail.
 */

import type { PlanMutationErrorCode, ToolFailure } from "../types"

export const planErrorMessage = (code: PlanMutationErrorCode): string => {
  switch (code) {
    case "version_conflict":
      return "Plan version is stale. Call current_plan to read the latest version, then retry with the new expected_version."
    case "todo_not_found":
      return "Referenced todo id does not exist in the current plan."
    case "phase_not_found":
      return "Referenced phase id does not exist in the current plan."
    case "dependency_cycle":
      return "Proposed dependencies would create a cycle. Revise the dependency edges."
    case "dependency_unknown":
      return "A dependency points at a todo that is not present (after the mutation applies)."
    case "self_dependency":
      return "A todo cannot depend on itself."
    case "content_too_long":
      return "A field exceeds its allowed length (see PLAN_LIMITS)."
    case "invalid_status_transition":
      return "Status transition is not allowed by the matrix (e.g., terminal → non-terminal)."
    case "duplicate_id":
      return "An id appears twice in the patch batch or collides with an existing entry."
    case "empty_plan_create":
      return "create_plan was called with zero todos AND zero phases — provide at least one work item."
    default: {
      const _exhaustive: never = code
      return _exhaustive
    }
  }
}

/** Build a `ToolFailure{ mode: "rejected" }` from a producer error code. */
export const planFailure = (code: PlanMutationErrorCode): ToolFailure => ({
  mode: "rejected",
  reason: `${code}: ${planErrorMessage(code)}`,
})

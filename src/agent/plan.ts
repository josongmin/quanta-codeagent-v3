import type { ToolAction } from "@/permission"

/**
 * Plan mode (RFC §13 Q3 → DECISION: system-prompt augmentation + a permission-
 * style gate, NO separate "plan" tool).
 *
 * Rationale: a dedicated plan tool would be a closed-alphabet action (RFC §1.2
 * explicitly rejects pre-defining the full action set) and would need its own
 * schema, registry entry, and dispatch branch — exactly the v2 weight this
 * project avoids. Plan mode is not a new capability; it is a *restriction* plus
 * a prompt nudge. So we express it as (a) a system-prompt augmentation telling
 * the model to explore read-only and emit a concrete plan, and (b) a gate in
 * dispatch that blocks any non-read-only tool before it can run. This reuses
 * the existing system-augmentation copy pattern (memory recall in loop.ts) and
 * mirrors the permission-deny tool_result shape, adding zero new surface area.
 *
 * Behavior-preserving: `planMode` is optional on {@link AgentConfig}; absent ⇒
 * neither the augmentation nor the gate is reached, default path unchanged.
 */

const PLAN_AUGMENTATION = [
  "## Plan mode",
  "You are operating in PLAN MODE. Do NOT modify anything.",
  "- Explore using read-only tools only (read, grep, glob, localize).",
  "- Do NOT write, edit, run shell commands, or otherwise change the system.",
  "- Investigate the request thoroughly, then produce a concrete,",
  "  step-by-step implementation plan as your final answer.",
  "- The plan should be specific: which files, what changes, in what order.",
  "- Stop calling tools once you have enough context to write the plan.",
].join("\n")

/** System-prompt augmentation appended (to a fresh copy) when plan mode is on. */
export const planSystemAugmentation = (): string => PLAN_AUGMENTATION

/**
 * True when `action` mutates and must be blocked in plan mode. Read-only
 * actions (the permission action already carries `isReadOnly`) are allowed; an
 * action is blocked iff it is not read-only.
 */
export const isMutatingToolBlockedInPlan = (action: ToolAction): boolean => !action.isReadOnly

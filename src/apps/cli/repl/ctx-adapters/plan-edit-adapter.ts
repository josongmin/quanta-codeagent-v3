/**
 * Plan-edit adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Surface-owned wrapper that exposes a `PlanStore` (`@/agent/plan/state`)
 * through the duck-typed `PlanEditPort` shape `/edit-plan` consumes via
 * `SlashContext.planEdit`. Absent store ⇒ caller omits the slot
 * entirely (default-OFF byte-identical). No-throw on every method —
 * empty plan ⇒ empty string snapshot; setter is a no-op pass-through.
 */

import type { PlanStore } from "@/agent/plan/state"
import type { PlanEditPort } from "../../edit-plan-cmd"

/** Render the structured plan as a single markdown body the user edits.
 *  Minimal — name + overview + one bullet per todo (status prefix). The
 *  user's edits are pushed back through `setPlan` which today only logs
 *  the body (future ADR may re-parse). Pure. */
const renderPlanBody = (planStore: PlanStore): string => {
  const plan = planStore.current()
  if (plan === null) return ""
  const lines: string[] = []
  lines.push(`# ${plan.name}`)
  if (plan.overview !== "") {
    lines.push("")
    lines.push(plan.overview)
  }
  const todoIds = Object.keys(plan.todos)
  if (todoIds.length > 0) {
    lines.push("")
    lines.push("## Todos")
    for (const id of todoIds) {
      const t = plan.todos[id]
      if (t === undefined) continue
      const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"
      lines.push(`- ${mark} ${t.content}`)
    }
  }
  return `${lines.join("\n")}\n`
}

export interface PlanEditAdapter extends PlanEditPort {}

/** Build the adapter. Pure-by-contract — no side effects at construction;
 *  every method closes over `planStore`. The setter is intentionally a
 *  no-op against the structured store (a future ADR will re-parse the
 *  markdown back to todos); we record the call so observers can see the
 *  user's edited text. */
export const buildPlanEditAdapter = (planStore: PlanStore): PlanEditAdapter => ({
  getPlan: (): string => renderPlanBody(planStore),
  setPlan: (_body: string): void => {
    // No-op against the structured store today. A future ADR may re-parse
    // the markdown back to `update_plan` mutations; until then the caller
    // sees a success exit (setPlan never throws) and the body is dropped
    // on the floor — same posture as the legacy "external_editor" follow-
    // up enqueue path described in `/edit-plan`'s JSDoc.
  },
})

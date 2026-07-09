/**
 * Plan-edit adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Surface-owned wrapper that exposes a `PlanStore` (`@/agent/plan/state`)
 * through the duck-typed `PlanEditPort` shape `/edit-plan` consumes via
 * `SlashContext.planEdit`. Absent store ⇒ caller omits the slot
 * entirely (default-OFF byte-identical).
 *
 * WS-D effect-receipt posture (jul-10, UUX-1-01): `getPlan` is a read-only
 * render; `setPlan` FAILS CLOSED. The rendered markdown drops todo ids /
 * dependencies / phases / verifyHints, so a free-form edit CANNOT be mapped
 * back onto the structured store losslessly — and a resolving `setPlan` is the
 * command's success receipt ("updated (N chars)"). Resolving here while
 * dropping the body on the floor was a false-success print; the adapter now
 * throws so `/edit-plan` exits nonzero with an honest message. A future ADR
 * that embeds stable todo ids in the rendered body may replace the throw with
 * a real re-parse→mutations path (see `@/agent/plan/state` mutation API).
 */

import type { PlanStore } from "@/agent/plan/state"
import type { PlanEditPort } from "../../edit-plan-cmd"

/** Render the structured plan as a single markdown body the user edits.
 *  Minimal — name + overview + one bullet per todo (status prefix). Pure. */
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
 *  every method closes over `planStore`. The setter FAILS CLOSED (throws)
 *  because this surface cannot persist a free-form markdown edit into the
 *  structured store — see the module header. `/edit-plan` renders the throw
 *  as stderr + exit 1, so the user never sees "updated" over a dropped edit. */
export const buildPlanEditAdapter = (planStore: PlanStore): PlanEditAdapter => ({
  getPlan: (): string => renderPlanBody(planStore),
  setPlan: (_body: string): void => {
    // FAIL-CLOSED (WS-D UUX-1-01): the structured plan store is read-only
    // from this surface (the rendered body has no todo ids to re-bind a
    // lossless re-parse). Resolving here would make `/edit-plan` print
    // "updated (N chars)" while the store is byte-identical — the exact
    // false-success class this batch kills. The edit is NOT persisted.
    throw new Error(
      "edit not persisted — structured plan store is read-only from this surface " +
        "(use the plan tools / update_plan to change the plan)",
    )
  },
})

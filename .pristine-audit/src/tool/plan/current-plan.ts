/**
 * `current_plan` tool (ADR-0095 draft).
 *
 * Read-only snapshot of the current structured plan state. Surfaces the
 * existing `PlanToolContext.planMutator.current()` path to the model so CAS
 * retries can fetch the latest `expected_version` without mutating.
 */
import { errMessage, runtimeConfig } from "@/shared"
import type { PlanReadonlyView, PlanToolContext, Tool, ToolEvent } from "../types"
import { type MermaidPlanNode, planToMermaid } from "./plan-to-mermaid"
import { type CurrentPlanInput, currentPlanSchema } from "./schemas"

const renderTaskLine = (t: PlanReadonlyView["tasks"][number]): string => {
  const parts = [`  - ${t.id}`]
  if (t.owner !== undefined) parts.push(`owner=${t.owner}`)
  parts.push(`blockedBy=[${t.blockedBy.join(", ")}]`)
  parts.push(`blocks=[${t.blocks.join(", ")}]`)
  return parts.join(" ")
}

/** RFC12-1 — render the plan's DAG as a fenced ```mermaid``` block the existing
 *  `rich-markers` renderer detects. Reuses the RFC07-3 `blockedBy` edges (via
 *  `PlanReadonlyView.tasks`) + the `plan-to-mermaid` projector — no new store /
 *  protocol kind. Emitted ONLY when the caller passes `view:"graph"` AND the
 *  `QUANTA_PLAN_GRAPH` gate is on (else the text render is used, byte-identical). */
const renderPlanGraph = (plan: PlanReadonlyView): string => {
  const nodes: readonly MermaidPlanNode[] = plan.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    blockedBy: t.blockedBy,
  }))
  return `\`\`\`mermaid\n${planToMermaid(nodes)}\n\`\`\``
}

const renderPlanView = (plan: PlanReadonlyView): string => {
  const head = [
    `Current plan: v${plan.version}`,
    `name: ${plan.name}`,
    `overview: ${plan.overview}`,
    `isProject: ${plan.isProject ? "true" : "false"}`,
    `todos: ${plan.todoCount}`,
    `phases: ${plan.phaseCount}`,
  ]
  // RFC07-3: model-visible owner/blockedBy/blocks projection in canonical order.
  if (plan.tasks.length > 0) {
    head.push("tasks:")
    for (const t of plan.tasks) head.push(renderTaskLine(t))
  }
  return head.join("\n")
}

export const currentPlanTool = (): Tool<CurrentPlanInput> => ({
  name: "current_plan",
  description:
    "Read the current structured plan snapshot. Returns the latest version, name, overview, " +
    "project flag, and todo/phase counts. Call this before a CAS retry after version_conflict.",
  inputSchema: currentPlanSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: CurrentPlanInput, ctx: PlanToolContext): AsyncIterable<ToolEvent> {
    const mutator = ctx.planMutator
    if (mutator === undefined) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "current_plan unavailable: no structured plan store is wired in this session.",
          failure: { mode: "error", modelVisibleError: "structured plan store is not wired" },
        },
      }
      return
    }
    let plan: ReturnType<typeof mutator.current>
    try {
      plan = mutator.current()
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `current_plan failed: ${errMessage(e)}`,
          failure: { mode: "error", modelVisibleError: "internal mutator error" },
        },
      }
      return
    }
    // RFC12-1 — graph render is DOUBLE-gated: the caller must ask (`view:"graph"`)
    // AND the QUANTA_PLAN_GRAPH knob must be on. Unset knob ⇒ `view:"graph"` falls
    // through to the byte-identical text render (no fence). `plan === null` always
    // renders the plain "No active plan." line (nothing to graph).
    const wantGraph = input.view === "graph" && runtimeConfig().planGraph && plan !== null
    yield {
      type: "result",
      result: {
        ok: true,
        output:
          plan === null
            ? "No active plan."
            : wantGraph
              ? renderPlanGraph(plan)
              : renderPlanView(plan),
      },
    }
  },
})

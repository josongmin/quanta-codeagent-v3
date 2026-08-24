/**
 * §25.1 — `run_workflow` tool: the LLM-facing authoring surface. The model emits
 * a declarative {@link WorkflowSpec} (pure JSON — phases, steps, `{{ref}}`
 * templates, forEach fan-out); this tool compiles it and drives the whole
 * orchestration to completion through the injected {@link AgentRunPort}, then
 * returns a compact per-step summary. One tool call ⇒ a full multi-agent run.
 *
 * Factory-built: the `agentRun` port (in production, the subagent-runner adapter
 * `subagentRunnerToAgentRunPort`) is injected at the composition root — the
 * tier-1 subagent block, which already owns a runner. Default-OFF: registered
 * only when `config.subagent.enableWorkflow` is set (QUANTA_WORKFLOW).
 */

import { type ActivityStore, createWorkflowSink } from "@/activity"
import {
  type AgentRunPort,
  type BudgetPort,
  compileWorkflowSpec,
  runWorkflow,
  type StepOutcome,
  type WorkflowSpec,
  WorkflowSpecSchema,
} from "@/workflow"
import { defineTool } from "../factory"
import type { CoreToolContext, Tool, ToolEvent } from "../types"

export interface RunWorkflowToolDeps {
  /** Bridge to a real subagent loop — each workflow `agent` step is one spawn. */
  readonly agentRun: AgentRunPort
  /** Max concurrent agent runs (default 8). */
  readonly concurrency?: number
  /** Hard runaway backstop on total agent runs (default 1000). */
  readonly maxAgents?: number
  /** Optional shared token budget. */
  readonly budget?: BudgetPort
  /** jun-15 P0-b — OPTIONAL session activity store. When present, the run streams
   *  its phases/steps into the Agent Activity Spine so `/activity` shows the live
   *  multi-agent run. ABSENT ⇒ no activity recorded (byte-identical default). */
  readonly activityStore?: ActivityStore
}

/** One-line per-step summary for the model. */
const summarizeStep = (o: StepOutcome): string =>
  o.ok ? `  ✓ ${o.id}: ok` : `  ✗ ${o.id}: ${o.reason}${o.error ? ` — ${o.error}` : ""}`

const summarize = (spec: WorkflowSpec, result: Awaited<ReturnType<typeof runWorkflow>>): string => {
  const outcomes = [...result.results.values()]
  const okCount = outcomes.filter((o) => o.ok).length
  const failCount = outcomes.length - okCount
  const skipped = result.events.filter((e) => e.type === "step_skipped").length
  const header =
    `workflow ${result.ok ? "complete" : "completed WITH FAILURES"}: ` +
    `${okCount} ok, ${failCount} failed${skipped > 0 ? `, ${skipped} skipped` : ""} ` +
    `(${spec.phases.length} phases, ${result.agentRuns} agent runs)`
  return [header, ...outcomes.map(summarizeStep)].join("\n")
}

/**
 * The engine options for one run: every host-wired capability, present only
 * when the composition root actually supplied it.
 *
 * A unit because the whole block obeys ONE rule — an unwired capability must be
 * OMITTED rather than passed as `undefined` (exactOptionalPropertyTypes), so
 * the engine applies its own default and an activity-less run stays
 * byte-identical to the pre-spine baseline.
 */
const runWorkflowOptions = (
  deps: RunWorkflowToolDeps,
  ctx: CoreToolContext,
  act: ReturnType<typeof createWorkflowSink> | undefined,
): Parameters<typeof runWorkflow>[1] => ({
  agentRun: deps.agentRun,
  ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
  ...(deps.maxAgents !== undefined ? { maxAgents: deps.maxAgents } : {}),
  ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
  ...(act !== undefined ? { sink: { emit: (e) => act.emit(e) } } : {}),
  ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
})

export const createRunWorkflowTool = (deps: RunWorkflowToolDeps): Tool<WorkflowSpec> =>
  defineTool<WorkflowSpec>({
    name: "run_workflow",
    description:
      "Run a declarative multi-agent workflow to completion. Provide `phases`: each phase has " +
      "either `steps` (run sequential|parallel) or a `forEach` fan-out over a prior step's array " +
      "output. A step's `prompt` may interpolate `{{stepId}}` / `{{stepId.field}}` (prior outputs) " +
      "and, inside a forEach step, `{{item}}` / `{{item.field}}` / `{{index}}`. Give a step an " +
      '`outputSchema` ({field: "string"|"number"|"boolean"|"string[]"|...}) to make its ' +
      "JSON output typed for downstream refs. A forEach `step.id` MUST contain `{{index}}`. " +
      "Each step runs as one subagent; the engine handles fan-out, concurrency, and retries.",
    inputSchema: WorkflowSpecSchema,
    isReadOnly: () => false,
    // The spawned subagents may write; the workflow itself is not a pure read.
    isConcurrencySafe: () => false,
    async *execute(input: WorkflowSpec, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
      // Defensive re-validation: dispatch validates `inputSchema`, but a direct
      // caller might not. Fail with a clean tool error, never a compile crash.
      const parsed = WorkflowSpecSchema.safeParse(input)
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")
        yield { type: "result", result: { ok: false, output: `invalid workflow spec: ${detail}` } }
        return
      }
      // jun-15 P0-b — bridge the run into the Activity Spine when a session store
      // is injected. The sink maps each WorkflowEvent → spine event (same mapping
      // as the batch producer; pinned by the store drift ratchet). NO behaviour
      // change when absent.
      const act =
        deps.activityStore !== undefined
          ? createWorkflowSink(deps.activityStore, {
              runId: ctx.toolCallId ?? "workflow",
              label: parsed.data.phases[0]?.name ?? "workflow",
            })
          : undefined
      const result = await runWorkflow(
        compileWorkflowSpec(parsed.data),
        runWorkflowOptions(deps, ctx, act),
      )
      act?.close(result.ok)
      yield { type: "result", result: { ok: result.ok, output: summarize(parsed.data, result) } }
    },
  })

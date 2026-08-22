/**
 * §25.1 — Production adapter: bind the `@/workflow` engine's {@link AgentRunPort}
 * to the real {@link SubagentRunner} (a forked agent loop). Lives in `@/agent`
 * (the composition layer) because it bridges two leaf slices — `@/workflow`
 * (which by fence imports only `zod`) and `@/subagent` (the runner contract) —
 * and neither may import the other.
 *
 * Each workflow `agent` step becomes one forked subagent run: the step prompt is
 * the child's task, the child's `finalText` is the step value (the workflow then
 * parses it against the step `schema` if any). A thrown runner error maps to a
 * not-ok result so the engine records `agent_error` instead of crashing.
 */

import { errMessage } from "@/shared"
import type { SubagentRunner } from "@/subagent"
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "@/workflow"

export interface WorkflowAgentAdapterOptions {
  /** Recursion depth to stamp on each spawned child (parent depth + 1). The
   *  runner enforces `maxDepth`; a workflow launched from the top loop should
   *  pass `1`. Default `1`. */
  readonly depth?: number
  /** Optional named subagent profile every step runs as (e.g. "Explore"). Per-
   *  step roles can be modeled by distinct workflows; this is the coarse
   *  default. Absent ⇒ the runner's fork/general profile. */
  readonly agentType?: string
}

/**
 * Adapt a {@link SubagentRunner} into a workflow {@link AgentRunPort}. The
 * engine owns concurrency (its semaphore) + retries; this adapter is a thin,
 * no-throw mapping of one run.
 */
export const subagentRunnerToAgentRunPort = (
  runner: SubagentRunner,
  options: WorkflowAgentAdapterOptions = {},
): AgentRunPort => ({
  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    try {
      const res = await runner({
        prompt: req.prompt,
        depth: options.depth ?? 1,
        ...(options.agentType !== undefined ? { agentType: options.agentType } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      })
      return res.ok
        ? { ok: true, text: res.finalText }
        : { ok: false, text: res.finalText, errorMessage: "subagent returned ok:false" }
    } catch (e) {
      return { ok: false, text: "", errorMessage: errMessage(e) }
    }
  },
})

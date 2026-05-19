import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { TaskRegistry } from "./registry"
import type { SubagentRequest, SubagentResult, SubagentRunner } from "./types"

const DEFAULT_MAX_DEPTH = 3

const agentSchema = z.object({
  prompt: z.string().describe("The task for the subagent to carry out autonomously"),
  agent_type: z
    .string()
    .optional()
    .describe('Named subagent profile, e.g. "Explore" or "Plan". Omit for a general fork.'),
  tools: z
    .array(z.string())
    .optional()
    .describe("Allowlist of tool names the subagent may use. Omit to inherit the parent set."),
  background: z
    .boolean()
    .optional()
    .describe("Run detached; returns a task id immediately. Poll with task_output."),
  isolation: z
    .enum(["none", "worktree"])
    .optional()
    .describe('"worktree" runs the subagent in an isolated git worktree.'),
  max_turns: z.number().optional().describe("Turn budget for the child loop"),
  max_tokens: z.number().optional().describe("Token budget for the child loop"),
})

type AgentInput = z.infer<typeof agentSchema>

export interface AgentToolOptions {
  runner: SubagentRunner
  /** Hard recursion ceiling. Spawning past this depth is denied. */
  maxDepth?: number
  /** Shared registry so the Task* tools observe the same background tasks. */
  registry?: TaskRegistry
}

/** Read the caller's recursion depth off the ToolContext if the host set it.
 *  The slice does not depend on @/agent's context shape; we duck-type a
 *  numeric `depth` and default to 0 (root) when absent. */
const ctxDepth = (ctx: ToolContext): number => {
  const d = (ctx as unknown as { depth?: unknown }).depth
  return typeof d === "number" && d >= 0 ? d : 0
}

const summarize = (r: SubagentResult): string => {
  const head = r.ok ? "Subagent completed." : "Subagent failed."
  const turns = `(${r.turns} turn${r.turns === 1 ? "" : "s"})`
  return `${head} ${turns}\n\n${r.finalText}`.trim()
}

/**
 * The `Agent` tool (alias `Task`). Foreground ⇒ await the injected runner and
 * return its summary as the tool result. Background ⇒ register the task in the
 * in-memory {@link TaskRegistry} and return a task id immediately; the forked
 * runner resolves it asynchronously. Depth past `maxDepth` is denied.
 *
 * The returned object carries `.registry` so the host can wire the matching
 * `task_output` / `task_stop` tools against the same registry instance.
 */
export const createAgentTool = (
  opts: AgentToolOptions,
): Tool<AgentInput> & { registry: TaskRegistry } => {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const registry = opts.registry ?? new TaskRegistry()

  const tool: Tool<AgentInput> & { registry: TaskRegistry } = {
    name: "agent",
    description:
      "Launch a subagent to autonomously handle a delegated task. Alias: Task. " +
      "Foreground returns the subagent's summary; set background:true to get a " +
      "task id and poll with task_output / cancel with task_stop.",
    inputSchema: agentSchema,
    isReadOnly: () => true,
    // Spawning a child agent has unbounded side effects via its own tools;
    // never batch concurrently with sibling calls.
    isConcurrencySafe: () => false,
    registry,

    async *execute(input: AgentInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const parentDepth = ctxDepth(ctx)
      const childDepth = parentDepth + 1

      if (childDepth > maxDepth) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `Subagent denied: recursion depth ${childDepth} exceeds maxDepth ${maxDepth}.`,
          },
        }
        return
      }

      const req: SubagentRequest = {
        prompt: input.prompt,
        depth: childDepth,
        ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
        ...(input.tools !== undefined ? { toolFilter: input.tools } : {}),
        ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
        ...(input.max_turns !== undefined || input.max_tokens !== undefined
          ? {
              budget: {
                ...(input.max_turns !== undefined ? { maxTurns: input.max_turns } : {}),
                ...(input.max_tokens !== undefined ? { maxTokens: input.max_tokens } : {}),
              },
            }
          : {}),
      }

      if (input.background === true) {
        const id = registry.newId()
        registry.register({
          id,
          description: input.prompt.slice(0, 120),
          ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
        })
        // Fire and forget; the registry record settles when the runner returns.
        void opts
          .runner(req)
          .then((r) => registry.complete(id, r))
          .catch((e: unknown) =>
            registry.fail(id, e instanceof Error ? e.message : String(e)),
          )
        yield {
          type: "result",
          result: {
            ok: true,
            output:
              `Subagent launched in background. task_id: ${id}\n` +
              `Poll with task_output({ task_id: "${id}" }) or cancel with task_stop.`,
          },
        }
        return
      }

      yield { type: "progress", message: `Delegating to subagent (depth ${childDepth})…` }
      try {
        const r = await opts.runner(req)
        yield { type: "result", result: { ok: r.ok, output: summarize(r) } }
      } catch (e: unknown) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `Subagent error: ${e instanceof Error ? e.message : String(e)}`,
          },
        }
      }
    },
  }

  return tool
}

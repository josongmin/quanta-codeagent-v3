import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { TaskRegistry } from "./registry"
import type { SubagentRequest, SubagentResult, SubagentRunner, TaskBudget, TaskKind } from "./types"

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
  task_kind: z
    .enum(["read", "edit", "review"])
    .optional()
    .describe(
      "Coarse role: 'read' (read-only analysis), 'edit' (file modification), 'review' " +
        "(read-only critique). Used to derive a default tool allowlist when `tools` is not set.",
    ),
  result_shape: z
    .string()
    .optional()
    .describe(
      "One-line format spec for the child's final answer (e.g. 'JSON: {ok, files[], summary}'). " +
        "Injected into the child's seed prompt.",
    ),
  owned_surfaces: z
    .array(z.string())
    .optional()
    .describe("Files/paths the child is permitted to read or modify."),
  forbidden_surfaces: z
    .array(z.string())
    .optional()
    .describe("Files/paths the child must NOT touch. Pairs with owned_surfaces."),
  continue_from: z
    .string()
    .optional()
    .describe(
      "Prior task_id (from a settled background task) — prepends its finalText to the new " +
        "child's seed as a 'Previous attempt' block. Unknown/evicted id returns a recoverable error.",
    ),
  checkpoint: z
    .boolean()
    .optional()
    .describe(
      "When true, runner injects guidance for the child to write interim progress to " +
        "'<cwd>/.subagent-state/<task_id>.md'. Parent reads via the normal `read` tool. " +
        "Incompatible with isolation:'worktree' (parent cannot read inside a throwaway worktree).",
    ),
  // ADR-0298 — Cursor `is_parallel_worker` declarative flag. Carries ZERO
  // functional behaviour: concurrency is governed by `isConcurrencySafe`
  // (which returns true for `agent` unconditionally, since each child runs in
  // its own conversation envelope and shares no mutable state with siblings).
  // The flag is a PARENT-SIDE DECLARATION the LLM emits when it intentionally
  // fans out independent workers in one assistant message — surfaced to
  // telemetry / HITL so "5 parallel workers spawned" can be grouped as one
  // event. The runner does NOT receive it (not threaded into SubagentRequest).
  parallel_worker: z
    .boolean()
    .optional()
    .describe(
      "Declarative intent flag (ADR-0298 — Cursor is_parallel_worker pattern). " +
        "Set to true when emitting multiple `agent` calls in ONE assistant message " +
        "to fan out independent workers. Concurrency itself is automatic — the " +
        "streaming-dispatch barrier already schedules concurrent-safe sibling " +
        "calls in flight. This flag is for telemetry / UI grouping; functional " +
        "behaviour is identical with or without it.",
    ),
})

type AgentInput = z.infer<typeof agentSchema>

/** Codex-derived default tool allowlists keyed by coarse task role.
 *  - "read"   → pure inspection set (no writers, no shell).
 *  - "edit"   → inspection + writers + bash for build/test loops.
 *  - "review" → strictest read-only subset for critique passes.
 *  Explicit `tools` on the request ALWAYS wins; this table is only consulted
 *  when the caller passed `task_kind` and omitted `tools`. Names mirror the
 *  actual tool registry in `src/tool/` (including caller-wired delegated
 *  facades such as `search_codebase`; `lsp_nav` exposes three sub-tools). */
const deriveToolFilter = (kind: TaskKind): string[] => {
  const readOnly = [
    "read",
    "search_codebase",
    "grep",
    "glob",
    "lsp_references",
    "lsp_document_symbol",
    "lsp_workspace_symbol",
    "diagnostics",
    "localize",
  ]
  if (kind === "read") return readOnly
  if (kind === "review")
    return [
      "read",
      "search_codebase",
      "grep",
      "glob",
      "lsp_references",
      "lsp_document_symbol",
      "lsp_workspace_symbol",
      "diagnostics",
    ]
  return [...readOnly, "write", "edit", "bash"]
}

export interface AgentToolOptions {
  runner: SubagentRunner
  /** Hard recursion ceiling. Spawning past this depth is denied. */
  maxDepth?: number
  /** Shared registry so the Task* tools observe the same background tasks. */
  registry?: TaskRegistry
}

/** Read the caller's recursion depth off the ToolContext if the host set it.
 *  `ToolContext.depth?: number` is part of the public type; the `>= 0`
 *  typeof guard is a defensive backstop against hosts that leave the field
 *  unset (treated as root) or pass nonsense. */
const ctxDepth = (ctx: ToolContext): number => {
  const d = ctx.depth
  return typeof d === "number" && d >= 0 ? d : 0
}

const summarize = (r: SubagentResult): string => {
  const head = r.ok ? "Subagent completed." : "Subagent failed."
  const turns = `(${r.turns} turn${r.turns === 1 ? "" : "s"})`
  return `${head} ${turns}\n\n${r.finalText}`.trim()
}

/** Look up `continue_from` in the registry. Returns the prior attempt's
 *  finalText if found and settled; undefined if the id is unknown/evicted or
 *  the task never produced a finalText. The caller surfaces a recoverable
 *  deny when this returns undefined. */
const resolvePriorAttempt = (registry: TaskRegistry, continueFrom: string): string | undefined => {
  const rec = registry.get(continueFrom)
  if (!rec) return undefined
  const text = rec.result?.finalText
  return text && text.length > 0 ? text : undefined
}

/** Compute the checkpoint path the runner will inject. `<cwd>/.subagent-state/<taskId>.md`
 *  with the slice's cwd being the parent's (the runner is responsible for
 *  using the right cwd when isolation:worktree is rejected at this layer). */
const buildCheckpointPath = (cwd: string, taskId: string): string => {
  // node:path-free construction — we don't depend on node:path at the slice.
  const sep = cwd.endsWith("/") ? "" : "/"
  return `${cwd}${sep}.subagent-state/${taskId}.md`
}

/** Build the optional `budget` block, or `undefined` if neither field was set.
 *  Extracted to keep `buildRequest`'s cog-complexity score in the cap. */
const buildBudget = (input: AgentInput): TaskBudget | undefined => {
  const hasBudget = input.max_turns !== undefined || input.max_tokens !== undefined
  if (!hasBudget) return undefined
  return {
    ...(input.max_turns !== undefined ? { maxTurns: input.max_turns } : {}),
    ...(input.max_tokens !== undefined ? { maxTokens: input.max_tokens } : {}),
  }
}

/** Build the {@link SubagentRequest} from validated tool input, omitting
 *  optional fields that were not supplied (preserves prior spread semantics).
 *  When `task_kind` is set AND `tools` is absent, derive a default allowlist
 *  from the kind — explicit `tools` always wins. `priorAttempt` /
 *  `checkpointPath` are resolved at the execute() layer and threaded in here
 *  as already-resolved values (the builder stays a pure function). */
const buildRequest = (
  input: AgentInput,
  childDepth: number,
  priorAttempt: string | undefined,
  checkpointPath: string | undefined,
): SubagentRequest => {
  const effectiveTools =
    input.tools ?? (input.task_kind !== undefined ? deriveToolFilter(input.task_kind) : undefined)
  const budget = buildBudget(input)
  return {
    prompt: input.prompt,
    depth: childDepth,
    ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
    ...(effectiveTools !== undefined ? { toolFilter: effectiveTools } : {}),
    ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
    ...(input.task_kind !== undefined ? { taskKind: input.task_kind } : {}),
    ...(input.result_shape !== undefined ? { resultShape: input.result_shape } : {}),
    ...(input.owned_surfaces !== undefined ? { ownedSurfaces: input.owned_surfaces } : {}),
    ...(input.forbidden_surfaces !== undefined
      ? { forbiddenSurfaces: input.forbidden_surfaces }
      : {}),
    ...(priorAttempt !== undefined ? { priorAttempt } : {}),
    ...(checkpointPath !== undefined ? { checkpointPath } : {}),
    ...(budget !== undefined ? { budget } : {}),
  }
}

/** Register a background task and fire the runner; returns the launch result.
 *  CRITICAL: the per-task `AbortController` returned by `registry.register`
 *  must be threaded into the runner request via `req.signal`. Without that
 *  wiring, `task_stop` → `registry.stop(id)` flips the status flag but the
 *  child loop keeps running. The request is rebuilt (not mutated) so the
 *  builder stays a pure function. `taskId` is minted at the execute() layer
 *  (before this call) so the checkpoint path can encode it pre-launch. */
const launchBackground = (
  opts: AgentToolOptions,
  registry: TaskRegistry,
  input: AgentInput,
  req: SubagentRequest,
  taskId: string,
): ToolEvent => {
  const { abort, ownerToken } = registry.register({
    id: taskId,
    description: input.prompt.slice(0, 120),
    ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
  })
  const signaledReq: SubagentRequest = { ...req, signal: abort.signal }
  // Fire and forget; the registry record settles when the runner returns.
  void opts
    .runner(signaledReq)
    .then((r) => registry.complete(taskId, r))
    .catch((e: unknown) => registry.fail(taskId, errMessage(e)))
  return {
    type: "result",
    result: {
      ok: true,
      // S17: surface the owner_token so the LLM can use it to cancel later.
      // Without this token, sibling subagents that learn `task_id` cannot
      // stop the task — the registry enforces the capability gate.
      output:
        `Subagent launched in background. task_id: ${taskId}\n` +
        `owner_token: ${ownerToken}\n` +
        `Poll with task_output({ task_id: "${taskId}" }) or cancel with task_stop({ task_id: "${taskId}", owner_token: "${ownerToken}" }).`,
    },
  }
}

/** Recoverable deny helper — yields a single `result` tool_event with `ok:false`
 *  and the given message. Keeps execute() linear and under the cog-complexity cap. */
const deny = (message: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output: message },
})

/** Mint the task id used to (a) name the checkpoint file pre-launch and
 *  (b) key the background registration. Foreground uses a synthetic
 *  `fg_<uuid>` id (no registry entry; deterministic-per-request); background
 *  uses the registry's own `newId()` so the same id is later observed by
 *  task_output / task_stop. */
const mintTaskId = (registry: TaskRegistry, isBackground: boolean): string =>
  isBackground ? registry.newId() : `fg_${crypto.randomUUID()}`

/** Pre-flight validation that may produce a recoverable denial. Returns either
 *  a {@link ToolEvent} (the deny — execute() yields it and returns) OR the
 *  resolved `priorAttempt` text the caller threads into the request. Keeps the
 *  `execute()` generator linear and under the cog-complexity cap. */
type Preflight =
  | { kind: "deny"; event: ToolEvent }
  | { kind: "ok"; priorAttempt: string | undefined }

const preflight = (input: AgentInput, registry: TaskRegistry): Preflight => {
  if (input.continue_from !== undefined) {
    const prior = resolvePriorAttempt(registry, input.continue_from)
    if (prior === undefined) {
      return {
        kind: "deny",
        event: deny(
          `Cannot continue from ${input.continue_from}: unknown or no retained finalText (LRU may have evicted).`,
        ),
      }
    }
    return { kind: "ok", priorAttempt: prior }
  }
  if (input.checkpoint === true && input.isolation === "worktree") {
    return {
      kind: "deny",
      event: deny(
        'Checkpoint is incompatible with isolation:"worktree" — parent cannot read inside a throwaway worktree. Use isolation:"none" (default) for checkpoint.',
      ),
    }
  }
  return { kind: "ok", priorAttempt: undefined }
}

/** Mint task id + checkpoint path together when at least one is needed.
 *  Foreground without checkpoint ⇒ no id minted (taskId === ""), no path.
 *  Returns the pair so the caller can pass `taskId` into launchBackground
 *  AND inject `checkpointPath` into the request — both share one id. */
const resolveTaskInfo = (
  input: AgentInput,
  ctx: ToolContext,
  registry: TaskRegistry,
): { taskId: string; checkpointPath: string | undefined } => {
  const isBackground = input.background === true
  const wantsCheckpoint = input.checkpoint === true
  if (!wantsCheckpoint && !isBackground) return { taskId: "", checkpointPath: undefined }
  const taskId = mintTaskId(registry, isBackground)
  const checkpointPath = wantsCheckpoint ? buildCheckpointPath(ctx.cwd, taskId) : undefined
  return { taskId, checkpointPath }
}

/**
 * The `agent` tool. Foreground ⇒ await the injected runner and return its
 * summary as the tool result. Background ⇒ register the task in the in-memory
 * {@link TaskRegistry} and return a task id immediately; the forked runner
 * resolves it asynchronously. Depth past `maxDepth` is denied.
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
      "Launch a subagent to autonomously handle a delegated task. " +
      "Foreground returns the subagent's summary; set background:true to get a " +
      "task id and poll with task_output / cancel with task_stop. " +
      "Pass continue_from to warm-start from a prior task's findings; pass checkpoint:true " +
      "(non-isolation only) to enable interim progress at .subagent-state/<task_id>.md.",
    inputSchema: agentSchema,
    // S2 fix: the previous `() => true` was a LIE — `agent` spawns a child
    // run that owns its OWN unrestricted tool set (write/edit/bash/git/…).
    // Treating the spawn as read-only let `inferToolTier` route it to "none"
    // and silently bypassed plan-mode dispatch guards. The mutating effect
    // is the child's reachable side-effect surface; classify accordingly.
    isReadOnly: () => false,
    // ADR-0298: concurrency-SAFE w.r.t. the parent loop. Each spawn returns
    // immediately (foreground awaits a runner that owns its own conversation
    // envelope; background hands back a task id) and shares NO mutable state
    // with sibling spawns from the SAME parent:
    //   - Each child has its own registry record + AbortController (the
    //     parent's per-task `register()` mints a fresh one every call).
    //   - Each child runs its own agent loop with its own working memory.
    //   - Side effects happen inside the CHILD's dispatch — serialized within
    //     that child's loop, not in the parent's dispatch seam.
    //   - `inferToolTier` permission gates still run per call before dispatch.
    // The previous `() => false` over-conservatively forced a head-of-line
    // barrier whenever the model wanted to fan out 3-5 read-only explorers in
    // one turn (a Cursor/Claude Code pattern: `is_parallel_worker:true`).
    // Streaming-dispatch (`src/agent/streaming-dispatch.ts`) reads this and
    // schedules sibling `agent` calls in flight (Phase 1 overlap), then
    // collects their results in model-call order in Phase 4.
    isConcurrencySafe: () => true,
    registry,

    async *execute(input: AgentInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const childDepth = ctxDepth(ctx) + 1

      if (childDepth > maxDepth) {
        yield deny(`Subagent denied: recursion depth ${childDepth} exceeds maxDepth ${maxDepth}.`)
        return
      }

      // continue_from registry lookup + checkpoint/worktree incompatibility.
      // Either resolves to a deny (returned here) or to the priorAttempt text
      // the runner's seed-augmentation step (parallel agent F) merges.
      const pre = preflight(input, registry)
      if (pre.kind === "deny") {
        yield pre.event
        return
      }

      // Mint the task id ONCE so the SAME id keys (a) the background registry
      // entry AND (b) the checkpoint file path the child writes to.
      const { taskId, checkpointPath } = resolveTaskInfo(input, ctx, registry)
      const req = buildRequest(input, childDepth, pre.priorAttempt, checkpointPath)

      if (input.background === true) {
        yield launchBackground(opts, registry, input, req, taskId)
        return
      }

      yield { type: "progress", message: `Delegating to subagent (depth ${childDepth})…` }
      try {
        const r = await opts.runner(req)
        yield { type: "result", result: { ok: r.ok, output: summarize(r) } }
      } catch (e: unknown) {
        yield deny(`Subagent error: ${errMessage(e)}`)
      }
    },
  }

  return tool
}

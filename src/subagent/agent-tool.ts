import { z } from "zod"
import { errMessage, runtimeConfig } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { withDelegationPolicy } from "@/shared/delegation-policy"
import { validateAgentType } from "./agent-type"
import { TaskRegistry } from "./registry"
import type { SubagentRequest, SubagentResult, SubagentRunner, TaskBudget, TaskKind } from "./types"

/** Last-resort recursion ceiling for the `agent` tool's depth pre-check —
 *  NEVER hit in practice: the `@/agent` caller (`tier1/subagent.ts`) resolves
 *  the effective cap (`config.subagent?.maxDepth ?? spawnDepthCap()`, the SAME
 *  value the capability gate and the runner reject use) and threads it in as
 *  `opts.maxDepth`, so this literal only exists to honor the slice fence
 *  (`@/subagent` may not import `@/agent/spawn-depth`) for a direct
 *  `@/subagent` caller that omits `maxDepth`. FIX-A, jul-13 nesting-control. */
const DEFAULT_MAX_DEPTH = 3

/** Exported for the C5059-04 trio↔6-tool `fork_turns` accept-set parity guard
 *  (`SpawnAgentInputSchema` must accept/reject the SAME values as this). */
export const agentSchema = z.object({
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
    .describe(
      '"worktree" runs the subagent in an isolated git worktree (own write scope). ' +
        "REQUIRES the workspace to be a git repo — otherwise it falls back to no isolation " +
        "(shares the parent cwd).",
    ),
  fork_turns: z
    .union([z.literal("none"), z.literal("all"), z.number().int().min(0)])
    .optional()
    .describe(
      "Inherit the parent's recent conversation: 'none' (cold start, default), " +
        "'all', or N (the last N turns). The inherited transcript is REDACTED and " +
        "framed as data; use it so the child starts with context instead of cold.",
    ),
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
    .describe(
      "Files/paths the child should confine its reads/edits to. ADVISORY: injected " +
        "into the child's seed as guidance — NOT enforced by the tool layer. Pair with " +
        "isolation:'worktree' for a hard (filesystem) write boundary.",
    ),
  forbidden_surfaces: z
    .array(z.string())
    .optional()
    .describe(
      "Files/paths the child should avoid. ADVISORY (seed guidance, NOT system-enforced) — " +
        "pairs with owned_surfaces; use isolation:'worktree' for hard isolation.",
    ),
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
  // ADR-0451 — Cursor `SubagentModelOverride`. Let the parent assign a specific
  // model / dispatch-role / effort tier to THIS child. All three are optional
  // and default-OFF: absent ⇒ the child runs on the parent's exact LLM port and
  // effort (byte-identical). The agent-side runner resolves precedence
  // explicit `model` > `role` (via roleModelResolver) > parent model, swaps the
  // child's LLM port via the parent's `modelCandidates` (id→port), and FAILS
  // CLOSED on an unknown model id. `effort` caps the child's thinking budget via
  // the same sessionEffort seam the loop uses.
  model: z
    .string()
    .optional()
    .describe(
      "Run the subagent on this specific model id (must be an enabled candidate). " +
        "Highest precedence; unknown id fails the spawn. Omit to inherit the parent's model.",
    ),
  role: z
    .string()
    .optional()
    .describe(
      "Dispatch role (e.g. 'plan-writer', 'executor', 'reviewer', 'explorer') used to " +
        "resolve a per-role model when `model` is not set. Omit to inherit the parent's model.",
    ),
  effort: z
    .enum(["default", "low", "medium", "high", "max"])
    .optional()
    .describe(
      "Effort tier capping the child's thinking budget. Omit to inherit the parent's effort.",
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
export const deriveToolFilter = (kind: TaskKind): string[] => {
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
  /** Optional per-session cap on concurrently RUNNING background launches that
   *  share this registry. Applies ONLY to `background:true`; foreground
   *  `agent` calls remain unchanged. Absent ⇒ unlimited (byte-identical). */
  maxConcurrent?: number
  /** GAP8a fork_turns — compose the child prompt with an inherited (redacted)
   *  parent-transcript preamble for the requested fork spec. Injected by the
   *  composition root (`@/agent` tier1, which owns the transcript + redactor) so
   *  this slice stays plane-clean (no upward `@/agent` import). ABSENT ⇒ the
   *  prompt is used as-is (byte-identical cold start). */
  forkPrompt?: (prompt: string, spec: "none" | "all" | number) => string
  /** §4.4 — TYPED agent kind enforcement. When true (the composition root read
   *  `QUANTA_SUBAGENT_TYPED_KIND` and wired it on), the spawn boundary VALIDATES
   *  `agent_type` via {@link validateAgentType}: a well-known {@link SubagentType}
   *  is normalised to its canonical spelling, a registered custom name (see
   *  {@link knownAgentTypes}) is accepted, and an unknown type is REJECTED (CC
   *  `subagent_type_miss`). ABSENT/false ⇒ the legacy free-string path
   *  (byte-identical: `agent_type` flows untouched, never rejected). The gate is
   *  read OUTSIDE the slice so the slice stays pure (no `process.env`). */
  enforceTypedAgentKind?: boolean
  /** §4.4 — provider for the registered CUSTOM agent-type names (the named-agent
   *  registry's keys), consulted ONLY when {@link enforceTypedAgentKind} is on.
   *  Injected by the composition root (the slice must not import `@/agent`'s
   *  named-agent registry). ABSENT ⇒ no custom names known ⇒ under enforcement a
   *  non-well-known type is a miss. */
  knownAgentTypes?: () => readonly string[]
}

type ToolDenyOr<T> = { kind: "deny"; event: ToolEvent } | { kind: "ok"; value: T }

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

/** T04 — stable per-agent lineage label. The dispatch seam surfaces a stable
 *  `ctx.agentLabel` per agent (ADR-0416); when absent the caller is the ROOT
 *  agent. We collapse "no label" onto a single sentinel so root-owned tasks
 *  form their own lineage that labeled children cannot read. */
export const ROOT_LINEAGE = "\x00root" as const
/** The calling agent's stable lineage label — the SSOT for BOTH stamping a spawned
 *  task's owner AND gating a later by-id read/mutation of that task (wait/output/
 *  send_input/list). `ctx.agentLabel` is system-minted (`config.mailboxAgentId`,
 *  ADR-0416), never sourced from tool input; absent ⇒ the root sentinel. Exported so
 *  the trio `task_output` gate uses the IDENTICAL derivation the owner stamp does. */
export const lineageOf = (ctx: ToolContext): string => ctx.agentLabel ?? ROOT_LINEAGE

/** Count currently-running background tasks in the shared registry. Only
 *  RUNNING entries consume the trio's background admission cap. */
const countRunning = (registry: TaskRegistry): number => registry.pendingIds().length

/**
 * T04 — `continue_from` ownership/lineage gate (the registry/API boundary).
 *
 * `continue_from` lets an agent warm-start from a PRIOR task's settled
 * findings. Without an ownership check, ANY agent that learns a task id could
 * read ANY settled subagent's finalText (cross-lineage disclosure, L2 H7/H3).
 *
 * This boundary requires the REQUESTING agent's lineage label to match the
 * label recorded when the task was launched (the `owners` ledger). Only on a
 * lineage match do we touch the registry record + read its finalText.
 *
 * Returns:
 *   - `{ kind: "ok", text }`        — owner match (or no ownership claim) +
 *                                     retained finalText.
 *   - `{ kind: "not_owner" }`       — task was LAUNCHED through this tool by a
 *                                     DIFFERENT lineage than the requester.
 *   - `{ kind: "missing" }`         — unknown id OR settled-without-finalText.
 *
 * Ownership semantics: a task LAUNCHED through this tool (background) is
 * stamped with its launching lineage in `owners`. Every subagent is launched
 * this way, so cross-subagent disclosure is gated. A task with NO ownership
 * claim (host-seeded directly into the registry, or trusted-internal) falls
 * back to the legacy registry read — the absence of a lineage stamp means we
 * cannot assert a foreign-lineage violation, and the legacy contract held no
 * isolation there. The `not_owner` arm never reads the record's text, so a
 * denied cross-lineage request leaks nothing. */
export type ContinueFromLoad =
  | { kind: "ok"; text: string }
  | { kind: "not_owner" }
  | { kind: "missing" }

const readRetainedFinalText = (registry: TaskRegistry, continueFrom: string): ContinueFromLoad => {
  const rec = registry.get(continueFrom)
  const text = rec?.result?.finalText
  return text && text.length > 0 ? { kind: "ok", text } : { kind: "missing" }
}

export const loadContinueFromForOwner = (
  registry: TaskRegistry,
  owners: ReadonlyMap<string, string>,
  continueFrom: string,
  requesterLineage: string,
): ContinueFromLoad => {
  const recordedOwner = owners.get(continueFrom)
  // No ownership claim ⇒ legacy path (host-seeded / trusted-internal task).
  if (recordedOwner === undefined) return readRetainedFinalText(registry, continueFrom)
  // A stamped task is readable ONLY by its launching lineage. Foreign lineage
  // is denied BEFORE any finalText read (no cross-lineage disclosure).
  if (recordedOwner !== requesterLineage) return { kind: "not_owner" }
  return readRetainedFinalText(registry, continueFrom)
}

/** Compute the checkpoint path the runner will inject. `<cwd>/.subagent-state/<taskId>.md`
 *  with the slice's cwd being the parent's (the runner is responsible for
 *  using the right cwd when isolation:worktree is rejected at this layer). */
export const buildCheckpointPath = (cwd: string, taskId: string): string => {
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
    // ADR-0451 — model / role / effort overrides. Each omitted when absent so
    // the no-override call path is byte-identical (the runner only swaps the
    // child's LLM port / effort when at least one of these is present).
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
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
  recordOwner: (taskId: string) => void,
): ToolEvent => {
  const { abort, ownerToken } = registry.register({
    id: taskId,
    description: input.prompt.slice(0, 120),
    ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
  })
  // T04 — record the launching lineage so a later `continue_from` from a
  // FOREIGN lineage is denied at the boundary BEFORE any finalText read.
  recordOwner(taskId)
  const signaledReq: SubagentRequest = { ...req, signal: abort.signal }
  // Fire and forget; the registry record settles when the runner returns.
  // Track the chain on the registry so session `cleanup` can DRAIN the actual
  // runner unwind — `forceStop` resolves the settler synchronously, so without
  // tracking the runner promise keeps running after teardown returns.
  registry.trackRunner(
    opts
      .runner(signaledReq)
      .then((r) => registry.complete(taskId, r))
      .catch((e: unknown) => registry.fail(taskId, errMessage(e))),
  )
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

const normalizeTypedAgentInput = (
  input: AgentInput,
  opts: Pick<AgentToolOptions, "enforceTypedAgentKind" | "knownAgentTypes">,
): ToolDenyOr<AgentInput> => {
  const typedKind = validateAgentType(input.agent_type, {
    ...(opts.enforceTypedAgentKind === true ? { enforce: true } : {}),
    ...(opts.knownAgentTypes !== undefined ? { knownCustom: opts.knownAgentTypes() } : {}),
  })
  if (!typedKind.ok) return { kind: "deny", event: deny(`Subagent denied: ${typedKind.reason}`) }
  if (typedKind.value === input.agent_type) return { kind: "ok", value: input }
  if (typedKind.value === undefined) {
    const { agent_type: _drop, ...rest } = input
    return { kind: "ok", value: rest as AgentInput }
  }
  return { kind: "ok", value: { ...input, agent_type: typedKind.value } }
}

const applyForkPromptIfNeeded = (
  input: AgentInput,
  forkPrompt: AgentToolOptions["forkPrompt"],
): AgentInput =>
  forkPrompt !== undefined
    ? { ...input, prompt: forkPrompt(input.prompt, input.fork_turns ?? "none") }
    : input

const checkBackgroundConcurrencyCap = (
  input: AgentInput,
  registry: TaskRegistry,
  maxConcurrent: number | undefined,
): ToolEvent | null => {
  if (input.background !== true || maxConcurrent === undefined) return null
  if (countRunning(registry) < maxConcurrent) return null
  return deny(`Subagent denied: ${maxConcurrent} concurrent subagents already running (cap reached).`)
}

interface PreparedAgentExecution {
  readonly childDepth: number
  readonly requesterLineage: string
  readonly input: AgentInput
  readonly req: SubagentRequest
  readonly taskId: string
}

const prepareAgentExecution = (
  input: AgentInput,
  ctx: ToolContext,
  registry: TaskRegistry,
  continueFromOwners: ReadonlyMap<string, string>,
  maxDepth: number,
  opts: AgentToolOptions,
): ToolDenyOr<PreparedAgentExecution> => {
  const childDepth = ctxDepth(ctx) + 1
  const requesterLineage = lineageOf(ctx)
  if (childDepth > maxDepth) {
    return {
      kind: "deny",
      event: deny(`Subagent denied: recursion depth ${childDepth} exceeds maxDepth ${maxDepth}.`),
    }
  }
  const normalized = normalizeTypedAgentInput(input, opts)
  if (normalized.kind === "deny") return normalized
  const normalizedInput = normalized.value
  const pre = preflight(normalizedInput, registry, continueFromOwners, requesterLineage)
  if (pre.kind === "deny") return pre
  const capDeny = checkBackgroundConcurrencyCap(normalizedInput, registry, opts.maxConcurrent)
  if (capDeny !== null) return { kind: "deny", event: capDeny }
  const { taskId, checkpointPath } = resolveTaskInfo(normalizedInput, ctx, registry)
  const forkedInput = applyForkPromptIfNeeded(normalizedInput, opts.forkPrompt)
  const req = buildRequest(forkedInput, childDepth, pre.priorAttempt, checkpointPath)
  return {
    kind: "ok",
    value: { childDepth, requesterLineage, input: normalizedInput, req, taskId },
  }
}

const runForegroundSubagent = async function* (
  runner: SubagentRunner,
  req: SubagentRequest,
  childDepth: number,
): AsyncIterable<ToolEvent> {
  yield { type: "progress", message: `Delegating to subagent (depth ${childDepth})…` }
  try {
    const r = await runner(req)
    yield { type: "result", result: { ok: r.ok, output: summarize(r) } }
  } catch (e: unknown) {
    yield deny(`Subagent error: ${errMessage(e)}`)
  }
}

const executeAgentTool = async function* (
  input: AgentInput,
  ctx: ToolContext,
  opts: AgentToolOptions,
  registry: TaskRegistry,
  continueFromOwners: Map<string, string>,
  maxDepth: number,
): AsyncIterable<ToolEvent> {
  const prepared = prepareAgentExecution(input, ctx, registry, continueFromOwners, maxDepth, opts)
  if (prepared.kind === "deny") {
    yield prepared.event
    return
  }
  const exec = prepared.value
  if (exec.input.background === true) {
    yield launchBackground(opts, registry, exec.input, exec.req, exec.taskId, (id) =>
      recordContinueFromOwner(registry, id, exec.requesterLineage),
    )
    return
  }
  yield* runForegroundSubagent(opts.runner, exec.req, exec.childDepth)
}

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

const preflight = (
  input: AgentInput,
  registry: TaskRegistry,
  owners: ReadonlyMap<string, string>,
  requesterLineage: string,
): Preflight => {
  if (input.continue_from !== undefined) {
    const loaded = loadContinueFromForOwner(registry, owners, input.continue_from, requesterLineage)
    if (loaded.kind === "not_owner") {
      return {
        kind: "deny",
        // Deliberately does NOT include the foreign task's output — only the
        // ownership verdict. No cross-lineage disclosure.
        event: deny(
          `Cannot continue from ${input.continue_from}: it belongs to a different agent lineage (ownership denied).`,
        ),
      }
    }
    if (loaded.kind === "missing") {
      return {
        kind: "deny",
        event: deny(
          `Cannot continue from ${input.continue_from}: unknown or no retained finalText (LRU may have evicted).`,
        ),
      }
    }
    return { kind: "ok", priorAttempt: loaded.text }
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
/** Audit R1 B-HIGH: the `continue_from` ownership ledger must travel with the
 *  TaskRegistry, NOT the tool instance. When two agent-tool instances share one
 *  injected registry, a task stamped by instance A must be visible to instance
 *  B's lineage check — otherwise B's lookup returns `undefined` (treated as the
 *  legacy trusted/host-seeded path) and reads A's settled `finalText` with no
 *  lineage proof. Keyed by registry identity (WeakMap ⇒ GC'd with the registry);
 *  a private, non-injected registry still gets its own fresh ledger. */
const continueFromOwnersByRegistry = new WeakMap<TaskRegistry, Map<string, string>>()
export const ownersForRegistry = (registry: TaskRegistry): Map<string, string> => {
  let ledger = continueFromOwnersByRegistry.get(registry)
  if (ledger === undefined) {
    ledger = new Map<string, string>()
    continueFromOwnersByRegistry.set(registry, ledger)
  }
  return ledger
}

/** Record a `continue_from` owner lineage, first PRUNING entries whose task the registry
 *  has already evicted — their `finalText` is gone, so the entry could only ever resolve to
 *  `missing` (the lineage gate never needs it again). This bounds the ledger to the
 *  registry's retained set instead of growing unbounded per background launch (jul-7 audit).
 *  A still-retained task (running OR settled-and-readable) is NEVER pruned, so the lineage
 *  proof for a live `continue_from` is preserved. */
export const recordContinueFromOwner = (
  registry: TaskRegistry,
  taskId: string,
  lineage: string,
): void => {
  const ledger = ownersForRegistry(registry)
  for (const key of ledger.keys()) {
    if (registry.get(key) === undefined) ledger.delete(key)
  }
  ledger.set(taskId, lineage)
}

/** Base (fan-out-mechanics) description of the trio `agent` tool, kept as a
 *  module const so {@link agentToolDescription} can project the C5059-05
 *  delegation policy onto it from ONE place (no duplicated string). */
const AGENT_TOOL_BASE_DESCRIPTION =
  "Launch a subagent to autonomously handle ONE delegated task. " +
  "Foreground returns the subagent's summary; set background:true to get a " +
  "task id and poll with task_output / cancel with task_stop. " +
  "Pass continue_from to warm-start from a prior task's findings; pass checkpoint:true " +
  "(non-isolation only) to enable interim progress at .subagent-state/<task_id>.md. " +
  "For running MANY children concurrently or steering a child mid-run use " +
  "spawn_agent / wait_agent / send_input instead; for the SAME task over a list " +
  "of inputs use spawn_batch."

/** Model-facing description of the `agent` tool. C5059-05: prepends the
 *  single-agent-first delegation policy when the opt-in knob is set (default-OFF
 *  ⇒ byte-identical). Reads the knob at construction time. */
export const agentToolDescription = (): string =>
  withDelegationPolicy(AGENT_TOOL_BASE_DESCRIPTION, runtimeConfig().subagentDelegateSuppress)

export const createAgentTool = (
  opts: AgentToolOptions,
): Tool<AgentInput> & { registry: TaskRegistry } => {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const registry = opts.registry ?? new TaskRegistry()
  // T04 + audit R1 B-HIGH — `continue_from` ownership ledger: taskId → launching
  // lineage label, keyed to the REGISTRY (shared across every tool instance that
  // shares the registry) so a foreign-lineage `continue_from` is denied by
  // `loadContinueFromForOwner` before any finalText read even when the registry
  // is injected/shared. The registry's own LRU governs record retention; a stale
  // owner entry for an evicted task simply resolves to `missing` (no finalText).
  const continueFromOwners = ownersForRegistry(registry)

  const tool: Tool<AgentInput> & { registry: TaskRegistry } = {
    name: "agent",
    description: agentToolDescription(),
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
    // ADR-0298 / T02 reconciliation — early-start (Phase 1 in-flight overlap)
    // eligibility. T02 (`streaming-dispatch.ts`) restricts early-start to
    // read-only tools so a refused turn can't have committed a mutating side
    // effect at the PARENT dispatch seam. `agent` is `isReadOnly:false` (the S2
    // fix above — the child owns an unrestricted tool set), so without this
    // opt-in T02 silently SERIALIZES sibling `agent` fan-out, defeating
    // ADR-0296/0298. The opt-in is sound: an agent spawn's effects do NOT land
    // at the parent seam — they happen INSIDE the child loop, behind the child's
    // own dispatch gates and its OWN AbortController, with the parent's
    // depth/budget guards already applied. So early-starting an `agent` call is
    // not a parent-seam mutation; the T02 guard that protects `session_config`/
    // `automation_update` is left untouched (they don't implement this method
    // and stay deferred).
    isEarlyDispatchSafe: () => true,
    registry,

    async *execute(input: AgentInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield* executeAgentTool(input, ctx, opts, registry, continueFromOwners, maxDepth)
    },
  }

  return tool
}

/**
 * Subagent slice — public seams.
 *
 * SLICE ISOLATION: this slice must NOT import `@/agent`. The recursive
 * agent-loop runner is *injected* as {@link SubagentRunner}. The main thread
 * satisfies the port later by forking `runAgent` (depth+1, filtered registry,
 * its own working memory). Nothing here knows about that implementation.
 */

/** Per-request token/turn ceiling threaded down into a forked agent loop. */
export interface TaskBudget {
  /** Max model turns the child loop may take. */
  maxTurns?: number
  /** Max tokens the child loop may consume (provider-counted). */
  maxTokens?: number
}

/** Codex-style coarse role classification for a subagent. The slice itself is
 *  agnostic; the agent-side runner uses it to derive a default tool allowlist
 *  when the caller did not pass an explicit one (`toolFilter`). A caller's
 *  explicit `toolFilter` ALWAYS wins — `taskKind` is a default, not an
 *  override. */
export type TaskKind = "read" | "edit" | "review"

export interface SubagentRequest {
  /** The task prompt handed to the child agent. */
  prompt: string
  /** Named subagent profile (e.g. "Explore", "Plan"). Absent ⇒ fork/general. */
  agentType?: string
  /** Tool-name allowlist the child registry is filtered to. Absent ⇒ inherit
   *  (or, when `taskKind` is set, a kind-derived default). Explicit value wins
   *  over any kind-derived default. */
  toolFilter?: string[]
  /** "worktree" ⇒ run the child in an isolated git worktree. */
  isolation?: "none" | "worktree"
  /** Recursion depth of this child (parent depth + 1). Root is 0. */
  depth: number
  /** RFC-04 §11 / ADR-0437 follow-up — the registry TASK ID this child is
   *  registered under (the id `followup_task`/`wait_agent`/`close_agent` use).
   *  When set AND the host wired a `TurnWakeRegistry`, the runner registers a
   *  per-child waker under THIS id so `followup_task(agentId)` can trigger the
   *  child's turn. Absent ⇒ no waker registered (the foreground/legacy spawn
   *  path that does not need followup-triggering; byte-identical). The slice
   *  does not mint this id — the spawn handler (which owns the registry) passes
   *  its `taskId` here. */
  taskId?: string
  /** Optional token/turn budget passthrough for the forked loop. */
  budget?: TaskBudget
  /** Per-request abort signal. The runner MUST chain this into the child
   *  loop's signal so an external cancellation (e.g. `task_stop` triggering
   *  the registry's per-task `AbortController`) actually unwinds the forked
   *  `runAgent`. Absent ⇒ only the parent loop's signal cancels the child
   *  (legacy / foreground call path). */
  signal?: AbortSignal
  /** Typed role classification (read / edit / review). When set AND
   *  `toolFilter` is absent the runner derives a sensible default allowlist
   *  from the kind. Always overridable by an explicit `toolFilter`. */
  taskKind?: TaskKind
  /** Codex `expected_output_shape`: a one-line spec the runner injects into
   *  the child's seed prompt so the child formats its final assistant turn in
   *  a shape the parent can parse without bespoke extraction. Free text;
   *  caller's responsibility to keep it tight. */
  resultShape?: string
  /** Codex `ownership_boundary` (owned half): explicit list of files/paths
   *  the child is permitted to read/modify. The runner injects this into the
   *  child seed so the child LLM self-checks before touching anything else
   *  (`worktree` provides physical isolation; this provides intent gating). */
  ownedSurfaces?: string[]
  /** Codex `ownership_boundary` (forbidden half): explicit no-go list. Pairs
   *  with `ownedSurfaces`; either side may be set independently. */
  forbiddenSurfaces?: string[]
  /** Codex `resume_agent` equivalent — RESOLVED summary of a prior attempt
   *  (typically `TaskRecord.result.finalText` looked up from the registry by
   *  the `agent` tool). The runner injects this as a "## Previous attempt"
   *  block at the top of the child seed so the child starts warm. The slice
   *  does NOT resolve registry lookups itself; the agent-tool boundary does
   *  that and passes the resolved text here. Absent ⇒ no prior-attempt
   *  injection (byte-identical for callers that don't opt in). */
  priorAttempt?: string
  /** Codex `checkpoint` equivalent — absolute path where the child should
   *  periodically write interim findings so the parent can monitor progress
   *  and recover work after a `task_stop`. The runner injects guidance text
   *  pointing at this path into the child seed. Caller (agent-tool) decides
   *  the path; convention: `<parent.cwd>/.subagent-state/<task_id>.md`.
   *  Incompatible with `isolation:"worktree"` (parent cannot read inside a
   *  throwaway worktree) — the agent-tool refuses that combination. Absent
   *  ⇒ no checkpoint guidance (byte-identical for callers that don't opt
   *  in). */
  checkpointPath?: string
  /** ADR-0451 (Cursor `SubagentModelOverride`) — EXPLICIT model id the child
   *  loop should run against. The agent-side runner resolves this by swapping
   *  the child's LLM port to the matching `AgentConfig.modelCandidates` entry
   *  (the SAME id→port mechanism the loop's skill-model-swap uses). Highest
   *  precedence: an explicit `model` beats a `role`-resolved model and the
   *  parent's model. FAIL-CLOSED — an id with no matching candidate aborts the
   *  spawn with a typed error (no silent fallback to the wrong model). The
   *  slice itself does NOT validate the id (it owns no model registry — slice
   *  isolation: `@/subagent` may only reach `@/tool`/`@/shared`); validation +
   *  swap happen agent-side. Absent ⇒ child = parent.llm (byte-identical). */
  model?: string
  /** ADR-0451 — dispatched ROLE the child should be assigned (Roo Code
   *  orchestrator per-role model axis, ADR-0256). The agent-side runner feeds
   *  this string to `AgentConfig.roleModelResolver.resolve(role, parentModel)`
   *  to derive the effective model id, then swaps the child's LLM port as for
   *  `model`. Lower precedence than an explicit `model`. A free string (the
   *  slice owns no `Role` enum — the resolver's port contract accepts arbitrary
   *  strings and falls through to the parent model for unknown roles). When the
   *  resolver yields a non-parent model id that is NOT a candidate, the spawn
   *  fails closed. Absent (or resolves to the parent model) ⇒ child =
   *  parent.llm (byte-identical). */
  role?: string
  /** ADR-0451 — EFFORT tier the child loop should run at. A named tier
   *  (`"default" | "low" | "medium" | "high" | "max"`) caps the child's
   *  thinking budget via the SAME `sessionEffort()` seam the parent loop reads
   *  per turn (`effortToTokenBudget`). The slice keeps the field a `string`
   *  (it owns no `EffortLevel` enum); the agent-side runner parses it and only
   *  a recognised named tier votes — an unrecognised string is ignored (defers
   *  to the parent's effort, mirroring `resolveEffort`'s numeric-advisory
   *  rule). Absent ⇒ child inherits the parent's effort (byte-identical). */
  effort?: string
  /** §20.1 (Claude/Cursor role-specialized system prompt) — EXPLICIT role
   *  system prompt the child loop should run with, REPLACING the inherited
   *  `parent.system`. `buildChildConfig` uses `req.system ?? parent.system`, so
   *  absent ⇒ the child inherits the parent's identity (byte-identical). The
   *  agent-side named-agent registry (§20.2) resolves a matching `agentType` to
   *  a definition and threads its body in here so a forked explorer/reviewer
   *  runs with its OWN role persona instead of the parent's. The slice itself
   *  never reads/loads this — it only carries the field. */
  system?: string
  /** §20.2 — prompt MODE the named-agent definition declared (one of the
   *  prompt-mode SSOT: `default|plan|review|audit|architect|editor`). The
   *  agent-side runner casts + applies it onto the child config's `mode` so a
   *  `mode: review` definition runs the child in the read-only-by-prompt
   *  posture. The slice keeps it a `string` (it owns no `AgentMode` enum). The
   *  registry only emits a value that already passed the SSOT membership check,
   *  so an unrecognised mode never reaches here. Absent ⇒ child inherits the
   *  parent's mode (byte-identical). */
  mode?: string
}

export interface SubagentResult {
  ok: boolean
  /** Final assistant text the child produced (the answer to summarize). */
  finalText: string
  /** Number of model turns the child took. */
  turns: number
  /** Optional raw transcript for callers that want the full trace. */
  messages?: unknown[]
}

/**
 * The injected port. The main thread provides the real implementation (a
 * forked `runAgent`). Everything in this slice depends only on this signature.
 */
export type SubagentRunner = (req: SubagentRequest) => Promise<SubagentResult>

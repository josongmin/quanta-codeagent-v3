/**
 * Tier-1 capability option blocks (ADR-0011) — extracted from
 * `src/agent/types.ts` so the per-capability nested option shapes have a
 * discoverable home and `AgentConfig` doesn't carry their literal forms
 * inline. Co-located with `memory-config.ts` / `compaction-config.ts` so the
 * 4 capability axes (subagent / skills / workingState / branchSearch) sit
 * next to the other extracted config groups.
 *
 * SHAPES MUST stay byte-identical to the previous inline declarations on
 * `AgentConfig`. The `FeaturesConfig` `Pick<>` re-exported from `./types`
 * resolves these typed slots — changing a field here is a CONTRACT CHANGE
 * (bump the surface, don't silently widen).
 *
 * Default-OFF posture (RFC §1.2):
 *   - `subagent` absent ⇒ Agent/Task/TaskOutput/TaskStop tools NOT registered,
 *     loop byte-identical.
 *   - `skills` absent ⇒ no skill discovery, Skill/ToolSearch tools NOT
 *     registered, loop byte-identical. `skills: {}` ⇒ bundled system skills
 *     only; `skills: { dir }` ⇒ user dir + system skills.
 *   - `workingState` absent ⇒ no working-state block rendered,
 *     `update_working_state` tool NOT registered, loop byte-identical.
 *   - `branchSearch` lives in `./branch-search` (already named) — NOT
 *     redefined here; AgentConfig still references that import directly.
 *     This file documents the capability cluster as a unit; the
 *     `BranchSearchConfig` re-export keeps a single source of truth.
 */

export type { BranchSearchConfig } from "../branch-search"

/**
 * Nested option shape for `AgentConfig.subagent` — Tier-1 subagent system
 * (ADR-0011). Absent ⇒ the `Agent` / `Task` / `TaskOutput` / `TaskStop` tools
 * are NOT registered and the loop is byte-identical. When present the loop
 * builds a `SubagentRunner` (forked `runAgent`, depth+1, filtered registry)
 * and registers the tools. `maxDepth` caps recursion (the `Agent` tool refuses
 * a spawn that would exceed it).
 */
export type SubagentBlock = {
  maxDepth?: number
  /** Optional surface-provided {@link TaskRegistry} injected into the three
   *  subagent tools (`agent`/`task_output`/`task_stop`). When set, the
   *  surface KEEPS the reference so it can observe live task counts (e.g.
   *  CLI lifecycle pills calling `registry.pendingIds().length`). When
   *  unset, `buildSubagentBlock` mints a fresh internal one — byte-identical
   *  to today (surface has no visibility, registry is loop-private).
   *  Read-only consumption: the surface NEVER calls `stop`/`forceStop` on
   *  the shared instance (host-side cleanup is owned by the loop's cleanup
   *  hook, ADR-0011). */
  taskRegistry?: import("../../subagent").TaskRegistry
  /** B1 — OPT-IN tool-namespacing strategy threaded into the child
   *  {@link createSubagentRunner}. When set, a forked child's filtered tool
   *  registry is rewritten so the model sees SCOPED tool names
   *  (e.g. `root_0__exec_command`) keyed back to the real tools — preventing
   *  collisions when concurrent siblings surface their tool sets to a shared
   *  consumer. Absent ⇒ RAW tool names (byte-identical to today). The host
   *  may pass the bundled `prefixToolNamespace` strategy or its own. */
  toolNamespace?: import("../subagent-runner").ToolNamespaceStrategy
  /** B2 — OPT-IN closed-port clamp on caller-supplied blocking timeouts. When
   *  set, this `{minMs,maxMs,defaultMs}` band is threaded into BOTH the
   *  `task_output(block:true)` tool (this block builds it directly) AND the
   *  `wait_agent` dispatch path (consumed by the 6-tool `Subagent6Deps` when
   *  {@link enable6Tools} is `true`). Absent ⇒ {@link
   *  import("../../subagent").DEFAULT_WAIT_TIMEOUT_POLICY} (30s default,
   *  generous 1h ceiling) — byte-identical to today. */
  waitTimeoutPolicy?: import("../../subagent").WaitTimeoutPolicy
  /** B3 — OPT-IN per-session cap on CONCURRENT running subagents, threaded into
   *  the 6-tool `spawn_agent` path (`Subagent6Deps.maxConcurrent`). The trio
   *  `agent` tool has no concurrent gauge of its own, so this knob is consumed
   *  by the 6-tool dispatch when {@link enable6Tools} is `true`. Absent ⇒
   *  UNLIMITED (byte-identical to today). */
  maxConcurrent?: number
  /** B3/B2 LIVE assembly opt-in (ADR-0041). Absent/`false` ⇒ ONLY the
   *  `agent` / `task_output` / `task_stop` trio is registered — byte-identical
   *  to today. `true` ⇒ the six-tool router (`exec_command` / `write_stdin` /
   *  `spawn_agent` / `wait_agent` / `close_agent` / `send_input`) is ALSO
   *  built (COEXIST — both share the one `TaskRegistry`) and the already-
   *  exposed `maxConcurrent` / `waitTimeoutPolicy` knobs become behavior-live
   *  through `spawn_agent` / `wait_agent`. The trio is never removed. */
  enable6Tools?: boolean
  /** RFC-02 / ADR-0436 — opt-in `spawn_batch` fan-out tool. Absent/`false` ⇒
   *  the tool is NOT registered (byte-identical). `true` ⇒ the tier1 adapter
   *  builds `spawn_batch` against the SAME injected runner the trio/6-tool use,
   *  with a self-contained worker pool (admission semaphore + per-item timeout
   *  race + partial-failure isolation). Requires `subagent` to be enabled
   *  (a runner must exist). */
  enableBatchSpawn?: boolean
  /** RFC-02 — explicit hard cap on the number of items a single `spawn_batch`
   *  call may fan out. Absent ⇒ {@link DEFAULT_MAX_BATCH_ITEMS} (256, aligned
   *  with the TaskRegistry settled-LRU). Injected constant, not an inlined
   *  heuristic. */
  maxBatchItems?: number
  /** RFC-04 / ADR-0437 — opt-in `list_agents` read-only enumeration tool.
   *  Absent/`false` ⇒ NOT registered (byte-identical). `true` ⇒ exposed on the
   *  6-tool builder (needs only the shared `TaskRegistry`; joins the
   *  `AgentMetaRegistry` side-table for depth/label when wired). */
  enableIntrospect?: boolean
  /** RFC-04 / ADR-0437 — opt-in `followup_task` deliver-and-trigger tool.
   *  Absent/`false` ⇒ NOT registered (byte-identical). `true` ⇒ exposed on the
   *  6-tool builder; requires `subagentMailbox` (delivery) + a `TurnWakeRegistry`
   *  (trigger). With no live waker the tool delivers the message and reports
   *  honest degradation (`cause:"no_waker"`). */
  enableFollowup?: boolean
  /** §25.1 — opt-in `run_workflow` tool (LLM-authored declarative multi-agent
   *  orchestration). Absent/`false` ⇒ NOT registered (byte-identical). `true` ⇒
   *  the tier-1 subagent block builds it against the SAME injected runner the
   *  trio/6-tool use (each workflow step is one subagent spawn). Requires
   *  `subagent` enabled (a runner must exist). Default-OFF (QUANTA_WORKFLOW). */
  enableWorkflow?: boolean
  /** GAP7-4 — `spawn_agents_on_csv` agent-callable batch fan-out. Absent/`false`
   *  ⇒ NOT registered (byte-identical). `true` ⇒ the tier-1 subagent block builds
   *  it against the SAME injected runner (one subagent per CSV row, bounded pool).
   *  Requires `subagent` enabled (a runner must exist). Default-OFF
   *  (QUANTA_SPAWN_AGENTS_CSV). */
  enableSpawnAgentsCsv?: boolean
}

/**
 * Nested option shape for `AgentConfig.skills` — Tier-1 skill system
 * (ADR-0011). Absent ⇒ no skill discovery and the `Skill`/`ToolSearch` tools
 * are NOT registered (loop byte-identical). When present, skills are
 * discovered + the `Skill` / `ToolSearch` tools are registered.
 *
 * `dir` (OPTIONAL — ADR-0045 follow-up): the user skills directory. When
 * OMITTED, only the BUNDLED system skills (`localize-fault`, `progress-audit`
 * — version-pinned, shipped with the framework) are discovered. This lets a
 * host enable the discipline skills WITHOUT remembering to point at a user
 * dir (the whole rationale of bundled skills). `skills: {}` ⇒ system skills
 * only; `skills: { dir }` ⇒ user dir + system skills (system wins on a name
 * collision so a user skill cannot weaken a bundled one).
 *
 * `changedPaths` (optional, conservative L1→L2 wiring): when set, the
 * per-turn active-skills inventory is pre-filtered via
 * `skillsActivatedFor(allSkills, changedPaths)` — a skill with `paths:` in
 * its frontmatter only appears in the inventory when one of those globs
 * matches a changed path. A skill WITHOUT `paths:` is always included
 * (unconditional). `changedPaths` UNSET ⇒ no filter, exact prior behavior
 * (byte-identical). Hosts compute this list however they want (git diff,
 * file watcher, manual hint).
 */
export type SkillsBlock = {
  dir?: string
  changedPaths?: string[]
}

/**
 * Nested option shape for `AgentConfig.workingState` — Tier-1 working-state
 * opt-in (Codex memory L3 absorption). Absent ⇒ no working-state block is
 * rendered, the `update_working_state` tool is NOT registered, and the loop
 * is byte-identical. When set, the loop builds a session-scoped
 * `WorkingState`, plumbs it through `ToolContext.workingState`, registers the
 * `update_working_state` meta-tool, and renders the L3 block in the per-turn
 * reminder (BELOW repo-rules, ABOVE memory hints).
 */
export type WorkingStateBlock = {
  enabled: boolean
}

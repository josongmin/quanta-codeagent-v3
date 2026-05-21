/**
 * Session-features builder (Tier 1 capability final wiring, ADR-0011).
 *
 * `buildSessionFeatures` is the single PURE materialization seam the loop calls
 * ONCE at session start to turn the optional `AgentConfig` Tier-1 blocks
 * (`subagent` / `skills` / `permission.mode === "auto"`) into concrete runtime
 * objects: extra tools to merge into the registry, a session-scoped stateful
 * auto-mode classifier, and the shared `TaskRegistry` the subagent tools were
 * wired against.
 *
 * BEHAVIOR-PRESERVING CONTRACT: every branch is gated on an optional config
 * field. With none of them set the result is `{ extraTools: [] }` and the loop
 * is byte-for-byte identical to today (no classifier, no extra tools, no task
 * registry). This module is pure except for `discoverSkills`'s directory IO.
 *
 * --- SEAMS THE MAIN THREAD MUST WRITE (NOT done here — out of scope) ---
 *
 * 1. Merging `extraTools` into the live registry. `ToolRegistry` is
 *    construct-only (constructor takes `Tool[]`; it exposes `has`/`get`/
 *    `isReadOnly`/`specs`/`isConcurrencySafe`/`run` but NO `add`/`register`).
 *    So the loop must REBUILD a fresh registry from the union. There is no
 *    public enumerator that returns the `Tool` objects, only `specs()` (names)
 *    + `get(name)`. Reuse the exact pattern `subagent-runner.ts#filterRegistry`
 *    already uses:
 *
 *      const existing = config.registry
 *        .specs()
 *        .map((s) => s.name)
 *        .map((n) => config.registry.get(n))
 *        .filter((t): t is NonNullable<typeof t> => t !== undefined)
 *      const merged = new ToolRegistry([...existing, ...features.extraTools])
 *
 *    `extraTools` is empty unless a Tier-1 block is configured, so when no
 *    block is set `merged` is structurally identical to the original registry
 *    and the loop stays byte-identical.
 *
 * 2. Threading `classifier` into the dispatch/permission path. The permission
 *    slice already consumes a `ClassifierPort` via `PermissionContext.classify`
 *    (see `src/permission/policy.ts#evaluateAuto`). The session classifier is
 *    the *stateful orchestrator* (`AutoModeClassifier`, holds denial-limit +
 *    circuit-break state across the whole session) that wraps that port. The
 *    loop should hold the returned `features.classifier` for the session and,
 *    in the permission-decision step for `mode === "auto"`, call
 *    `await classifier.evaluate({ tool, input, recentContext, systemPrompt })`
 *    instead of calling a one-shot port directly — so denial limits and the
 *    AFK circuit-breaker accumulate per session. When `features.classifier` is
 *    absent (mode !== "auto") the auto path is unreachable and behavior is
 *    unchanged.
 */

import { AutoModeClassifier } from "@/permission"
import { createUpdateWorkingStateTool, type Tool } from "@/tool"
import {
  createSkillTool,
  createToolSearchTool,
  discoverSkills,
  skillsActivatedFor,
  skillToolAllowlist,
} from "../skill"
import {
  createAgentTool,
  createTaskOutputTool,
  createTaskStopTool,
  type TaskRegistry,
} from "../subagent"
import { createAutoClassifierPort } from "./auto-classifier"
import { createSubagentRunner } from "./subagent-runner"
import type { AgentConfig } from "./types"
import { createWorkingStateSession, type WorkingStateSession } from "./working-state"

/** Materialized Tier-1 subsystems for one session. All fields are
 *  "absent ⇒ feature off"; the loop merges/threads them and otherwise behaves
 *  exactly as it does with no Tier-1 config. */
export interface SessionFeatures {
  /** Subagent (`agent`/`task_output`/`task_stop`) + skill (`Skill`/
   *  `ToolSearch`) tools to merge into the registry. Empty when no Tier-1
   *  tool-producing block is configured. */
  extraTools: Tool[]
  /** Session-scoped, STATEFUL auto-mode orchestrator (denial-limit +
   *  circuit-break state lives here for the whole session). Built only when
   *  `permission.mode === "auto"`; absent otherwise. */
  classifier?: AutoModeClassifier
  /** The SINGLE shared `TaskRegistry` the `agent` tool and the
   *  `task_output`/`task_stop` tools were all wired against. Present only when
   *  `config.subagent` is configured. The loop should retain this if it needs
   *  to observe/inspect background tasks. */
  taskRegistry?: TaskRegistry
  /** Graceful shutdown hook for the subagent block. Aborts all currently-
   *  running background tasks (via `TaskRegistry.stop`) and awaits their settle
   *  via `waitForSettle`. Present only when `config.subagent` is configured.
   *  Idempotent: calling twice is safe (second call sees `pendingIds() === []`
   *  and returns immediately). The loop should invoke this at session end
   *  before resolving the outcome. */
  cleanup?: () => Promise<void>
  /** Skill tool-scoping ENFORCEMENT data (ADR-0011): skill name →
   *  author-declared `tools:` allowlist, for skills that declared a non-empty
   *  one. The loop enforces this (a tool not in the active skill's allowlist
   *  is denied as a recoverable tool_result). Present only when ≥1 discovered
   *  skill declares `tools:`; absent ⇒ no scoping (byte-identical). */
  skillAllowlists?: Map<string, string[]>
  /** Active-skill inventory cached at session start (Codex `skills-audit.md`
   *  mirror). One `{name, description}` per discovered skill — used by the
   *  per-turn reminder to advertise the catalogue + trigger rules without
   *  re-discovering on every turn (Codex anti-reread). The skill BODY stays
   *  lazy (progressive disclosure); only metadata rides here. Present only
   *  when `config.skills` is set; absent ⇒ no block (byte-identical). */
  activeSkills?: { name: string; description: string }[]
  /** Session-scoped WorkingState (Codex memory L3 absorption). Present only
   *  when `config.workingState?.enabled === true`; absent ⇒ the
   *  `update_working_state` tool is NOT in `extraTools` and the loop renders
   *  no L3 block (byte-identical). The loop retains this to snapshot the
   *  current state into the per-turn reminder. */
  workingState?: WorkingStateSession
}

/**
 * Build the session's Tier-1 features from `config`. Called ONCE by the loop
 * at session start. Pure except for `discoverSkills` directory IO.
 *
 * - `config.subagent` ⇒ build a `SubagentRunner` (forked loop, depth+1,
 *   filtered registry), the `agent` tool against a fresh shared `TaskRegistry`,
 *   and the matching `task_output`/`task_stop` tools against the SAME registry
 *   instance (`createAgentTool` returns it as `.registry`). The returned
 *   `taskRegistry` is that exact instance. Also produces a `cleanup()` hook
 *   that aborts + awaits all currently-running background tasks; the loop MUST
 *   invoke this at session end for clean shutdown (NOTE: actual loop wiring is
 *   a follow-up — finalization in `loop.ts` has several paths that need
 *   careful integration, intentionally out of scope here).
 * - `config.skills` ⇒ `discoverSkills(dir)` (missing dir ⇒ `[]` per its
 *   contract) then register `Skill` + `ToolSearch`. The tools are registered
 *   UNCONDITIONALLY whenever `config.skills` is set — even with zero discovered
 *   skills — because (a) the loop's gate is purely `config.skills` presence so
 *   conditional registration would make the tool set depend on filesystem
 *   contents (surprising / non-deterministic for callers), and (b) `ToolSearch`
 *   ranks the live tool catalog and is useful with no skills at all. This
 *   mirrors the skill slice's documented recommended wiring.
 * - `config.permission.mode === "auto"` ⇒ a session `AutoModeClassifier`
 *   wrapping the LLM-backed `createAutoClassifierPort({ llm })`. Any other
 *   mode ⇒ no classifier.
 * - none of the above ⇒ `{ extraTools: [] }`.
 */
/** Discover skills + build the `Skill`/`ToolSearch` tools and the declared
 *  tool-allowlist map (ADR-0011). Extracted from
 *  {@link buildSessionFeatures} so that function stays under the cognitive-
 *  complexity budget; pure except `discoverSkills`'s directory IO. */
const buildSkillFeatures = async (
  config: AgentConfig,
  dir: string,
): Promise<{
  tools: Tool[]
  allowlists: Map<string, string[]> | undefined
  inventory: { name: string; description: string }[]
}> => {
  const skills = await discoverSkills(dir)
  const tools: Tool[] = [
    // `createSkillTool` ALWAYS receives the full discovered list — a user can
    // still invoke any skill by name. The `paths:` filter below only narrows
    // the per-turn SUGGESTION inventory, never the invocable surface (that
    // would silently strip authority).
    createSkillTool(skills),
    createToolSearchTool(() => config.registry.specs()),
  ]
  const al = new Map<string, string[]>()
  for (const s of skills) {
    const allow = skillToolAllowlist(s)
    if (allow) al.set(s.name, allow)
  }
  // Plain `{name, description}` shape so the prompt slice never imports
  // `@/skill` (slice isolation — Codex skills-audit mirror). Built ONCE here
  // (the loop calls buildSessionFeatures once at session start), then passed
  // through every turn without re-discovery.
  //
  // `paths:` conditional activation (L1→L2 host-driven wiring): when
  // `config.skills.changedPaths` is set, narrow the suggestion inventory to
  //   - every skill WITHOUT `paths:` (unconditional — always in the inventory),
  //   - plus every skill WITH `paths:` whose globs match any changed path
  //     (via `skillsActivatedFor` — the dedicated helper that already filters
  //     out unconditional skills).
  // `changedPaths` unset ⇒ identity, byte-identical with prior behavior —
  // RFC §1.2 default-OFF. The invocable surface (the `Skill` tool) is NEVER
  // narrowed — only the per-turn SUGGESTION inventory is filtered.
  const changedPaths = config.skills?.changedPaths
  const activated =
    changedPaths !== undefined && changedPaths.length > 0
      ? [
          ...skills.filter((s) => s.paths === undefined || s.paths.length === 0),
          ...skillsActivatedFor(skills, changedPaths),
        ]
      : skills
  const inventory = activated.map((s) => ({ name: s.name, description: s.description }))
  return { tools, allowlists: al.size > 0 ? al : undefined, inventory }
}

export const buildSessionFeatures = async (config: AgentConfig): Promise<SessionFeatures> => {
  const extraTools: Tool[] = []
  let taskRegistry: TaskRegistry | undefined
  let cleanup: (() => Promise<void>) | undefined
  let classifier: AutoModeClassifier | undefined
  let skillAllowlists: Map<string, string[]> | undefined
  let activeSkills: { name: string; description: string }[] | undefined
  let workingState: WorkingStateSession | undefined

  // --- Subagent block -----------------------------------------------------
  if (config.subagent) {
    const runner = createSubagentRunner(
      config,
      config.subagent.maxDepth !== undefined ? { maxDepth: config.subagent.maxDepth } : {},
    )

    // `createAgentTool` mints a fresh TaskRegistry when none is passed and
    // re-exposes whichever instance it used as `.registry`. We let it create
    // one and read `.registry` back, then wire the Task* tools against THAT
    // same instance so all three tools observe the same background tasks.
    const agentTool = createAgentTool({
      runner,
      ...(config.subagent.maxDepth !== undefined ? { maxDepth: config.subagent.maxDepth } : {}),
    })
    // Bind a NON-undefined local so the cleanup closure doesn't need a non-
    // null assertion on the outer `taskRegistry` (which is typed as optional
    // for callers that don't configure subagent).
    const reg = agentTool.registry
    taskRegistry = reg
    extraTools.push(agentTool, createTaskOutputTool(reg), createTaskStopTool(reg))
    cleanup = async (): Promise<void> => {
      const ids = reg.pendingIds()
      if (ids.length === 0) return
      // S17: host-side cleanup uses `forceStop` — not the token-gated `stop`.
      // The session owner has the authority to cancel ALL pending tasks at
      // shutdown regardless of who minted them; per-task owner tokens are
      // only the LLM-facing capability gate.
      for (const id of ids) reg.forceStop(id)
      // Await all settles in parallel. waitForSettle resolves immediately for
      // already-settled tasks, so this is bounded by the slowest in-flight
      // runner observing the abort and unwinding.
      await Promise.all(ids.map((id) => reg.waitForSettle(id)))
    }
  }

  // --- Skill block --------------------------------------------------------
  if (config.skills) {
    const sf = await buildSkillFeatures(config, config.skills.dir)
    extraTools.push(...sf.tools)
    skillAllowlists = sf.allowlists
    // Inventory is present whenever `config.skills` is set — even an empty
    // array (no SKILL.md files yet) — so the prompt slice can gate purely on
    // `length > 0` and stays byte-identical for skill-less sessions.
    activeSkills = sf.inventory
  }

  // --- Auto-mode classifier ----------------------------------------------
  if (config.permission.mode === "auto") {
    classifier = new AutoModeClassifier(createAutoClassifierPort({ llm: config.llm }))
  }

  // --- Working state (Codex memory L3) -----------------------------------
  // Build the session-scoped WorkingState handle + register the meta-tool that
  // mutates it. Absent ⇒ neither resource is allocated, the L3 block is not
  // rendered, and `update_working_state` is NOT in the registry — the loop is
  // byte-identical for all callers that do not opt in.
  if (config.workingState?.enabled === true) {
    workingState = createWorkingStateSession()
    extraTools.push(createUpdateWorkingStateTool(workingState) as Tool)
  }

  return {
    extraTools,
    ...(classifier ? { classifier } : {}),
    ...(taskRegistry ? { taskRegistry } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(skillAllowlists ? { skillAllowlists } : {}),
    ...(activeSkills ? { activeSkills } : {}),
    ...(workingState ? { workingState } : {}),
  }
}

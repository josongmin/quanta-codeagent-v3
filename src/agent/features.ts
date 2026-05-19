/**
 * Session-features builder (SOTA++ Tier-1 absorption final wiring, ADR-0011).
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
import type { Tool } from "@/tool"
import { createSkillTool, createToolSearchTool, discoverSkills, skillToolAllowlist } from "../skill"
import {
  createAgentTool,
  createTaskOutputTool,
  createTaskStopTool,
  type TaskRegistry,
} from "../subagent"
import { createAutoClassifierPort } from "./auto-classifier"
import { createSubagentRunner } from "./subagent-runner"
import type { AgentConfig } from "./types"

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
  /** SOTA++ skill tool-scoping ENFORCEMENT data (ADR-0011): skill name →
   *  author-declared `tools:` allowlist, for skills that declared a non-empty
   *  one. The loop enforces this (a tool not in the active skill's allowlist
   *  is denied as a recoverable tool_result). Present only when ≥1 discovered
   *  skill declares `tools:`; absent ⇒ no scoping (byte-identical). */
  skillAllowlists?: Map<string, string[]>
}

/**
 * Build the session's Tier-1 features from `config`. Called ONCE by the loop
 * at session start. Pure except for `discoverSkills` directory IO.
 *
 * - `config.subagent` ⇒ build a `SubagentRunner` (forked loop, depth+1,
 *   filtered registry), the `agent` tool against a fresh shared `TaskRegistry`,
 *   and the matching `task_output`/`task_stop` tools against the SAME registry
 *   instance (`createAgentTool` returns it as `.registry`). The returned
 *   `taskRegistry` is that exact instance.
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
 *  tool-allowlist map (SOTA++ ADR-0011). Extracted from
 *  {@link buildSessionFeatures} so that function stays under the cognitive-
 *  complexity budget; pure except `discoverSkills`'s directory IO. */
const buildSkillFeatures = async (
  config: AgentConfig,
  dir: string,
): Promise<{ tools: Tool[]; allowlists: Map<string, string[]> | undefined }> => {
  const skills = await discoverSkills(dir)
  const tools: Tool[] = [
    createSkillTool(skills),
    createToolSearchTool(() => config.registry.specs()),
  ]
  const al = new Map<string, string[]>()
  for (const s of skills) {
    const allow = skillToolAllowlist(s)
    if (allow) al.set(s.name, allow)
  }
  return { tools, allowlists: al.size > 0 ? al : undefined }
}

export const buildSessionFeatures = async (config: AgentConfig): Promise<SessionFeatures> => {
  const extraTools: Tool[] = []
  let taskRegistry: TaskRegistry | undefined
  let classifier: AutoModeClassifier | undefined
  let skillAllowlists: Map<string, string[]> | undefined

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
    taskRegistry = agentTool.registry
    extraTools.push(agentTool, createTaskOutputTool(taskRegistry), createTaskStopTool(taskRegistry))
  }

  // --- Skill block --------------------------------------------------------
  if (config.skills) {
    const sf = await buildSkillFeatures(config, config.skills.dir)
    extraTools.push(...sf.tools)
    skillAllowlists = sf.allowlists
  }

  // --- Auto-mode classifier ----------------------------------------------
  if (config.permission.mode === "auto") {
    classifier = new AutoModeClassifier(createAutoClassifierPort({ llm: config.llm }))
  }

  return {
    extraTools,
    ...(classifier ? { classifier } : {}),
    ...(taskRegistry ? { taskRegistry } : {}),
    ...(skillAllowlists ? { skillAllowlists } : {}),
  }
}

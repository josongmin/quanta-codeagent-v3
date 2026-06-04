/**
 * Session-features composer (Tier 1 capability final wiring, ADR-0011).
 *
 * `buildSessionFeatures` is the single PURE materialization seam the loop
 * calls ONCE at session start. It turns the optional `AgentConfig` Tier-1
 * blocks (`subagent` / `branchSearch` / `skills` / `permission.mode === auto`
 * / `workingState` / `planExitPort` / `planStore` / `userInputPort`) into the
 * concrete runtime objects the loop consumes.
 *
 * Each block is materialized by a dedicated, per-subsystem builder in
 * `./tier1/*`. This module is now a thin composer: it calls each builder in
 * sequence and, when the builder returns a non-`undefined` result, threads it
 * into the accumulated `SessionFeatures`. Each builder owns its own
 * default-OFF contract (config block absent ⇒ returns `undefined` ⇒ composer
 * skips it), keeping the byte-identical guarantee that with NO Tier-1 config
 * the result is `{ extraTools: [] }` and the loop is identical to today.
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

import type { AutoModeClassifier } from "@/permission"
import type { Tool } from "@/tool"
import type { TaskRegistry } from "../subagent"
import type { SkillTurnOverride } from "./loop"
import {
  buildAdvisorBlock,
  buildBranchSearchBlock,
  buildBrowserBlock,
  buildBudgetBlock,
  buildCheckSecretsBlock,
  buildClassifierBlock,
  buildComposeAuthoringBlock,
  buildDelegateBlock,
  buildForkSessionBlock,
  buildObjectiveBlock,
  buildPlanExitBlock,
  buildPlanMutationBlock,
  buildPromptCacheBlock,
  buildPrShipBlock,
  buildShadowBlock,
  buildShadowVerifyBlock,
  buildSkillBlock,
  buildSubagentBatchBlock,
  buildSubagentBgBlock,
  buildSubagentBlock,
  buildSubagentIntrospectBlock,
  buildSubagentMailboxBlock,
  buildUserInputBlock,
  buildWebSearchBlock,
  buildWorkingStateBlock,
} from "./tier1"
import type { AgentConfig } from "./types"
import type { WorkingStateSession } from "./working-state"

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
  /** Browser session teardown (ADR-0427). Closes the lazily-spawned headless
   *  browser (kills the proc + removes the temp profile). Present only when
   *  `config.browser.port` is wired; absent ⇒ no browser tools (byte-identical).
   *  The loop invokes this at session end alongside {@link cleanup}. */
  browserDispose?: () => Promise<void>
  /** Skill tool-scoping ENFORCEMENT data (ADR-0011): skill name →
   *  author-declared tool allowlist. An explicit empty list means "deny all
   *  ordinary tools" while still allowing the meta-tools (`Skill`,
   *  `ToolSearch`). Present only when ≥1 discovered skill declares an
   *  allowlist; absent ⇒ no scoping (byte-identical). */
  skillAllowlists?: Map<string, string[]>
  /** Skill model/effort ENFORCEMENT data (ADR-0011 §6.2 → L4): skill name →
   *  author-declared `{model?, effort?}` override, for skills that declared at
   *  least one. The loop applies the ACTIVE skill's override to the next turn
   *  (swap the LLM port by id from `config.modelCandidates`; cap the thinking
   *  budget from the effort tier). Inheritance is skill > session > default.
   *  Present only when ≥1 discovered skill declares `model:`/`effort:`; absent
   *  ⇒ no override (byte-identical). */
  skillOverrides?: Map<string, SkillTurnOverride>
  /** Active-skill inventory cached at session start (Codex `skills-audit.md`
   *  mirror). One `{name, description}` per discovered skill — used by the
   *  per-turn reminder to advertise the catalogue + trigger rules without
   *  re-discovering on every turn (Codex anti-reread). The skill BODY stays
   *  lazy (progressive disclosure); only metadata rides here. Present only
   *  when `config.skills` is set; absent ⇒ no block (byte-identical). */
  activeSkills?: { name: string; description: string; rawDependencies?: unknown }[]
  /** Session-scoped WorkingState (Codex memory L3 absorption). Present only
   *  when `config.workingState?.enabled === true`; absent ⇒ the
   *  `update_working_state` tool is NOT in `extraTools` and the loop renders
   *  no L3 block (byte-identical). The loop retains this to snapshot the
   *  current state into the per-turn reminder. */
  workingState?: WorkingStateSession
}

/**
 * Build the session's Tier-1 features from `config`. Called ONCE by the loop
 * at session start. Pure except for `discoverSkills` directory IO inside the
 * skill builder.
 *
 * COMPOSER CONTRACT: each per-subsystem builder in `./tier1/*` returns either
 * its materialized block (when the relevant `config` field is set) OR
 * `undefined` (when the field is absent). The composer threads each returned
 * block into the accumulated `SessionFeatures` and skips the slot when the
 * builder returned `undefined`. None of the above ⇒ `{ extraTools: [] }`.
 */
export const buildSessionFeatures = async (config: AgentConfig): Promise<SessionFeatures> => {
  const extraTools: Tool[] = []

  // --- Subagent block -----------------------------------------------------
  const subagent = buildSubagentBlock(config)
  if (subagent !== undefined) extraTools.push(...subagent.extraTools)

  // --- Branch search block (ADR-0083) -------------------------------------
  const branchTool = buildBranchSearchBlock(config)
  if (branchTool !== undefined) extraTools.push(branchTool)

  // ADR-0119 — shadow store tools (default-OFF: empty array when shadowOdb absent)
  extraTools.push(...buildShadowBlock(config))

  // ADR-0201 — fork_session tool (default-OFF: empty array when fork absent)
  extraTools.push(...buildForkSessionBlock(config))

  // ADR-0400 — shadow_verify tool (default-OFF: empty when shadowVerify absent)
  extraTools.push(...buildShadowVerifyBlock(config))

  // ADR-0140 — background-subagent tools (default-OFF: empty when subagentBackground absent)
  extraTools.push(...buildSubagentBgBlock(config))

  // RFC-02 / ADR-0436 — spawn_batch fan-out tool
  // (default-OFF: empty unless config.subagent.enableBatchSpawn === true)
  extraTools.push(...buildSubagentBatchBlock(config))

  // RFC-04 / ADR-0437 — list_agents + followup_task introspection tools
  // (default-OFF: empty unless enableIntrospect/enableFollowup gates are set)
  extraTools.push(...buildSubagentIntrospectBlock(config))

  // ADR-0416 — subagent_send_message tool (default-OFF: empty when subagentMailbox absent)
  extraTools.push(...buildSubagentMailboxBlock(config))

  // ADR-0393 — synchronous delegate tool (default-OFF: empty when delegation absent)
  extraTools.push(...buildDelegateBlock(config))

  // ADR-0257 — advisor consult tool (default-OFF: empty when advisor slot absent)
  extraTools.push(...buildAdvisorBlock(config))

  // ADR-0016 (compose seam) — git_compose_commit / git_compose_pr authoring
  // tools (default-OFF: empty array when composeAuthoring slot absent).
  extraTools.push(...buildComposeAuthoringBlock(config))

  // ADR-0460 (PR-ship seam) — gh_pr_open (author + `gh pr create` in one step).
  // Reuses the SAME composeAuthoring.authorLLM slot but is a WRITE tool, so it
  // rides a SEPARATE builder from the sealed read-only compose block (write
  // safety is enforced by the permission layer + plan-mode dispatch gate).
  extraTools.push(...buildPrShipBlock(config))

  // ADR-0398 — objective_set / objective_update / objective_get tools
  // (default-OFF: empty array when objective port absent)
  extraTools.push(...buildObjectiveBlock(config))

  // ADR-0136 — budget_status tool (default-OFF: empty array when budgetLedger absent)
  extraTools.push(...buildBudgetBlock(config))

  // ADR-0412 — check_secrets LLM tool (default-OFF: env-gated on
  // QUANTA_SECRET_CHECK_TOOL=on; legacy callers byte-identical).
  extraTools.push(...buildCheckSecretsBlock(config.secretCheckToolEnabled))

  // ADR-0127 (Part 3) / ADR-0148 — web_search tool (default-OFF: empty when
  // `webSearch.provider` absent; concrete provider is operator-owned).
  extraTools.push(...buildWebSearchBlock(config))

  // ADR-0182 — prompt_cache_status tool (default-OFF: empty when no
  // `promptCacheObserver` is wired). The SAME observer instance is fed by the
  // loop's `emitUsage`, so the tool snapshots real per-session cache buckets.
  extraTools.push(...buildPromptCacheBlock(config))

  // --- Skill block (ADR-0011) ---------------------------------------------
  const skill = await buildSkillBlock(config)
  if (skill !== undefined) extraTools.push(...skill.tools)

  // --- Auto-mode classifier -----------------------------------------------
  const classifier = buildClassifierBlock(config)

  // --- Working state (Codex memory L3) -----------------------------------
  const ws = buildWorkingStateBlock(config)
  if (ws !== undefined) extraTools.push(ws.tool)

  // --- Plan-exit tool (ADR-0086) -----------------------------------------
  const planExitTool = buildPlanExitBlock(config)
  if (planExitTool !== undefined) extraTools.push(planExitTool)

  // --- Structured plan tools (ADR-0093 draft) ----------------------------
  const planMutationTools = buildPlanMutationBlock(config)
  if (planMutationTools !== undefined) extraTools.push(...planMutationTools)

  // --- User-input tool (ADR-0095 draft) ----------------------------------
  const userInputTool = buildUserInputBlock(config)
  if (userInputTool !== undefined) extraTools.push(userInputTool)

  // --- Browser automation tools (ADR-0427) -------------------------------
  // default-OFF: EMPTY unless `config.browser.port` is wired by the composition
  // root. The session-teardown `dispose` rides out via `browserDispose`.
  const browserBlock = buildBrowserBlock(config)
  extraTools.push(...browserBlock.tools)

  return {
    extraTools,
    ...optionalFeatureFields({
      classifier,
      taskRegistry: subagent?.taskRegistry,
      cleanup: subagent?.cleanup,
      browserDispose: browserBlock.tools.length > 0 ? browserBlock.dispose : undefined,
      skillAllowlists: skill?.allowlists,
      skillOverrides: skill?.overrides,
      // Inventory is present whenever `config.skills` is set — even an empty
      // array (no SKILL.md files yet) — so the prompt slice can gate purely
      // on `length > 0` and stays byte-identical for skill-less sessions.
      activeSkills: skill?.inventory,
      workingState: ws?.handle,
    }),
  }
}

/** Fold the optional, "absent ⇒ feature off" {@link SessionFeatures} fields
 *  into a partial that omits every `undefined` entry — preserving the prior
 *  `...(x ? { x } : {})` semantics for ALL fields in ONE place. Extracted so
 *  `buildSessionFeatures` carries no per-field conditional-spread branches
 *  (keeps it under the cognitive-complexity budget). */
const optionalFeatureFields = (
  f: {
    [K in keyof Omit<SessionFeatures, "extraTools">]: SessionFeatures[K] | undefined
  },
): Partial<SessionFeatures> => {
  const out: Partial<SessionFeatures> = {}
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

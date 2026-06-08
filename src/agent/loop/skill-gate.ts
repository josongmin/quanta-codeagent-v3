import type { LLMPort, ThinkingConfig } from "@/llm"
import { supportsAdaptiveThinking } from "@/llm"
import { runtimeConfig } from "@/shared"
import { effortToTokenBudget } from "../effort"
import { READ_ONLY_EXPLORATION } from "../exploration-ladder"
import { resolveAgentMode } from "../mode"
import type { SkillGate, SkillTurnOverride } from "../turn-context"
import type { AgentConfig } from "../types"

export const SKILL_META_TOOLS = new Set(["Skill", "ToolSearch"])

/** Canonicalize a tool name for scope matching. Skill `allowed-tools` are
 *  frequently authored Claude-style (`Read`, `Bash`, `Edit`) while quanta
 *  dispatches lowercase (`read`, `bash`, `edit`); matching them under an
 *  exact-string `Set.has` denied legitimately-permitted tools. Lowercasing
 *  both sides closes the common Read/Bash/Write/Edit/Grep/Glob gap. */
const normTool = (name: string): string => name.trim().toLowerCase()

/** ADR-0512 L2 — read-only exploration primitives the system prompt MANDATES
 *  (the `file_tree_summary → glob → ls → read` ladder + `grep`). Always in
 *  scope regardless of the active skill's allowlist: the harness must never
 *  deny a tool its OWN prompt tells the model to reach for first (that was the
 *  `✕ file_tree_summary skill-scoped` bug). Derived from the single source in
 *  `../exploration-ladder`; normalized to the lowercase dispatch names. A
 *  drift ratchet keeps this in lock-step with the prompt. */
const NAV_BASE_NORM: ReadonlySet<string> = new Set(READ_ONLY_EXPLORATION.map(normTool))

/** True when `name` is a tool that is in scope independent of any active skill:
 *  a skill-meta tool (`Skill`/`ToolSearch`, raw-name) or a nav-base exploration
 *  primitive (normalized). The single membership predicate that BOTH the
 *  dispatch gate (`allow`) and the send-time spec filter (`filterSpecsByScope`)
 *  share, so "visible set" and "dispatchable set" can never drift (ADR-0512
 *  invariant #2). */
export const isAlwaysInScope = (name: string): boolean =>
  SKILL_META_TOOLS.has(name) || NAV_BASE_NORM.has(normTool(name))

/** ADR-0512 L1 — the availability filter. Removes out-of-scope tools from the
 *  spec set sent to the model so it never SEES (and so never fumbles into) a
 *  tool the active skill forbids. REUSES `gate.allow` as the single membership
 *  predicate so the visible set and the dispatchable set can never drift
 *  (invariant #2). No gate, or no active skill (every tool allowed) ⇒ returns
 *  the SAME `specs` reference (byte-identical). The caller gates this on
 *  `runtimeConfig().skillScopeV2`; OFF ⇒ never invoked, all tools visible. */
export const filterSpecsByScope = <T extends { name: string }>(
  specs: T[],
  gate: SkillGate | undefined,
): T[] => {
  if (gate === undefined) return specs
  const filtered = specs.filter((s) => gate.allow(s.name))
  return filtered.length === specs.length ? specs : filtered
}

export const buildSkillGate = (
  allowlists: Map<string, string[]> | undefined,
  overrides: Map<string, SkillTurnOverride> | undefined,
): SkillGate | undefined => {
  const hasAllow = allowlists !== undefined && allowlists.size > 0
  const hasOverride = overrides !== undefined && overrides.size > 0
  if (!hasAllow && !hasOverride) return undefined
  let active: Set<string> | undefined
  let activeSkill: string | undefined
  let activeOverride: SkillTurnOverride | undefined
  return {
    allow: (name) => active === undefined || isAlwaysInScope(name) || active.has(normTool(name)),
    observe: (name, input, ok) => {
      if (name !== "Skill" || !ok) return
      const raw =
        typeof input === "object" && input !== null && "name" in input
          ? (input as { name: unknown }).name
          : undefined
      const skill = typeof raw === "string" ? raw.trim().replace(/^\//, "") : ""
      const allow = allowlists?.get(skill)
      // ONLY a NON-EMPTY allowlist scopes the agent. An empty `allowed-tools: []`
      // is a tool-less / briefing skill (e.g. "repo onboarding") — it adds
      // guidance, NOT a zero-tool jail. (Was `if (allow)`: `[]` is truthy, so it
      // set `active` to an EMPTY Set and every subsequent tool was denied.)
      if (allow !== undefined && allow.length > 0) {
        active = new Set(allow.map(normTool))
        activeSkill = skill
      }
      activeOverride = overrides?.get(skill)
    },
    activeOverride: () => activeOverride,
    activeSkillName: () => (active === undefined ? undefined : activeSkill),
    // Widen the armed scope (ADR-0512 escalation approve). No-op when nothing is
    // scoped — there is no set to widen, and `allow` already returns true.
    widenScope: (name) => {
      if (active !== undefined) active.add(normTool(name))
    },
  }
}

export type ResolvedTurnOverride = {
  llm: LLMPort
  budgetTokens?: number
  explicitOff: boolean
}

export const readStickyModelForMode = async (config: AgentConfig): Promise<string | undefined> => {
  if (config.stickyModelStore === undefined) return undefined
  return config.stickyModelStore.store.get({
    mode: resolveAgentMode(config.mode, config.planMode),
  })
}

/**
 * D4 (jun-7 naive-impl hardening) — the model id that will ACTUALLY process this
 * turn, accounting for a skill `model:` override or a per-mode sticky model.
 *
 * The compaction threshold MUST read THIS (not the base `config.llm`): when a
 * session swaps model mid-stream (sticky-model / skill override), `config.llm`
 * still names the BASE model, so deriving the context-window threshold from it
 * re-introduces the exact model-blind bug D4 fixed (e.g. base opus-200k + sticky
 * sonnet-1m compacts at 155k instead of 923k; the inverse overflows). Mirrors the
 * model pick in {@link resolveSkillTurnOverride} (`override.model ?? sticky ?? base`)
 * but returns only the id (the `configuredModel` normalization, inlined to avoid
 * a `./emit-helpers` import cycle). `"unknown"` when no model is configured ⇒
 * `resolveModelWindow` misses ⇒ the 120k legacy threshold (byte-identical).
 */
export const resolveActiveModelId = async (
  config: AgentConfig,
  override: SkillTurnOverride | undefined,
): Promise<string> => {
  const stickyModelId = await readStickyModelForMode(config)
  const id = override?.model ?? stickyModelId
  const port = id !== undefined ? config.modelCandidates?.find((c) => c.id === id)?.port : undefined
  const model = (port ?? config.llm).model
  return model !== undefined && model !== "" ? model : "unknown"
}

export const resolveSkillTurnOverride = (
  config: AgentConfig,
  override: SkillTurnOverride | undefined,
  stickyModelId?: string,
): ResolvedTurnOverride => {
  const resolvePort = (id: string | undefined): LLMPort | undefined =>
    id !== undefined ? config.modelCandidates?.find((c) => c.id === id)?.port : undefined
  const swapped =
    override?.model !== undefined ? resolvePort(override.model) : resolvePort(stickyModelId)
  const llm = swapped ?? config.llm
  const overrideEffort = override?.effort
  const skillHasEffortSignal = overrideEffort !== undefined
  const skillBudget = !skillHasEffortSignal
    ? undefined
    : typeof overrideEffort === "number"
      ? overrideEffort
      : effortToTokenBudget(overrideEffort)
  if (skillHasEffortSignal) {
    return skillBudget !== undefined && skillBudget > 0
      ? { llm, budgetTokens: skillBudget, explicitOff: false }
      : { llm, explicitOff: true }
  }
  const sessionLevel = config.sessionEffort?.()
  const sessionBudget = sessionLevel !== undefined ? effortToTokenBudget(sessionLevel) : undefined
  return sessionBudget !== undefined && sessionBudget > 0
    ? { llm, budgetTokens: sessionBudget, explicitOff: false }
    : { llm, explicitOff: false }
}

export const applyEffortClassifierFloor = (
  resolved: ResolvedTurnOverride,
  classifier: AgentConfig["effortClassifier"],
): { llm: LLMPort; thinking?: ThinkingConfig } => {
  if (resolved.explicitOff) return { llm: resolved.llm }
  const classifierLevel = classifier?.currentRecommendation().level
  const classifierBudget =
    classifierLevel !== undefined ? effortToTokenBudget(classifierLevel) : undefined
  const budgetTokens = Math.max(resolved.budgetTokens ?? 0, classifierBudget ?? 0)
  // The "should we think at all" signal is UNCHANGED (effort/classifier-derived).
  // Adaptive only changes the SHAPE — never whether thinking is requested.
  if (budgetTokens <= 0) return { llm: resolved.llm }
  // Knob ON + adaptive-capable family ⇒ self-paced adaptive (no budget_tokens,
  // repairs the Opus-4.8 manual-budget 400). Otherwise the manual budget arm
  // (knob OFF, OR an older/unknown model) — byte-identical to the pre-slice path.
  if (runtimeConfig().adaptiveThinking && supportsAdaptiveThinking(resolved.llm.model)) {
    return { llm: resolved.llm, thinking: { type: "adaptive" } }
  }
  return { llm: resolved.llm, thinking: { type: "enabled", budget_tokens: budgetTokens } }
}

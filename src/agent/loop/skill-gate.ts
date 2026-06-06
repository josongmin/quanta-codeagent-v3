import type { LLMPort } from "@/llm"
import { effortToTokenBudget } from "../effort"
import { resolveAgentMode } from "../mode"
import type { SkillGate, SkillTurnOverride } from "../turn-context"
import type { AgentConfig } from "../types"

export const SKILL_META_TOOLS = new Set(["Skill", "ToolSearch"])

export const buildSkillGate = (
  allowlists: Map<string, string[]> | undefined,
  overrides: Map<string, SkillTurnOverride> | undefined,
): SkillGate | undefined => {
  const hasAllow = allowlists !== undefined && allowlists.size > 0
  const hasOverride = overrides !== undefined && overrides.size > 0
  if (!hasAllow && !hasOverride) return undefined
  let active: Set<string> | undefined
  let activeOverride: SkillTurnOverride | undefined
  return {
    allow: (name) => active === undefined || SKILL_META_TOOLS.has(name) || active.has(name),
    observe: (name, input, ok) => {
      if (name !== "Skill" || !ok) return
      const raw =
        typeof input === "object" && input !== null && "name" in input
          ? (input as { name: unknown }).name
          : undefined
      const skill = typeof raw === "string" ? raw.trim().replace(/^\//, "") : ""
      const allow = allowlists?.get(skill)
      if (allow) active = new Set(allow)
      activeOverride = overrides?.get(skill)
    },
    activeOverride: () => activeOverride,
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
): { llm: LLMPort; thinking?: { type: "enabled"; budget_tokens: number } } => {
  if (resolved.explicitOff) return { llm: resolved.llm }
  const classifierLevel = classifier?.currentRecommendation().level
  const classifierBudget =
    classifierLevel !== undefined ? effortToTokenBudget(classifierLevel) : undefined
  const budgetTokens = Math.max(resolved.budgetTokens ?? 0, classifierBudget ?? 0)
  return budgetTokens > 0
    ? { llm: resolved.llm, thinking: { type: "enabled", budget_tokens: budgetTokens } }
    : { llm: resolved.llm }
}

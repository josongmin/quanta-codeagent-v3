import type { LLMPort, ThinkingConfig } from "@/llm"
import { supportsAdaptiveThinking } from "@/llm"
import { runtimeConfig } from "@/shared"
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

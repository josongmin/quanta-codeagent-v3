import type { PromptCacheRetention } from "./llm-route-types"

/** Single source of truth for the prompt-mode set. The {@link AgentPromptMode}
 *  union is DERIVED from this array, so any consumer that needs the runtime
 *  values (e.g. `/sticky-model` arg validation + tab-completion) reuses THIS
 *  list — there is no second hand-maintained copy that could silently drift
 *  from the union. */
export const AGENT_PROMPT_MODES = [
  "default",
  "plan",
  "review",
  "audit",
  "architect",
  "editor",
] as const
export type AgentPromptMode = (typeof AGENT_PROMPT_MODES)[number]

export type PromptSystemLayout = "single_block" | "four_section"
export type PromptBaseSystem = "default" | "caller_provided"
export type PromptHookContextMode = "none" | "before_user" | "after_system" | "both"
export type PromptSummaryPrefix = "none" | "conversation_summary" | "continuation_summary"
export type TurnPolicyToolChoiceKind = "auto" | "any" | "none" | "tool"

/** Prompt-shaping metadata resolved BEFORE the provider request opens. This is
 *  redaction-safe observability only: names/counts/booleans, never prompt text. */
export interface PromptPolicySnapshot {
  readonly mode: AgentPromptMode
  readonly baseSystem: PromptBaseSystem
  readonly systemLayout: PromptSystemLayout
  readonly repoRulesPresent: boolean
  readonly sessionCtxPresent: boolean
  readonly userAppendPresent: boolean
  readonly selectedGlobRuleNames: readonly string[]
  readonly activeSkillNames: readonly string[]
  readonly workingStatePresent: boolean
  readonly memoryContextPresent: boolean
  readonly contextChangeCount: number
  readonly mentionInjectionCount: number
  readonly hookContext: PromptHookContextMode
  readonly summaryPrefix: PromptSummaryPrefix
}

/** Effective request policy = prompt-shaping metadata plus per-request control
 *  knobs chosen at turn entry. */
export interface TurnPolicySnapshot extends PromptPolicySnapshot {
  readonly toolChoice: TurnPolicyToolChoiceKind
  readonly toolChoiceToolName?: string
  readonly promptCacheKeyPresent: boolean
  readonly promptCacheRetention?: PromptCacheRetention
}

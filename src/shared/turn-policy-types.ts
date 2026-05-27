import type { PromptCacheRetention } from "./llm-route-types"

export type AgentPromptMode = "default" | "plan" | "review" | "audit" | "architect" | "editor"

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

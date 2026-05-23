import { type AgentConfig, RetryingLLM } from "@/agent"
import type { LLMPort } from "@/llm"
import type { EnvLike, Provider } from "./llm"
import { buildLLMCore } from "./llm"

/**
 * Surface-agnostic compaction config assembly (ADR-0011 Tier 0 safety
 * hardening + dedicated summarizer model).
 *
 * - {@link buildCompactionBreakerConfigCore} resolves the circuit-breaker
 *   block from already-parsed knobs.
 * - {@link buildSummarizerLlmCore} builds a separate cheaper/faster LLMPort
 *   used ONLY for the compaction summary turn.
 *
 * Both are default-OFF: omit ⇒ no key in `AgentConfig` (byte-identical).
 */

export interface CompactionBreakerAssembleInput {
  /** Equivalent of `QUANTA_COMPACT_BREAKER === "off"`. */
  disabled?: boolean
  /** `QUANTA_COMPACT_BREAKER_REACTIVE_MAX` parsed → finite int. */
  reactiveMax?: number | undefined
  /** `QUANTA_COMPACT_BREAKER_PROACTIVE_MAX` parsed → finite int. */
  proactiveMax?: number | undefined
}

/** Resolve the compaction circuit-breaker config. The breaker is ON by default
 *  with safe caps and only trips on pathological compaction thrash, so omitting
 *  every field is the behavior-preserving default. */
export const buildCompactionBreakerConfigCore = (
  input: CompactionBreakerAssembleInput,
): AgentConfig["compactionBreaker"] | undefined => {
  const caps = {
    ...(input.reactiveMax !== undefined && Number.isFinite(input.reactiveMax)
      ? { maxConsecutiveReactive: input.reactiveMax }
      : {}),
    ...(input.proactiveMax !== undefined && Number.isFinite(input.proactiveMax)
      ? { maxNoProgressProactive: input.proactiveMax }
      : {}),
  }
  const block = {
    ...(input.disabled === true ? { disabled: true } : {}),
    ...(Object.keys(caps).length > 0 ? { caps } : {}),
  }
  return Object.keys(block).length > 0 ? block : undefined
}

export interface SummarizerLlmAssembleInput {
  /** Main provider (used as fallback when no compaction-specific provider). */
  mainProvider: Provider
  signal: AbortSignal
  /** `QUANTA_COMPACT_MODEL` value (trimmed). Empty/undefined ⇒ `undefined`
   *  return (`config.llm` is used → byte-identical). */
  model: string | undefined
  /** `QUANTA_COMPACT_PROVIDER` override; falls back to `mainProvider`. */
  provider?: Provider | undefined
  /** Env-record forwarded to the per-model `buildLLMCore` (same env contract
   *  as the main LLM). */
  env: EnvLike
}

/** ADR-0011: dedicated compaction summarizer model. Builds a cheaper/faster
 *  `LLMPort` (retry-wrapped, same as the main stack) used ONLY for the
 *  compaction summary turn. Unset model ⇒ `undefined` ⇒ `config.llm` is used. */
export const buildSummarizerLlmCore = (input: SummarizerLlmAssembleInput): LLMPort | undefined => {
  if (input.model === undefined || input.model.trim() === "") return undefined
  const provider = input.provider ?? input.mainProvider
  return new RetryingLLM({
    inner: buildLLMCore({ provider, model: input.model.trim(), env: input.env }),
    signal: input.signal,
  })
}

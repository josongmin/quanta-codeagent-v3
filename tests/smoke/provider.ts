import { AnthropicAdapter, type LLMPort, OpenAIAdapter } from "@/llm"

/**
 * Build the live provider adapter from env, using ONLY the public `@/llm` slice
 * (the smoke harness must not import `src/apps/cli` internals — ADR-0024 slice
 * isolation). Shared by `smoke:record` and the tier-1 live battery.
 *
 *   QUANTA_LLM_PROVIDER   openai (default) | anthropic
 *   QUANTA_SMOKE_MODEL    override the model id
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY   provider credential
 *
 * Throws a {@link MissingProviderKeyError} when the selected provider's key is
 * absent so callers can SKIP politely (tier-1 must never hard-fail a CI run
 * that lacks a key, mirroring the contract-tier convention).
 */
export class MissingProviderKeyError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} API key is not set (skipping live smoke)`)
    this.name = "MissingProviderKeyError"
  }
}

export interface BuiltProvider {
  llm: LLMPort
  provider: string
  model: string
}

export const buildLiveLLM = (): BuiltProvider => {
  const provider = (process.env.QUANTA_LLM_PROVIDER ?? "openai").toLowerCase()
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new MissingProviderKeyError("anthropic")
    const model = process.env.QUANTA_SMOKE_MODEL ?? "claude-sonnet-4-6"
    return { llm: new AnthropicAdapter({ apiKey, model }), provider, model }
  }
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new MissingProviderKeyError("openai")
  const model = process.env.QUANTA_SMOKE_MODEL ?? "gpt-4o"
  return {
    llm: new OpenAIAdapter({
      apiKey,
      model,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    }),
    provider: "openai",
    model,
  }
}

/** True iff the selected provider has a usable key — lets callers decide to
 *  skip before doing any setup work. */
export const hasProviderKey = (): boolean => {
  const provider = (process.env.QUANTA_LLM_PROVIDER ?? "openai").toLowerCase()
  return provider === "anthropic"
    ? Boolean(process.env.ANTHROPIC_API_KEY)
    : Boolean(process.env.OPENAI_API_KEY)
}

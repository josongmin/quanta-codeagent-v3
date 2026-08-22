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

export class InvalidProviderError extends Error {
  constructor(readonly raw: string) {
    super(
      `QUANTA_LLM_PROVIDER="${raw}" is not a known provider (expected: openai | anthropic). ` +
        "Set it explicitly or unset to use the openai default.",
    )
    this.name = "InvalidProviderError"
  }
}

export interface BuiltProvider {
  llm: LLMPort
  provider: SmokeProvider
  model: string
}

export type SmokeProvider = "openai" | "anthropic"

/** Resolve `QUANTA_LLM_PROVIDER` to the closed `SmokeProvider` union. Throws
 *  {@link InvalidProviderError} on any unknown value — closes the silent-typo
 *  footgun where `QUANTA_LLM_PROVIDER=open_ai` would route to OpenAI without a
 *  warning. Absent ⇒ "openai" (documented default). */
export const resolveProvider = (raw: string | undefined): SmokeProvider => {
  if (raw === undefined || raw === "") return "openai"
  const norm = raw.toLowerCase()
  if (norm === "openai" || norm === "anthropic") return norm
  throw new InvalidProviderError(raw)
}

export const buildLiveLLM = (): BuiltProvider => {
  const provider = resolveProvider(process.env.QUANTA_LLM_PROVIDER)
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new MissingProviderKeyError("anthropic")
    const model = process.env.QUANTA_SMOKE_MODEL ?? "claude-sonnet-4-6"
    return { llm: new AnthropicAdapter({ apiKey, model }), provider, model }
  }
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new MissingProviderKeyError("openai")
  const model = process.env.QUANTA_SMOKE_MODEL ?? "gpt-4o"
  const baseURL = process.env.OPENAI_BASE_URL?.trim()
  return {
    llm: new OpenAIAdapter({
      apiKey,
      model,
      ...(baseURL ? { baseURL } : {}),
    }),
    provider: "openai",
    model,
  }
}

/** True iff the selected provider has a usable key — lets callers decide to
 *  skip before doing any setup work. Propagates {@link InvalidProviderError}
 *  for typo'd env values so callers can fail loudly rather than silently
 *  routing to the default. */
export const hasProviderKey = (): boolean => {
  const provider = resolveProvider(process.env.QUANTA_LLM_PROVIDER)
  return provider === "anthropic"
    ? Boolean(process.env.ANTHROPIC_API_KEY)
    : Boolean(process.env.OPENAI_API_KEY)
}
